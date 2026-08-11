#!/usr/bin/env node
// Exponential ⇄ Claude Code / Codex SESSION AGENT.
//
// Runs on your own machine and lets you drive Claude Code or Codex sessions from the
// Exponential web app — like having the terminal in your browser. It:
//
//   1. registers with the app using its connector token,
//   2. long-polls `/agent/poll` for commands (start / prompt / interrupt / stop /
//      permission), and
//   3. runs each session through its provider SDK, streaming every message back
//      to `/agent/sessions/:id/events`.
//
// The app is the only thing it talks to, over plain outbound HTTPS, so it works
// from behind a firewall/NAT with no inbound ports. The connector token
// (AGENT_TOKEN) authenticates every request — treat it like a password.
//
// Auth for Claude itself is the Claude Code CLI's logged-in subscription (Pro/Max)
// on this machine. Sessions run subscription-only, never on API billing: we strip
// every API-credential env var and pin the login method to "claudeai" before the
// SDK spawns Claude Code (see `subscriptionOnlyOptions`). The current login — who
// you're signed in as and how tokens are paid for — is read back from the SDK and
// reported to the app for display (see `fetchClaudeStatus`). Codex sessions use
// the local Codex CLI login or CODEX_API_KEY via @openai/codex-sdk.
//
// Env (each also readable from the config file written by `setup`, below):
//   EXPONENTIAL_URL   Base URL of the app         (default https://amplifier.app)
//   AGENT_TOKEN       Connector token             (required — from the Sessions page)
//   AGENT_NAME        Name to register as         (default: this machine's hostname)

import { query } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import { homedir, hostname, platform } from "node:os";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSION = "1.0.0";

// --- Configuration -----------------------------------------------------------
//
// Env vars are the whole story when you run this by hand. Installed copies (brew,
// and especially `brew services`, whose launchd job inherits none of your shell)
// have nowhere to put them, so `setup` writes them to a file instead. Env still
// wins where both are set, so a one-off `AGENT_TOKEN=… exponential-agent` can
// point an installed agent at a different workspace without disturbing the file.

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "exponential-agent");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

// Where the agent points when nothing says otherwise. Working against a local app
// is the exception now that this ships to other people, so it costs one env var:
// EXPONENTIAL_URL=http://localhost:5001.
const PRODUCTION_URL = "https://amplifier.app";

function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    // A missing file is the normal case for env-var users; anything else (bad
    // JSON, unreadable) is worth saying out loud rather than silently ignoring.
    if (err?.code !== "ENOENT") console.error(`[exponential-agent] ignoring ${CONFIG_PATH}: ${err.message}`);
    return {};
  }
}

// `setup` is what the Homebrew one-liner runs after install: it stashes the URL
// and token so the agent — foreground or launchd — can find them later.
function runSetup(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].replace(/^--/, "").split(/=(.*)/s);
    if (!argv[i].startsWith("--")) continue;
    flags[name] = inline !== undefined ? inline : (argv[++i] ?? "");
  }
  const token = flags.token || process.env.AGENT_TOKEN || "";
  if (!token) {
    console.error("Usage: exponential-agent setup --url https://your-app.example --token <connector token>");
    console.error("Copy both from the app: Claude Code (sidebar) → your machine → Show token & setup.");
    process.exit(1);
  }
  const existing = readConfig();
  const config = {
    url: (flags.url || process.env.EXPONENTIAL_URL || existing.url || PRODUCTION_URL).replace(/\/+$/, ""),
    token,
    name: flags.name || process.env.AGENT_NAME || existing.name || hostname(),
  };
  // The token is a password. Create the directory and file closed (0700/0600)
  // rather than writing first and tightening after, so it is never briefly
  // world-readable on a shared machine.
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600); // writeFileSync's mode is ignored when the file already exists
  console.log(`Saved ${CONFIG_PATH} (machine “${config.name}” → ${config.url}).`);
  console.log("");
  console.log("Start it now:      exponential-agent");
  console.log("Or run at login:   brew services start exponential-agent");
  process.exit(0);
}

if (process.argv[2] === "setup") runSetup(process.argv.slice(3));

if (process.argv[2] === "--version" || process.argv[2] === "-v") {
  console.log(VERSION);
  process.exit(0);
}

if (process.argv[2] === "--help" || process.argv[2] === "-h") {
  console.log(`exponential-agent ${VERSION} — runs Claude Code / Codex sessions driven from the app.

  exponential-agent                    Connect and wait for sessions
  exponential-agent setup --url URL --token TOKEN [--name NAME]
                                       Save credentials to ${CONFIG_PATH}
  exponential-agent --version

Env (overrides the config file): EXPONENTIAL_URL, AGENT_TOKEN, AGENT_NAME`);
  process.exit(0);
}

