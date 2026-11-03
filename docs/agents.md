# Agent connections

Run `clanker setup` for first use and `clanker agents` to change access later. Space toggles an app, arrow keys move, and Enter continues. Existing active connections are preselected. Cancelling before confirmation does not save settings. `clanker agents --list --json` provides a machine-readable inventory without credentials.

Discovery checks known app folders, executable names on PATH, and configuration locations. It does not read conversation history, provider credentials or arbitrary device files. Saving a connection reads its configuration so that unrelated settings can be preserved. Original nonempty files are backed up under `~/.clanker/backups/<app>/` with owner-only permissions. Backups may contain private provider settings; keep the whole Clanker profile private.

## Supported apps

| App ID | User configuration on macOS | Integration |
| --- | --- | --- |
| `hermes` | `~/.hermes/config.yaml` | YAML `mcp_servers` |
| `codex` | Codex CLI user configuration | Native `codex mcp add/get/remove` |
| `claude` | `~/.claude.json` | `mcpServers` |
| `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers` |
| `omp` | `~/.omp/agent/mcp.json` | `mcpServers`, stdio |
| `cursor` | `~/.cursor/mcp.json` | `mcpServers`, stdio |
| `vscode` | `~/Library/Application Support/Code/User/mcp.json` | `servers`, stdio |
| `opencode` | `~/.config/opencode/opencode.json` or existing `.jsonc` | OpenCode 2 `mcp.servers.clanker`, native local command array |
| `manual` | Run `clanker config` after selecting Other MCP app | Copy settings into another MCP host |

