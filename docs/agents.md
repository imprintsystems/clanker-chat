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
| `opencode` | `~/.config/opencode/opencode.json` or existing `.jsonc` | Native local MCP command array |
| `manual` | Run `clanker config` after selecting Other MCP app | Copy settings into another MCP host |

`HERMES_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `XDG_CONFIG_HOME` are respected when set. A custom Claude Code directory stores its user settings in `$CLAUDE_CONFIG_DIR/.claude.json`. Hermes setup follows the `active_profile` selected by `hermes profile use` under the Hermes home; an explicit `HERMES_HOME` already pointing into `profiles/<name>` takes precedence. Only that active home is configured, not every named profile. OMP uses the active `OMP_PROFILE` or `PI_PROFILE` under `~/.omp/profiles/<profile>/agent/`; `PI_CONFIG_DIR` changes the `.omp` root and `PI_CODING_AGENT_DIR` overrides the default-profile agent directory (not named profiles). An existing OMP `.mcp.json` is used if `mcp.json` is absent. Only Clanker's name is removed from OMP's disabled-server list when connecting it. On Linux, Claude Desktop and VS Code use `$XDG_CONFIG_HOME/Claude/claude_desktop_config.json` and `$XDG_CONFIG_HOME/Code/User/mcp.json`, falling back to `~/.config`. Other default paths are the same on macOS and Linux. Project-specific settings and other profiles are not scanned or rewritten.

Codex needs its CLI on PATH for safe native configuration, even when the desktop app is detected. Other absent apps may be configured in advance. Restart the host after saving if it does not reload MCP settings. A host may also require approval to use tools.

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
[OpenCode](https://opencode.ai/docs/mcp-servers/).