const config = readConfig();
const EXPONENTIAL_URL = (process.env.EXPONENTIAL_URL || config.url || PRODUCTION_URL).replace(/\/+$/, "");
const AGENT_TOKEN = process.env.AGENT_TOKEN || config.token || "";
const AGENT_NAME = process.env.AGENT_NAME || config.name || hostname();

// A single tool result can be enormous (a big file read, a long test run). Cap
// what we ship to the transcript so one tool call can't post megabytes.
const MAX_TEXT = 8000;

// A start can hang before the SDK ever emits its `system/init` (a bad cwd, a stuck
// Claude Code subprocess, an auth wall). Without a bound the app sits in `pending`
// forever with no error. If init doesn't arrive within this window, fail the
// session so the app shows an error (and its server-side reconcile can retry).
const INIT_TIMEOUT_MS = 120000;

if (!AGENT_TOKEN) {
  console.error("[exponential-agent] AGENT_TOKEN is required — copy it from the app's Claude Code Sessions page (Add machine).");
  console.error(`[exponential-agent] Save it once with: exponential-agent setup --url ${EXPONENTIAL_URL} --token <token>`);
  process.exit(1);
}

// --- HTTP to the app ---------------------------------------------------------

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${EXPONENTIAL_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    console.error("[exponential-agent] Unauthorized — check AGENT_TOKEN matches a machine in the app.");
    process.exit(1);
  }
  return res;
}

// Every transcript event / status update posts through this outbound queue. A
// transient network blip (or the app restarting) must never lose a line or kill
// a running session, so a failed post stays queued and retries in order with
// backoff — the whole backlog flushes the moment the app is reachable again.
// The queue is bounded so a long outage can't grow memory without limit; under
// pressure we shed the oldest lines. post() returns immediately (the queue keeps
// call order), so callers never block on the network.
const MAX_OUTBOX = 2000;
// This is ONE queue shared by every session running on this machine, drained
// strictly in order — so an item stuck at the head blocks every later event and
// status update for every other session too, not just the one that produced it
// (STR-214). Retrying a 5xx is right for a real outage (the app restarting, a
// network blip), but if the app is up and this exact request keeps 500ing (a
// bug it failed to classify as a permanent 4xx), retrying forever wedges the
// whole machine with no way to recover short of restarting this process. Give
// up after MAX_ATTEMPTS and drop the item instead: ~30 attempts at this backoff
// is a little over 4 minutes, long enough to ride out a deploy or a blip, short
// enough to self-heal rather than hang indefinitely.
const MAX_ATTEMPTS = 30;
const outbox = [];
let flushing = false;

function post(path, body) {
  if (outbox.length >= MAX_OUTBOX) outbox.shift(); // shed oldest under a long outage
  outbox.push({ path, body, attempts: 0 });
  flushOutbox();
  return Promise.resolve();
}

async function flushOutbox() {
  if (flushing) return; // a single drainer owns the queue; others just enqueue
  flushing = true;
  while (outbox.length) {
    const item = outbox[0];
    try {
      const res = await api(item.path, { method: "POST", body: item.body });
      // A 4xx (bar the 401 api() already exits on) is a permanent client error —
      // retrying can't help, so log and drop it. 5xx / network errors are
      // transient: throw to fall into the retry-with-backoff path below.
      if (!res.ok && res.status < 500) {
        console.error(`[exponential-agent] POST ${item.path} dropped: HTTP ${res.status}`);
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      outbox.shift(); // delivered (or permanently rejected) — advance, order intact
    } catch (err) {
      item.attempts += 1;
      if (item.attempts >= MAX_ATTEMPTS) {
        // Given up: this one item can't be delivered, but the rest of the queue
        // (every other session's events/status on this machine) must not stay
        // wedged behind it forever.
        console.error(`[exponential-agent] POST ${item.path} giving up after ${item.attempts} attempts, dropping: ${err.message}`);
        outbox.shift();
        continue;
      }
      const backoff = Math.min(1000 * item.attempts, 10000);
      console.error(`[exponential-agent] POST ${item.path} failed (attempt ${item.attempts}), retrying in ${backoff}ms: ${err.message}`);
      await sleep(backoff); // leave the item at the head and loop to retry it
    }
  }
  flushing = false;
}

const sendEvents = (sessionId, events) => post(`/agent/sessions/${sessionId}/events`, { events });
const sendStatus = (sessionId, fields) => post(`/agent/sessions/${sessionId}/status`, fields);
const truncate = (s) => {
  const str = String(s ?? "");
  return str.length > MAX_TEXT ? `${str.slice(0, MAX_TEXT)}\n… (${str.length - MAX_TEXT} more chars truncated)` : str;
};

// --- Session runner ----------------------------------------------------------
// One live Claude Agent SDK query per session. Follow-up prompts are pushed into
// a queue the SDK consumes as an async generator, so the session stays alive
// between turns. `pendingPermissions` bridges the SDK's canUseTool callback to
// the Approve/Deny buttons in the browser.

const sessions = new Map(); // sessionId -> runner
let amplifierMcp = null;
let codexClient = null;

function makeInputQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  const gen = (async function* () {
    while (true) {
      if (items.length) { yield items.shift(); continue; }
      if (closed) return;
      await new Promise((r) => (wake = r));
    }
  })();
  return {
    generator: gen,
    push(text) {
      items.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
      if (wake) { const w = wake; wake = null; w(); }
    },
    close() {
      closed = true;
      if (wake) { const w = wake; wake = null; w(); }
    },
  };
}

