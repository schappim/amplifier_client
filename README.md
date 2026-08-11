# Amplifier client

Run **Claude Code and Codex sessions on your own machine and drive them from the
browser**. This is the local half of [Amplifier](https://amplifier.app)'s agent
session features: a small Node binary that runs Claude via the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) or Codex
via the `@openai/codex-sdk`, then streams everything back to the web app, so the
browser becomes your terminal.

You can run **many sessions at once** — each in its own working directory — and
for each one watch the agent's messages, tool calls, and results stream in live,
send follow-up prompts, and interrupt or stop it.

## Install

```bash
brew install schappim/tap/amplifier-agent
```

Then, with the token from the app (**Claude Code** or **Codex** in the sidebar →
your machine → **Show token & setup**):

```bash
amplifier-agent setup --url https://amplifier.app --token paste-your-token-here
amplifier-agent
```

The machine's dot turns green in the app once it connects. Now start a session
from the Claude Code Sessions or Codex Sessions page: pick the machine, a working
directory, and a first prompt, and watch it stream.

To keep it running after you close the terminal:

```bash
brew services start amplifier-agent
```

### Requirements

- **macOS or Linux** with [Homebrew](https://brew.sh). Node 18+ is installed for
  you as a dependency.
- **A Claude Code login on this machine.** Claude Code is a separate program from
  this agent; if you don't have it yet:

  ```bash
  brew install --cask claude-code && claude
  ```

  Sign in once, and the Sessions page will show which account the machine is
  using. Until you do, the app marks the machine "Claude Code isn't signed in"
  and Claude sessions will fail. Sessions run on your Claude subscription
  (Pro/Max), never on API billing — the agent strips every API-credential
  environment variable and pins the login method before it launches Claude Code.
- **For Codex sessions**, a Codex CLI login on this machine or `CODEX_API_KEY`
  set in the environment.

### Without Homebrew

Node 18+ and a clone are enough:

```bash
git clone https://github.com/schappim/amplifier_client.git
cd amplifier_client && npm install
AMPLIFIER_URL=https://amplifier.app AGENT_TOKEN=paste-your-token-here node amplifier-agent.mjs
```

## How it works

```
Browser  ──▶  Amplifier  ──queue──▶  agent (this binary)  ──SDK──▶  Claude Code / Codex
   ▲             │  ▲                      │
   └─ live stream┘  └──── POST events ─────┘
```

The agent only makes **outbound** requests to the app, so it works from behind a
firewall/NAT with no inbound ports:

1. **Register** — announces this machine on startup.
2. **Poll** — long-polls `/agent/poll` for commands (start a session, send a
   prompt, interrupt, stop, answer a permission request).
3. **Run** — starts the provider-specific runner for each session and streams SDK
   events back to `/agent/sessions/:id/events`.

On registration the app also returns a connector-scoped Amplifier MCP token. The
agent injects that MCP server into both Claude Code and Codex sessions, so tools
such as `get_issue`, `update_issue`, and `add_comment` are available inside
app-launched sessions without a separate manual MCP setup.

## Permission modes

Chosen per session when you start it:

- **Ask each time** (`default`) — every tool needs your approval; requests appear
  inline in the browser with Approve / Deny buttons.
- **Auto-accept edits** (`acceptEdits`) — file edits run without asking.
- **Run unattended** (`bypassPermissions`) — nothing prompts. Use with care.
- **Plan only** (`plan`) — the agent proposes without touching anything.

## Configuration

`setup` writes `~/.config/amplifier-agent/config.json` (mode 0600, in
`$XDG_CONFIG_HOME` if you set one). Environment variables override it, so you can
point a one-off run at a different app without disturbing the saved config:

| Variable        | Default                 | Description                                               |
| --------------- | ----------------------- | --------------------------------------------------------- |
| `AGENT_TOKEN`   | _(required)_            | Connector token from the app.                             |
| `AMPLIFIER_URL` | `https://amplifier.app` | Base URL of the app. `EXPONENTIAL_URL` is still honoured. |
| `AGENT_NAME`    | this machine's hostname | Name the machine registers as.                            |

## Security

**The connector token is a password.** Anyone holding it can start agent sessions
on your machine, and — depending on the permission mode chosen for a session —
those sessions can read and write your files and run commands. Treat it
accordingly:

- `setup` stores it readable only by you (0600), in a directory it creates 0700.
- Rotate it from the app (**Rotate**, next to the token) if it leaks; the old
  token stops working immediately, and you re-run `setup` with the new one.
- The agent talks only to the app URL you configure. Nothing else on the machine
  can see the token or inject sessions.
- Prefer **Ask each time** for anything you would not hand a stranger, and treat
  **Run unattended** as equivalent to giving the app a shell on this machine.

## Notes

- Sessions resume: the SDK session id is saved, so the app can continue a prior
  session across restarts.
- Tool output is capped per event, so a huge file read can't flood the transcript.
- Under `brew services` the agent runs as a launchd user agent and logs to
  `$(brew --prefix)/var/log/amplifier-agent.log` — start there when something
  isn't working. macOS may also ask for permission the first time a session
  touches Desktop, Documents, or Downloads; if a session mysteriously can't read
  files there, grant Full Disk Access to the agent, or run it in a terminal.
- Working directories are paths on **this** machine. `~` is expanded for you, and
  a directory that doesn't exist is reported as such rather than being handed to
  the SDK.
- `amplifier-agent --help` lists everything the binary accepts.

## Development

This repository is a published mirror of the `agent/` directory of the Amplifier
application repo, which is where changes are made. Issues and pull requests are
welcome here regardless — they'll be applied upstream and mirrored back.

## License

MIT © Marcus Schappi
