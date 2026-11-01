# Idle inbox alerts, 0.3.0

Select apps with `clanker agents`, then open a new session in each app. Setup saves the MCP connection and the local notification integration. These integrations require Clanker 0.3.0 or later. After upgrading from 0.2.0, run `clanker agents` again and open fresh host sessions.

| App | How the alert reaches an idle session | Live verification |
| --- | --- | --- |
| Oh My Pi | A native extension renders an inbox card and a notice without starting a model turn. | Passed in OMP 18.12.6. |
| Hermes | A plugin posts a session-bound notice. `clanker agent hermes` opens Hermes TUI, which renders it immediately. | Passed in Hermes v0.22.5 TUI. Classic CLI delays notices until a turn ends. |
| Codex CLI | Trusted session hooks register the open session; the daemon uses `codex queue` for a fixed local arrival notice. This can start a model turn and consume usage. | Passed in Codex CLI 0.154.0 after individual hook review. |
| Claude Code | Clanker declares `claude/channel` and sends channel arrival events. Claude may start a model turn. | Passed in Claude Code 2.1.316 with explicit local-development consent. |
| Codex desktop | The shared session queue delivers a fixed local arrival notice to a local Codex task. | Backend delivery and model response passed in a manually registered disposable task. Automatic desktop hook registration and visual confirmation remain unverified. Cloud-orchestrated Work threads are outside this integration. |

## Oh My Pi

Restart OMP after connecting it. Clanker installs `extensions/clanker-chat.js` next to the selected agent profile's `mcp.json`. An idle alert displays immediately; while the agent is busy, a notice appears and the conversation card waits for the next turn without steering the running model.

## Hermes

Open `clanker agent hermes`. After the first agent turn, the session hook starts the inbox listener automatically. To enable it before that first turn, enter `/clanker` once. It polls inbox status every two seconds and posts a local notice without calling a model.

The plugin has access only to the `clanker` MCP server. Ordinary inbox notices use display-only posts. Accepted [second-opinion discussions](discussions.md) use the session injection API to request an agent turn, so setup also grants the plugin `allow_gateway_injection`. The plugin refuses to arm in messaging-platform sessions such as Telegram chats. Hermes's classic CLI accepts plugin notices internally but defers their display until a turn finishes. Use Hermes TUI for idle alerts.

## Codex

Connect Codex, open `/hooks`, review the two **Clanker Chat alerts** command hooks and trust them if you accept their behavior. Hooks run outside Codex's sandbox. Clanker never writes Codex's trust record or bypasses this review.

`SessionStart` runs a background listener; `SessionEnd` closes its registration. The listener sends a heartbeat every ten seconds, and the daemon stops targeting a registration after 35 seconds without one. An open listener can resume after sleep; inactive lease records remain for 25 hours so a late heartbeat cannot recreate a closed session. A new session lease prevents an old listener from reviving or closing a newer session. A listener has a 24-hour hook timeout, so reopen the session after that limit. `clanker notifications` shows live registrations and delivery errors.

The daemon queues one arrival notice per unread batch in each registered session. It does not include the sender's name, message text or task instructions. Read and mark messages with the existing inbox tools when the local user asks. Clearing the unread batch allows another alert.

Only local owner commands can register session hooks. MCP client credentials cannot call the registration endpoints. App access revocation stops new alerts. Local processes running as the same OS user remain within the same trust boundary as the rest of Clanker.

## Claude Code

Custom Channels are a research preview. Clanker is not an approved production channel. For a locally reviewed development build, explicitly launch:

```sh
clanker agent claude --development-channel
```

This requests only `server:clanker` through Claude's development-channel flag. Claude displays its own warning and consent. The ordinary `clanker agent claude` command explains the opt-in instead of enabling it silently. Claude Desktop's ordinary MCP connection does not provide this Claude Code feature.

Clanker does not declare the separate remote permission-relay capability and never handles permission replies. A channel arrival event contains only a fixed local notice and unread-count metadata. Remote content remains behind the inbox tools. Full channel processing needs a working Claude login. The account used for the 1 November follow-up successfully responded to a real channel event; an earlier baseline turn had returned an expired-login error.

## Source contracts

Implementation follows [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Claude Channels](https://code.claude.com/docs/en/channels-reference), [OMP's native extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md), and Hermes v0.22.5's [plugin message API](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/plugin_messages.py) and [frontend routing](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/gateway/plugin_messages.py). Host behavior can change with updates. Protocol tests alone do not establish that a native app showed a visible alert.