function imageUrls(payload = {}) {
  if (!Array.isArray(payload.images)) return [];
  return payload.images.filter((url) => typeof url === "string" && url.length > 0);
}

function promptWithImages(prompt, payload = {}) {
  const urls = imageUrls(payload);
  const text = String(prompt ?? "");
  if (urls.length === 0) return text;
  const label = urls.length > 1 ? "Attached images" : "Attached image";
  return `${text}${text ? "\n\n" : ""}${label}:\n${urls.map((url) => `- ${url}`).join("\n")}`;
}

// Sessions must bill against the user's Claude Code subscription (Pro/Max), never
// an Anthropic API key or a third-party provider — this is a remote-control for a
// personal Claude Code, not a metered API console. Claude Code prefers, in order:
// cloud-provider creds, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, an OAuth token,
// then the logged-in subscription. Stripping the first four from the subprocess
// environment forces the subscription; `env` REPLACES the subprocess environment
// wholesale (it is not merged), so we spread process.env first to keep PATH/HOME.
const API_CREDENTIAL_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

// SDK options that force subscription-only auth, applied to every session (and to
// the status probe). Belt and suspenders: strip the API-credential env vars *and*
// pin `forceLoginMethod: "claudeai"`, which requires the Pro/Max login and blocks
// an apiKeyHelper/settings key from quietly switching billing back to the API.
function subscriptionOnlyOptions() {
  const env = { ...process.env };
  for (const key of API_CREDENTIAL_ENV_VARS) delete env[key];
  return { env, managedSettings: { forceLoginMethod: "claudeai" } };
}

function updateAmplifierMcp(mcp) {
  if (!mcp?.url || !mcp?.token) return;
  amplifierMcp = { name: mcp.name || "amplifier", url: mcp.url, token: mcp.token };
  codexClient = null;
}

function amplifierMcpUrl(provider) {
  if (!amplifierMcp) return null;
  const url = new URL(amplifierMcp.url);
  url.searchParams.set("agent_provider", provider);
  return url.toString();
}

function claudeMcpServers() {
  if (!amplifierMcp) return {};
  return {
    [amplifierMcp.name]: {
      type: "http",
      url: amplifierMcpUrl("claude"),
      headers: { Authorization: `Bearer ${amplifierMcp.token}` },
      alwaysLoad: true,
    },
  };
}

function codexMcpConfig() {
  if (!amplifierMcp) return {};
  return {
    mcp_servers: {
      [amplifierMcp.name]: {
        url: amplifierMcpUrl("codex"),
        bearer_token_env_var: "AMPLIFIER_MCP_TOKEN",
        // Same policy as makeCanUseTool() for Claude: Amplifier's own MCP
        // tools are how app-launched sessions report back to the issue, so
        // they must not block on an approval prompt the web UI cannot answer.
        default_tools_approval_mode: "approve",
      },
    },
  };
}

function codexEnv() {
  const env = { ...process.env };
  if (amplifierMcp) env.AMPLIFIER_MCP_TOKEN = amplifierMcp.token;
  return env;
}

function codexRunner() {
  codexClient ||= new Codex({
    env: codexEnv(),
    config: codexMcpConfig(),
  });
  return codexClient;
}

function startSession(cmd) {
  if ((cmd.payload?.provider || "claude") === "codex") return startCodexSession(cmd);
  return startClaudeSession(cmd);
}