`HERMES_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `XDG_CONFIG_HOME` are respected when set. Claude Code's MCP entry uses `$CLAUDE_CONFIG_DIR/.claude.json` for a custom directory; native hooks use `settings.json` inside that directory, or inside the default Claude configuration directory when no override is set. Hermes setup follows the `active_profile` selected by `hermes profile use` under the Hermes home; an explicit `HERMES_HOME` already pointing into `profiles/<name>` takes precedence. Only that active home is configured, not every named profile. OMP uses the active `OMP_PROFILE` or `PI_PROFILE` under `~/.omp/profiles/<profile>/agent/`; `PI_CONFIG_DIR` changes the `.omp` root and `PI_CODING_AGENT_DIR` overrides the default-profile agent directory (not named profiles). An existing OMP `.mcp.json` is used if `mcp.json` is absent. Only Clanker's name is removed from OMP's disabled-server list when connecting it. On Linux, Claude Desktop and VS Code use `$XDG_CONFIG_HOME/Claude/claude_desktop_config.json` and `$XDG_CONFIG_HOME/Code/User/mcp.json`, falling back to `~/.config`. Other default paths are the same on macOS and Linux. Project-specific settings and other profiles are not scanned or rewritten.

Codex needs its CLI on PATH for safe native configuration, even when the desktop app is detected. Other absent apps may be configured in advance. Restart the host after saving if it does not reload MCP settings. A host may also require approval to use tools.

## Native capabilities

All eight apps can use the same inbox, messaging, decisions, discussions and bridge tools through MCP. That does **not** mean every app can display an idle alert or answer unattended. Configuration/SDK checks are not native-app proof.

| App | Inbox awareness | Accepted second-opinion continuation | Unattended bridge answer |
| --- | --- | --- | --- |
| Claude Code | Native count warning and optional sender/preview note on the same next normal user turn; no extra turn (unreleased) | Explicit custom Channels preview opt-in and Claude consent; channel requests the authorized turn | `claude -p`; real-model check recorded |
| Codex CLI | Native count warning and optional sender/preview note on the same next normal user turn; no extra turn (unreleased) | Trusted session hooks and queue request the authorized turn | `codex exec`; real-model check recorded |
| Hermes | Native plugin posts one display-only count per unread batch; TUI displays immediately | Session injection | `hermes chat --oneshot`; native read-only run checked with a local synthetic provider |
| Oh My Pi | Native UI-only count per unread batch; no conversation card or inbox instructions in the user's visible message | Native extension requests a turn | `omp -p`; real-model check recorded |
| Claude Desktop | No documented native idle interface integrated | Active tool-using session only | No native headless API; defaults to `self` |
| Cursor | No documented native idle interface integrated | Active tool-using session only | Native CLI build 2026.10.22-27dcf5f accepts the preset flags; authenticated/model answering remains unverified |
| VS Code | No current supported native idle interface integrated | Active tool-using session only | No native headless reply command; defaults to `self` |
| OpenCode 2 | Global native count-only `ui.toast.show` per unread batch; display-only | Server plugin resumes only the session that started, accepted or successfully claimed that discussion | Private native server, session permissions and actual `opencode run`; checked with a local synthetic provider |

This unreleased integration requires **OpenCode 2** and was exercised on 2.2.5 (`@opencode/cli`, not the old `opencode-ai` package). Its actual TUI rendered an idle unread toast with zero model requests. Its native server/plugin completed a session-bound discussion through MCP Code Mode, and its native CLI answered from a file with read-only session permissions, both using a local synthetic provider. This is not real-model quality or desktop GUI proof. Start/accept discussions in the intended session. Bindings last for that project instance: after a restart, use the discussion tools in the intended session to claim the next turn; no arbitrary recent chat is chosen. CLI-only acceptance has no native session binding.

OpenCode setup writes the current `mcp.servers.clanker` entry. If an installed CLI is found, setup/upgrade refresh first requires it to report major version 2; an unsupported or unreadable version leaves settings and an existing credential unchanged. App-absent setup may prepare version 2 in advance. It refuses a conflicting native or legacy `clanker` entry and removes only its own legacy `mcp.clanker` during migration, preserving other servers/comments. Deselecting OpenCode revokes access and removes the managed server/TUI wrappers and an empty owned plugin directory. OpenCode 1 plugin implementations are not retained as a compatibility layer.

Ask any connected agent to “turn off Clanker's inbox note” or turn it back on. `clanker_agent_note` reads or changes the shared setting without a terminal; it reports that the note applies to Claude Code and Codex. OMP, Hermes and OpenCode remain display-only. The CLI alternative is `clanker notifications --agent-note on|off`; session-hook registration and notice claims remain local-owner-only.

Codex and Claude Code routine warnings wait for a normal user turn, not idle model work. The owner observed Codex 0.166.0's native count warning. Claude's actual stream emitted an informational count notice with no warning or remote body in the synthetic provider request; interactive visual placement remains login-gated. OMP's current owned run reached first-run onboarding, while runnable Hermes/OpenCode installations were unavailable for updated visual proof. Consumer tests cover the new batch semantics; earlier native card/verbose-toast proof does not establish the updated rendering. Codex desktop has no new automatic quiet-display path: its earlier queue experiment does not verify native hook registration. Claude Code is not Claude Desktop, and Cursor's CLI is separate from its editor UI. VS Code's `code chat` opens UI, not a headless reply runner; no separate Copilot CLI connection is installed.

For Desktop/VS Code `self` bridges, an active agent must explicitly check `clanker_bridge_wait` and reply with `clanker_bridge_answer`. There is no automatic next-turn polling or idle wake, even after both owners consent.

VS Code's legacy sampling service can ask permission for model calls outside chat, but this is not a current idle-wake contract. MCP [2026-07-28 MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr) forbids standalone server requests: input requests must respond to client-initiated `tools/call`, `resources/read` or `prompts/get`. Those active-request paths cannot wake an idle chat. Clanker does not force old negotiation or introduce a deprecated sampling fallback.

For app-specific setup see [idle alerts](notifications.md), [discussions](discussions.md) and [bridges](bridges.md); chronological native evidence and outstanding prerequisites are in [verification](verification.md).


## Access and disconnection

Each app receives a separate random local connection credential. Credentials live in the app's MCP settings and `~/.clanker/clients.json`. Setup and app listings do not display them. `clanker config` deliberately displays the manual connection's credential so you can copy it; keep that output private.

Deselecting an app revokes its credential before removing Clanker's settings entry. A running MCP session loses access on its next call, and a pending inbox wait cannot return messages after revocation. Reconnecting a revoked app generates a new credential. Each allowed app shares the same inbox and MCP tools; per-contact or read-only app permissions are not implemented.

This controls connections through Clanker's MCP server. Programs with your operating-system user account can read your files and use the owner CLI or local socket. Clanker does not provide an operating-system sandbox. Incoming messages also do not grant remote command execution or access to your files.

For unattended setup, explicitly choose the complete selection:

```sh
clanker setup --name Erik --client hermes --client omp --json
clanker agents --client none --json
```

Existing 0.1.0 profiles allow legacy MCP connections until setup is run again. Setup migrates matching old entries and enables the new connection policy. A conflicting `clanker` entry belongs to the user and is left unchanged. If one app cannot be configured, other selected apps can still connect and setup reports the affected app.

## Configuration references

The adapters follow the apps' documented native configuration:
[Hermes](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md),
[Codex](https://developers.openai.com/codex/mcp/),
[Claude Code](https://code.claude.com/docs/en/mcp),
[Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers),
[Oh My Pi](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md),
[Cursor](https://cursor.com/docs/mcp),
[VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers),
[OpenCode 2](https://opencode.ai/v2/docs/mcp-servers/).