function startClaudeSession(cmd) {
  const sessionId = cmd.session_id;
  if (sessions.has(sessionId)) return; // already running (a repeated start command)

  const p = cmd.payload || {};
  // A resume re-attaches to a prior SDK conversation (payload.resume is set); a
  // fresh start doesn't. A resume carrying NO follow-up prompt is special: the SDK
  // doesn't emit `system/init` until the first user turn, so we can neither confirm
  // the re-attach off init nor time it out like a fresh start. `awaitingReattach`
  // flags that case so drain reports the session idle-and-ready off its first
  // streamed message instead of hanging at "Resuming session…" (see drain and
  // armInitTimeout below).
  const isResume = !!p.resume;
  const hasPrompt = !!p.prompt;
  const input = makeInputQueue();
  const abort = new AbortController();
  const runner = { sessionId, input, abort, query: null, pendingPermissions: new Map(), stopped: false, inited: false, initTimer: null, awaitingReattach: isResume && !hasPrompt };
  sessions.set(sessionId, runner);

  if (hasPrompt) input.push(promptWithImages(p.prompt, p));

  const permissionMode = p.permission_mode || "default";
  const options = {
    ...subscriptionOnlyOptions(),
    cwd: p.cwd || process.cwd(),
    permissionMode,
    abortController: abort,
    mcpServers: claudeMcpServers(),
  };
  // Always wire canUseTool, even for bypassPermissions. In bypass the SDK
  // auto-approves before it's ever consulted (and warns, harmlessly, that it's
  // shadowed) — but the permission mode can be switched live via the
  // set_permission_mode command, and a switch *from* bypass *to* an ask-mode only
  // prompts if the callback was installed at start. Wiring it unconditionally is
  // what makes mid-session tightening actually take effect.
  options.canUseTool = makeCanUseTool(runner);
  if (p.model) options.model = p.model;
  if (p.effort) options.effort = p.effort; // reasoning depth per turn (low…max)
  if (p.resume) options.resume = p.resume; // continue a prior SDK session

  runner.query = query({ prompt: input.generator, options });
  // A prompt-less resume legitimately won't init until the user sends a follow-up
  // (it could sit idle-and-ready for hours), so don't arm the fresh-start init
  // timeout against it — drain confirms the re-attach off its first streamed
  // message. A fresh start (or a resume that carries a prompt) still gets the guard.
  if (!runner.awaitingReattach) armInitTimeout(runner);
  consume(runner).catch((err) => finishWithError(runner, err));
}

// Fail a session that never reaches `system/init` within INIT_TIMEOUT_MS — the
// drain loop disarms this the moment init lands. Without it a hung startup leaves
// the app stuck in `pending` with no signal: the runner is "alive" (in our map, so
// we keep reporting it live on polls), yet it never produced anything, so the app's
// reconcile can't tell it's wedged. Firing here surfaces a real error instead.
function armInitTimeout(runner) {
  runner.initTimer = setTimeout(() => {
    if (runner.inited || runner.stopped || runner.errored) return;
    finishWithError(runner, new Error("Session did not initialize within 120s — the machine may be unable to launch Claude Code here."));
    try { runner.abort.abort(); } catch {}
  }, INIT_TIMEOUT_MS);
  runner.initTimer.unref?.();
}

// Re-attach to a session that dropped when the connection — or this whole
// process — went away. Identical machinery to a fresh start, except we hand the
// SDK the prior conversation's id via `resume:` so it continues the exact
// session (its transcript is intact in the app). Any follow-up prompt buffered
// while we were gone rides in the payload and is delivered once the runner is up.
// If we survived only a brief blip and still hold the runner, this is a no-op.
function resumeSession(cmd) {
  if ((cmd.payload?.provider || "claude") === "codex") return resumeCodexSession(cmd);
  if (sessions.has(cmd.session_id)) return;
  const p = cmd.payload || {};
  startSession({ ...cmd, payload: { ...p, resume: p.sdk_session_id } });
}

function codexThreadOptions(payload = {}) {
  const mode = payload.permission_mode || "default";
  const options = {
    workingDirectory: payload.cwd || process.cwd(),
    skipGitRepoCheck: true,
    approvalPolicy: "never",
  };
  if (payload.model) options.model = payload.model;
  if (payload.effort) options.modelReasoningEffort = payload.effort === "max" ? "xhigh" : payload.effort;

  switch (mode) {
    case "plan":
      options.sandboxMode = "read-only";
      break;
    case "bypassPermissions":
      options.sandboxMode = "danger-full-access";
      break;
    case "acceptEdits":
    case "default":
    default:
      options.sandboxMode = "workspace-write";
      break;
  }
  return options;
}

function startCodexSession(cmd) {
  const sessionId = cmd.session_id;
  if (sessions.has(sessionId)) return;

  const p = cmd.payload || {};
  const codex = codexRunner();
  const thread = p.resume ? codex.resumeThread(p.resume, codexThreadOptions(p)) : codex.startThread(codexThreadOptions(p));
  const runner = {
    provider: "codex",
    sessionId,
    thread,
    optionsPayload: { ...p },
    pendingPrompts: [],
    active: false,
    stopped: false,
    interrupted: false,
    errored: false,
    turns: 0,
    abort: null,
  };
  sessions.set(sessionId, runner);

  if (p.prompt || imageUrls(p).length) {
    runner.pendingPrompts.push(promptWithImages(p.prompt, p));
    drainCodexPrompts(runner).catch((err) => finishWithError(runner, err));
  } else {
    sendStatus(sessionId, { status: "awaiting_input", sdk_session_id: thread.id || p.resume || null });
  }
}

function resumeCodexSession(cmd) {
  if (sessions.has(cmd.session_id)) return;
  const p = cmd.payload || {};
  startCodexSession({ ...cmd, payload: { ...p, resume: p.sdk_session_id } });
}

async function drainCodexPrompts(runner) {
  if (runner.active || runner.stopped) return;
  runner.active = true;
  while (runner.pendingPrompts.length && !runner.stopped) {
    const prompt = runner.pendingPrompts.shift();
    runner.abort = new AbortController();
    await sendStatus(runner.sessionId, { status: "running", sdk_session_id: runner.thread.id });
    try {
      const { events } = await runner.thread.runStreamed(prompt, { signal: runner.abort.signal });
      for await (const event of events) {
        await handleCodexEvent(runner, event);
        if (runner.stopped) break;
      }
    } catch (err) {
      if (runner.stopped) return;
      if (runner.interrupted || err?.name === "AbortError" || String(err?.message || "").match(/abort/i)) {
        runner.interrupted = false;
        await sendStatus(runner.sessionId, { status: "awaiting_input", num_turns: runner.turns });
        continue;
      }
      throw err;
    }
  }
  runner.active = false;
  runner.abort = null;
  if (!runner.errored && !runner.stopped) {
    await sendStatus(runner.sessionId, { status: "awaiting_input", sdk_session_id: runner.thread.id, num_turns: runner.turns });
  }
}

async function handleCodexEvent(runner, event) {
  const sessionId = runner.sessionId;
  switch (event.type) {
    case "thread.started":
      await sendStatus(sessionId, { sdk_session_id: event.thread_id, status: "running" });
      break;
    case "turn.started":
      await sendStatus(sessionId, { status: "running" });
      break;
    case "item.completed":
      await sendEvents(sessionId, codexItemEvents(event.item));
      break;
    case "turn.completed":
      runner.turns += 1;
      await sendEvents(sessionId, [{ kind: "result", text: "Done", payload: { subtype: "success", num_turns: runner.turns, usage: event.usage } }]);
      await sendStatus(sessionId, { status: "awaiting_input", num_turns: runner.turns });
      break;
    case "turn.failed":
      await finishWithError(runner, new Error(event.error?.message || "Codex turn failed."));
      break;
    case "error":
      await finishWithError(runner, new Error(event.message || "Codex stream error."));
      break;
  }
}

function codexItemEvents(item) {
  if (!item) return [];
  switch (item.type) {
    case "agent_message":
      return item.text ? [{ kind: "assistant", text: item.text }] : [];
    case "reasoning":
      return item.text ? [{ kind: "notice", text: `Reasoning: ${item.text}` }] : [];
    case "command_execution":
      return [
        { kind: "tool_use", payload: { name: "codex_command", input: { command: item.command }, tool_use_id: item.id } },
        { kind: "tool_result", text: truncate(item.aggregated_output || ""), payload: { tool_use_id: item.id, is_error: item.status === "failed" || item.exit_code > 0 } },
      ];
    case "mcp_tool_call":
      return [
        { kind: "tool_use", payload: { name: `mcp__${item.server}__${item.tool}`, input: item.arguments, tool_use_id: item.id } },
        { kind: "tool_result", text: truncate(codexMcpResultText(item)), payload: { tool_use_id: item.id, is_error: item.status === "failed" } },
      ];
    case "file_change":
      return [{ kind: "notice", text: `Files changed: ${item.changes.map((c) => `${c.kind} ${c.path}`).join(", ")}` }];
    case "web_search":
      return [
        { kind: "tool_use", payload: { name: "codex_web_search", input: { query: item.query }, tool_use_id: item.id } },
        { kind: "tool_result", text: "Search completed.", payload: { tool_use_id: item.id, is_error: false } },
      ];
    case "todo_list":
      return [{ kind: "notice", text: item.items.map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`).join("\n") }];
    case "error":
      return [{ kind: "error", text: item.message }];
    default:
      return [];
  }
}

function codexMcpResultText(item) {
  if (item.error?.message) return item.error.message;
  const content = item.result?.content;
  if (Array.isArray(content)) {
    return content.map((block) => block?.text || block?.data || JSON.stringify(block)).join("\n");
  }
  return item.result ? JSON.stringify(item.result) : "";
}

// Amplifier's own MCP tools drive the session (issue status, comments, plans) —
// prompting to approve the very tool that's managing the work is pure friction,
// so we always allow them. The `mcp__amplifier__` prefix is the SDK's structural
// name for that server, so this matches every tool it exposes, present or future.
const isAutoApproved = (toolName) => String(toolName).startsWith("mcp__amplifier__");

// Turn each tool-permission request into a transcript card the user answers, and
// block the SDK until they do. Only reached in modes that ask (default / plan);
// acceptEdits / bypassPermissions auto-approve without calling this. Amplifier
// MCP tools are auto-approved here too, so they never surface a prompt.
function makeCanUseTool(runner) {
  return (toolName, toolInput, { signal } = {}) => {
    if (isAutoApproved(toolName)) return Promise.resolve({ behavior: "allow", updatedInput: toolInput });
    return new Promise((resolve) => {
      const requestId = randomUUID();
      runner.pendingPermissions.set(requestId, (decision, message) => {
        runner.pendingPermissions.delete(requestId);
        if (decision === "allow") resolve({ behavior: "allow", updatedInput: toolInput });
        else resolve({ behavior: "deny", message: message || "Denied by the user." });
      });
      sendEvents(runner.sessionId, [
        { kind: "permission_request", payload: { request_id: requestId, tool_name: toolName, input: toolInput } },
      ]);
      sendStatus(runner.sessionId, { status: "awaiting_permission" });
      signal?.addEventListener("abort", () => {
        if (runner.pendingPermissions.delete(requestId)) resolve({ behavior: "deny", message: "Interrupted." });
      });
    });
  };
}

// Drain the SDK's message stream into transcript events + status updates.
async function consume(runner) {
  const { sessionId } = runner;
  try {
    await drain(runner);
  } catch (err) {
    // A `stop` aborts the in-flight turn, which surfaces here as an AbortError —
    // that's an intentional teardown, not a failure. Anything else is a real error.
    if (!runner.stopped) throw err;
  }

  clearTimeout(runner.initTimer);
  if (!runner.errored) await sendStatus(sessionId, { status: runner.stopped ? "stopped" : "completed" });
  sessions.delete(sessionId);
}

async function drain(runner) {
  const { sessionId } = runner;
  for await (const message of runner.query) {
    // First message on a prompt-less resume: the SDK emits no `system/init` until a
    // follow-up prompt arrives, so keying the re-attach off init (like a fresh
    // start) would hang the app at "Resuming session…" until the init timeout
    // failed it. The first streamed message (a SessionStart hook) proves the runner
    // re-attached — report the session idle-and-ready so the user can prompt it. A
    // later prompt inits it back to `running` (and clears this flag; see below).
    if (runner.awaitingReattach && !runner.stopped) {
      runner.awaitingReattach = false;
      await sendStatus(sessionId, { status: "awaiting_input" });
    }
    const events = [];
    switch (message.type) {
      case "system":
        if (message.subtype === "init" && message.session_id) {
          runner.inited = true;
          clearTimeout(runner.initTimer); // startup succeeded — disarm the init timeout
          await sendStatus(sessionId, { sdk_session_id: message.session_id, status: "running" });
          // Prove — from this very session's live query, not a hard-coded string —
          // which Claude login is paying for it, so the user can see at startup it's
          // their subscription and not an API key. Best-effort, like the commands.
          reportAuthProof(runner).catch(() => {});
          // The available slash commands (/review, /compact, project & user commands,
          // …) vary by cwd/plugins, so we read the live list from the SDK once the
          // query inits and report it for the composer's `/` menu. Best-effort — a
          // failure here must not derail the session.
          reportSlashCommands(runner).catch(() => {});
        }
        break;

      case "assistant":
        for (const block of message.message?.content || []) {
          if (block.type === "text" && block.text?.trim()) {
            events.push({ kind: "assistant", text: block.text });
          } else if (block.type === "tool_use") {
            events.push({ kind: "tool_use", payload: { name: block.name, input: block.input, tool_use_id: block.id } });
          }
        }
        break;

      case "user":
        // Tool results come back as user messages; the user's own prompts were
        // already logged by the app, so we only surface tool_result blocks.
        for (const block of contentBlocks(message.message?.content)) {
          if (block.type === "tool_result") {
            events.push({ kind: "tool_result", text: truncate(resultText(block.content)), payload: { tool_use_id: block.tool_use_id, is_error: !!block.is_error } });
          }
        }
        break;

      case "result":
        events.push({
          kind: "result",
          text: truncate(message.result),
          payload: { subtype: message.subtype, is_error: !!message.is_error, num_turns: message.num_turns, total_cost_usd: message.total_cost_usd },
        });
        break;
    }

    if (events.length) await sendEvents(sessionId, events);

    // A `result` closes a turn; in streaming mode the session stays alive for the
    // next prompt, so report cost and go idle (unless we're tearing down).
    if (message.type === "result" && !runner.stopped) {
      await sendStatus(sessionId, {
        status: "awaiting_input",
        num_turns: message.num_turns,
        total_cost_usd: message.total_cost_usd,
        error: message.is_error ? message.result : null,
      });
    }
  }
}

// Read the session's live slash commands from the SDK (`supportedCommands()`
// returns { name, description, argumentHint }) and report them to the app, which
// stores them on the session so the browser composer can offer a `/` menu. We map
// to snake_case to match the app's payload conventions and drop anything nameless.
async function reportSlashCommands(runner) {
  if (typeof runner.query?.supportedCommands !== "function") return;
  const commands = await runner.query.supportedCommands();
  const slashCommands = (Array.isArray(commands) ? commands : [])
    .filter((c) => c && c.name)
    .map((c) => ({ name: c.name, description: c.description || "", argument_hint: c.argumentHint || "" }));
  await sendStatus(runner.sessionId, { slash_commands: slashCommands });
}

// Read the login THIS session's query is running under, straight from the SDK
// (`accountInfo()` resolves off the init handshake — { email, subscriptionType,
// apiKeySource, apiProvider, organization }), and post it as an `auth` transcript
// event. Because it's read from the live query the prompt runs on — after we've
// stripped every API-credential env var and pinned forceLoginMethod:"claudeai" —
// it's real proof of how this session bills, not a hard-coded claim. The app
// interprets the fields (ClaudeAuth) into the "Claude subscription vs API key"
// card. Best-effort: a read failure must not derail the session.
async function reportAuthProof(runner) {
  if (typeof runner.query?.accountInfo !== "function") return;
  const account = await runner.query.accountInfo();
  if (!account || !Object.keys(account).length) return;
  await sendEvents(runner.sessionId, [
    {
      kind: "auth",
      payload: {
        email: account.email || null,
        subscription_type: account.subscriptionType || null,
        api_key_source: account.apiKeySource || null,
        api_provider: account.apiProvider || null,
        organization: account.organization || null,
      },
    },
  ]);
}

async function finishWithError(runner, err) {
  if (runner.errored) return; // idempotent — the init timeout and the drain loop can both fire
  runner.errored = true;
  clearTimeout(runner.initTimer);
  console.error(`[exponential-agent] session ${runner.sessionId} error: ${err?.message}`);
  await sendEvents(runner.sessionId, [{ kind: "error", text: String(err?.message || err) }]);
  await sendStatus(runner.sessionId, { status: "error", error: String(err?.message || err) });
  sessions.delete(runner.sessionId);
}

const contentBlocks = (content) => (Array.isArray(content) ? content : []);
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n");
  return "";
}

// --- Command dispatch --------------------------------------------------------

async function handleCommand(cmd) {
  const runner = sessions.get(cmd.session_id);
  switch (cmd.kind) {
    case "start":
      startSession(cmd);
      break;
    case "resume":
      resumeSession(cmd);
      break;
    case "prompt":
      // A follow-up means work is incoming: clear the idle re-attach flag so drain
      // reports `running` (off the init the prompt triggers), not a stale idle.
      if (runner?.provider === "codex") {
        runner.pendingPrompts.push(promptWithImages(cmd.payload?.prompt, cmd.payload));
        drainCodexPrompts(runner).catch((err) => finishWithError(runner, err));
      } else if (runner) {
        runner.awaitingReattach = false;
        runner.input.push(promptWithImages(cmd.payload?.prompt, cmd.payload));
      }
      break;
    case "interrupt":
      if (runner?.provider === "codex") {
        runner.interrupted = true;
        try { runner.abort?.abort(); } catch {}
      } else {
        try { await runner?.query?.interrupt(); } catch (e) { /* turn already idle */ }
      }
      break;
    case "stop":
      if (runner) {
        runner.stopped = true;
        if (runner.provider === "codex") {
          try { runner.abort?.abort(); } catch {}
          sessions.delete(cmd.session_id);
          await sendStatus(cmd.session_id, { status: "stopped" });
        } else {
          runner.input.close();
          try { runner.abort.abort(); } catch {}
        }
      } else {
        await sendStatus(cmd.session_id, { status: "stopped" });
      }
      break;
    case "permission": {
      const resolver = runner?.pendingPermissions.get(cmd.payload?.request_id);
      if (resolver) resolver(cmd.payload?.decision, cmd.payload?.message);
      break;
    }
    case "set_permission_mode":
      // Change the tool-permission strategy of the live query (streaming-input
      // only, which every session is). No-op if the runner's gone — the new mode
      // is already persisted app-side and rides the next resume's payload.
      if (runner?.provider !== "codex") {
        try { await runner?.query?.setPermissionMode(cmd.payload?.permission_mode || "default"); }
        catch (e) { console.error(`[exponential-agent] setPermissionMode failed: ${e?.message || e}`); }
      } else if (runner?.thread?.id) {
        runner.optionsPayload = { ...runner.optionsPayload, permission_mode: cmd.payload?.permission_mode || "default" };
        runner.thread = codex.resumeThread(runner.thread.id, codexThreadOptions({ ...runner.optionsPayload, resume: runner.thread.id }));
      }
      break;
    default:
      console.error(`[exponential-agent] unknown command: ${cmd.kind}`);
  }
}

// --- Claude Code status ------------------------------------------------------
// Read who Claude Code is logged in as and how tokens are paid for, straight from
// the SDK — never hard-coded. `accountInfo()` resolves off the SDK's init handshake
// ({ email, subscriptionType, apiKeySource, apiProvider, … }), so we spin up a
// throwaway subscription-only query, read it, and tear the query down before any
// prompt runs — it costs no tokens. Returns null if Claude Code isn't logged in
// (or the CLI is missing), which the app renders as "status unknown".
const REFRESH_STATUS_MS = 60 * 60 * 1000; // re-read hourly so a plan/login change shows up

async function fetchClaudeStatus() {
  const input = makeInputQueue();
  const abort = new AbortController();
  try {
    const probe = query({ prompt: input.generator, options: { ...subscriptionOnlyOptions(), abortController: abort } });
    const account = await probe.accountInfo();
    return account && Object.keys(account).length ? account : null;
  } catch (err) {
    console.error(`[exponential-agent] couldn't read Claude Code status: ${err?.message || err}`);
    return null;
  } finally {
    input.close();
    try { abort.abort(); } catch {}
  }
}

// --- Main loop ---------------------------------------------------------------

async function register() {
  const claude = await fetchClaudeStatus();
  const res = await api("/agent/register", { method: "POST", body: { name: AGENT_NAME, platform: platform(), version: VERSION, claude } });
  if (res.ok) {
    const info = await res.json().catch(() => ({}));
    updateAmplifierMcp(info.mcp);
    const who = claude?.subscriptionType ? ` — Claude ${claude.subscriptionType} subscription${claude.email ? ` (${claude.email})` : ""}` : "";
    console.error(`[exponential-agent] registered as “${AGENT_NAME}” on ${EXPONENTIAL_URL}` + (info.account ? ` (workspace: ${info.account})` : "") + who);
    console.error(`[exponential-agent] Amplifier MCP ${amplifierMcp ? `enabled (${amplifierMcp.url})` : "not available from register response"}`);
  } else {
    console.error(`[exponential-agent] register failed: HTTP ${res.status}`);
  }
}

// Quietly re-report the Claude Code status so the app's display stays current
// without needing an agent restart.
async function refreshStatus() {
  const claude = await fetchClaudeStatus();
  const res = await api("/agent/register", { method: "POST", body: { name: AGENT_NAME, platform: platform(), version: VERSION, claude } });
  if (res.ok) {
    const info = await res.json().catch(() => ({}));
    updateAmplifierMcp(info.mcp);
  }
}

// Sort key: start/resume (which create the runner) sort ahead of every other
// command so they're handled first within a poll batch.
const launchRank = (cmd) => (cmd?.kind === "start" || cmd?.kind === "resume" ? 0 : 1);

async function pollLoop() {
  console.error("[exponential-agent] waiting for sessions… start one from the app's Claude Code Sessions page.");
  while (true) {
    try {
      // Report the sessions we currently hold live so the app can reconcile: any
      // it thinks is running that we no longer list has dropped (we restarted, or
      // the connection was cut and its runner is gone), and it re-attaches those
      // by queuing a resume. After a full restart this list is empty, so every
      // live session is recovered on the very first poll.
      const live = [...sessions.keys()].join(",");
      const res = await api(`/agent/poll${live ? `?sessions=${encodeURIComponent(live)}` : ""}`);
      if (!res.ok) { await sleep(2000); continue; }
      const { commands = [] } = await res.json().catch(() => ({ commands: [] }));
      // Handle session-creating commands (start/resume) before the rest of the
      // batch, so a follow-up `prompt` delivered alongside a (re)start finds its
      // runner instead of being dropped — startSession registers the runner
      // synchronously, so once the start is handled the prompt lands on it. A stable
      // sort preserves the order of everything else.
      const ordered = [...commands].sort((a, b) => launchRank(a) - launchRank(b));
      for (const cmd of ordered) await handleCommand(cmd);
    } catch (err) {
      console.error(`[exponential-agent] poll error: ${err.message} — retrying`);
      await sleep(2000);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on("SIGINT", () => { console.error("\n[exponential-agent] shutting down"); process.exit(0); });
process.on("uncaughtException", (err) => console.error("[exponential-agent] uncaught:", err?.message));
process.on("unhandledRejection", (err) => console.error("[exponential-agent] rejection:", err?.message));

await register();
setInterval(() => { refreshStatus().catch(() => {}); }, REFRESH_STATUS_MS).unref?.();
await pollLoop();
