# Verification, 31 October 2026

Environment: macOS arm64, Node.js 25.9.0, npm 11.12.1. Official MCP SDK 1.32.2 and Zod 4.6.7 are pinned in the lockfile. The live test used cloudflared 2026.10.7, downloaded from Cloudflare's GitHub release and checked against its published SHA-256 asset digest. No system-wide installation was made.

## Automated suite

`npm test` for the 0.1.0 release: 13 tests passed, 0 failures, 0 skipped after the Homebrew setup changes.

- Two temporary identities paired using one invitation. Both saved the correct peer; a second use of the code was rejected. A selected session excerpt arrived with a verified durable-delivery receipt, and replaying the message did not duplicate it. A stranger's envelope was rejected.
- An incoming task result was rejected before local approval. After approval, the result arrived on the original thread with a reference to the request. Repeating completion and sending through a revoked contact were rejected.
- An offline message survived sender and recipient restarts. Re-exchanging a code restored discovery and delivered the queued message.
- A single restarted device announced its new address to a friend whose address stayed reachable; delivery resumed.
- The official MCP SDK client discovered tools, waited for an inbox item, read the inbox resource, received both log and subscribed-resource notifications, and sent a reply through MCP. No execution or approval tool was exposed.
- A second daemon was prevented from replacing an active profile's socket.
- Encryption tests rejected altered content, wrong identities, wrong envelope types and expired envelopes.
- Endpoint tests rejected private addresses, arbitrary domains, credentials, custom ports and paths. Loopback required explicit test mode.
- Invitation tests checked expiry and identity consistency. A multibyte payload exceeding 48,000 UTF-8 bytes was rejected.
- First-run setup saved a name with owner-only permissions. Restarting preserved it, and changing the name preserved the device's cryptographic identity. MCP setup used an installation path that survives Homebrew upgrades.
- Codex registration was idempotent and refused a conflicting entry. Claude Code registration used user scope and preserved conflicting settings. Both command interfaces were checked against installed CLI help; mutation tests used stubs and temporary files, not the owner's real agent configuration.
- Setup requested a correctly scoped Homebrew service. A source-checkout setup run printed manual MCP configuration without starting a service or editing any actual agent host settings.

## Public transport

`CLOUDFLARED_BIN=/path/to/cloudflared node test/cloudflare-smoke.js`: passed for the initial prototype before the product rename.

Two throwaway local profiles started two real Cloudflare Quick Tunnels, paired, sent a synthetic message from A to B and a synthetic reply from B to A, then verified saved messages and delivery receipts. Both tunnels were stopped and both profiles removed afterward. No actual contact was messaged and no user content was sent.

Earlier attempts exposed negative DNS responses for newly created tunnel hostnames from this Mac's resolver, while Cloudflare's DNS-over-HTTPS resolver returned valid public addresses for the same names. A restricted DNS fallback was added, with TLS hostname validation retained; the final run passed. Quick Tunnels remain temporary development infrastructure with no uptime guarantee.

## Packaging

The release builder produced a tarball with source, dependencies, documentation and no local identity or inbox data. The extracted archive's CLI ran and its MCP module loaded all dependencies successfully. The generated Homebrew formula passed `ruby -c`; a Homebrew installation and a public tap have not been tested or published.

The dependency audit reported 0 known vulnerabilities after replacing the initially flagged Zod version. This is a dependency advisory check, not a security audit of Clanker Chat or its protocol.

## Homebrew setup verification

Homebrew 7.0.9 parsed the original formula before the product rename in a temporary local-only tap and rendered its background service with restart enabled, five-second restart/throttle settings, and log locations under the Homebrew prefix. The renamed formula uses the stable `opt/clanker/bin/clanker start` launcher and is available in `dist/clanker.rb` after building.

A full local Homebrew install was attempted with automatic updates, cleanup and unrelated dependent checks disabled. It stopped at Homebrew's preflight check because a shared manual-page directory is owned by another local user and is not writable by the current user. No permissions were changed to force installation. Installation, service launch by Homebrew and post-upgrade behavior have therefore not been confirmed end to end.

The distribution target is `imprintsystems/clanker-chat` for source and release assets and `imprintsystems/homebrew-tap` for the `imprintsystems/tap/clanker` formula. The temporary test tap and its formula-specific trust were removed after verification.

## Not verified or implemented

No second physical device or human tester was used. An actual Codex, Claude or other agent app's idle-session notification behavior has not been verified. The test used the MCP SDK client. There is no automatic remote execution, running-session transfer or persistent peer-to-peer discovery transport. Local workflow approval does not enforce permissions in an agent host or operating system. Publishing and installation results are recorded separately below when completed.

## Public preview publication

The preview is published in [imprintsystems/clanker-chat](https://github.com/imprintsystems/clanker-chat), with an immutable [v0.1.0 release archive and checksum](https://github.com/imprintsystems/clanker-chat/releases/tag/v0.1.0). The formula is published in [imprintsystems/homebrew-tap](https://github.com/imprintsystems/homebrew-tap). The public command is `brew install imprintsystems/tap/clanker`, followed by `clanker setup`.

An unauthenticated download of both the public formula and its referenced archive succeeded. The 3,572,812-byte archive's SHA-256 matched the formula: `85fd03032d71568ce1ed2d58da77a89d3beab62c2d06329867bface89dc86c91`. The CLI and setup/MCP modules loaded from the downloaded, extracted package.

`brew fetch --formula imprintsystems/tap/clanker` succeeded. A Homebrew install dry-run automatically found the public tap and trusted the requested formula, then stopped on the existing shared manual-page directory permissions issue described above. No service was started and no agent configuration was changed during this verification.

The imprintsystems organization previously contained its Claude Cowork plugin marketplace and no Homebrew tap. The release-plus-tap pattern follows [Homebrew's recommended direct installation](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap) and is also used by [steipete's tool distribution](https://github.com/steipete/homebrew-tap).

## 0.2.0 agent connections and terminal setup

`npm test`: 20 tests passed, 0 failures, 0 skipped. The integration suite ran with permission to bind temporary local sockets; sandbox-only runs cannot bind these sockets.

The added adapter tests cover Hermes YAML, Codex native CLI registration, Claude Code/Desktop, Oh My Pi, Cursor, VS Code and OpenCode. Temporary settings preserve unrelated servers and comments. Malformed files and conflicting entries remain unchanged. Tests also check legacy migration, private file permissions, selection cancellation and partial failures. Agent configuration tests use isolated fixtures and a stub for Codex CLI mutations, so they do not configure real user apps.

An actual MCP SDK client successfully used a selected app credential. Revoking it denied subsequent calls and an inbox wait already in progress. An anonymous MCP session was also denied after setup enabled access control. This is a local connection policy, not isolation from other processes running as the same user.

The 0.1.0 Homebrew install and background-service setup were successfully completed on a separate MacBook by a human tester. This confirms that install path on that device. Cross-device message delivery and idle notification behavior in each supported agent app remain unverified. The adapters above are tested configuration integrations, not claims that every host has been exercised live.

The actual prompt flow was driven through temporary pseudo-terminals at 100×34 and 80×24 cells. Name entry, multi-selection, confirmation and saving all completed. Screens were captured and visually inspected. The check used isolated app configurations and did not change installed agent settings. `npm audit --omit=dev` reported 0 known vulnerabilities.

All 20 tests also passed from the extracted 0.2.0 package under Node.js 24.22.1, matching the Homebrew formula’s major runtime version. The packaged CLI and MCP/setup modules loaded with their bundled dependencies.

## Additional resilience checks without rebooting a device

The expanded source suite passed 22 tests under Node.js 24.22.1. Two added tests use disposable child processes. They force-kill test daemons and verify that identities, contacts, inbox history, read flags, queued outgoing messages and a local task approval survive. The same MCP process reconnects after its daemon returns, completes the previously approved task in its original thread, and loses access after revocation. A mock tunnel failure also makes the foreground CLI exit with code 1, allowing a service supervisor to restart it. These tests do not exercise an actual login or Homebrew supervisor restart.

`CLOUDFLARED_BIN=/path/to/cloudflared node test/cloudflare-smoke.js --resilience` passed using real Cloudflare Quick Tunnels and synthetic data. Pausing only a disposable cloudflared process caused delivery to fail while the message remained queued. Resuming it delivered the message exactly once without manual retry. Replacing one disposable daemon and its tunnel preserved its identity, announced the new address to the other daemon, and restored delivery without a new invite. Both test profiles and their tunnels were cleaned up.

No computer was rebooted or put to sleep. No normal Clanker service, device network settings or installed agent configuration was changed. These checks simulate interruptions; actual sleep/wake, login startup and idle notifications in each agent host remain separate checks. Recovery when both addresses change still uses a fresh invitation.

## Native CLI idle-notification check, 0.2.0 baseline

The interactive Codex, Claude Code, Hermes and Oh My Pi CLIs were opened against separate disposable Clanker profiles. A synthetic sender delivered one encrypted message to each profile. A transparent stdio proxy recorded the actual JSON-RPC traffic without changing it. Every host received one `notifications/message` frame from Clanker, but no host printed a visible idle alert or started a new visible response during the observation window. None made a further MCP request after that notification. These are terminal CLI results, not a Codex desktop-app test.

| Host | Tested state | Observation |
| --- | --- | --- |
| Codex CLI 0.154.0 | Completed a real `READY` turn, then idle | Notification arrived; no visible alert or response for at least 457 seconds. |
| Claude Code 2.1.316 | MCP connected; setup turn reported expired login | Notification arrived; no visible alert for at least 352 seconds. An authenticated model wake-up test remains blocked by the login failure. |
| Oh My Pi 18.12.6 | MCP connected; idle after a failed local-model turn | Notification arrived; no visible alert for at least 352 seconds. The Ollama backend failed to start its model library, so a healthy model wake-up test remains unverified. |
| Hermes v0.22.5 | MCP connected; idle at its initial input prompt | Notification arrived and appeared in `logs/agent.log`, with no visible alert or response for at least 126 seconds. No model turn was requested. |

Claude's debug log explicitly reported that channel notifications were skipped because Clanker did not declare `claude/channel`. The [Claude channel contract](https://code.claude.com/docs/en/channels-reference) requires that capability and `notifications/claude/channel` events, with explicit channel opt-in. Clanker's ordinary MCP logging is a different path. Hermes's [v0.22.5 implementation](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/tools/mcp_tool_health.py) forwards ordinary MCP log notifications into its logger; the observed `agent.log` entry matches that path.

The 0.2.0 MCP connection adapters provide tool access. They do not establish the intended visible idle-notification experience. Private protocol captures and the detailed test summary are retained locally under the ignored `.local/idle-host-check/` directory; no credentials are included in the summary.

## Host-specific idle alerts, unreleased development source

The full source suite passed 29 tests under Node.js 24.22.1, including seven notification tests. These cover Codex unread-batch coalescing, metadata-only prompts, expiration, access revocation, session leases, owner-only registration endpoints, OMP display without a model turn, Hermes's native JSON-text response envelope and plugin cleanup, managed-file preservation, and Claude channel events without a permission-relay capability.

Separate disposable profiles, synthetic identities and real native CLIs were used for the new live checks. No real contact received a test message. OMP 18.12.6 displayed a `clanker-chat` inbox card and notice while idle. Hermes v0.22.5 TUI displayed `Clanker Chat: 1 unread…` in its status area, then changed the count to 2 after another synthetic message. Both used display-only host APIs without asking a model to respond. Hermes classic CLI accepted the plugin post internally but held its display until a later turn; its model-injection fallback was removed from the implementation.

The first Codex CLI 0.154.0 and Claude Code 2.1.316 checks stopped at native consent. The human explicitly authorized continuing on 1 November. Each of the two Clanker command hooks was reviewed and trusted individually in the disposable Codex profile. Its `SessionStart` hook registered the session automatically. After a completed `READY` turn, a synthetic encrypted message arrived; the idle CLI displayed the fixed local notice, started a model turn and responded, “A new message arrived in your local inbox.” No inbox-reading or execution tool was called.

Claude's native development-channel consent was accepted for the locally built, isolated test. A fresh synthetic message appeared as a `clanker` channel event while idle, then the model responded, “You have 1 unread message in Clanker Chat. I haven't opened it or acted on it. Want me to read it?” This follow-up used a working login and supersedes the earlier expired-login limitation for this test. It does not make Clanker an approved production channel.

A separate, human-authorized Codex desktop task completed a `READY` turn and became idle. The task was manually registered as a scoped notification target without changing global Codex settings. The same Clanker daemon queued its fixed notice through the normal session queue. The desktop backend recorded the notice as a new turn and returned, “You have 1 unread message in your Clanker Chat inbox.” This verifies backend delivery and a model response in a desktop-created task. It does not verify automatic desktop hook registration or visual rendering. The native app blocks computer use, so human visual confirmation remains pending. No alternate screenshot or OS-automation route was used.

See [idle-alert setup and limits](notifications.md). These changes have not been published to Homebrew.

The extracted development archive's CLI, notification assets and MCP/installer/launcher modules loaded successfully under Node.js 24.22.1. The generated Homebrew formula passed Ruby syntax validation. Gitleaks scanned the 36-file public-source candidate and found no leaks; private profiles and native-host captures stayed under ignored `.local/` paths. This scan does not establish that every possible secret pattern is absent.

## Bounded second-opinion discussions, 1 November 2026

The expanded suite passed 37 tests under Node.js 24.22.1. It includes a four-reply exchange with a required final summary, rejection of remote/agent acceptance, per-connection turn claims, stale-worker rejection, stop and deadline enforcement, app/contact revocation, restart persistence, encrypted-event deduplication and a complete two-agent exchange through real MCP connections. OMP's queued discussion turn and Hermes's metadata-only discussion injection are covered by adapter tests. Ordinary inbox notifications retain their previous display-only behavior in those adapters.

A live synthetic discussion used two separate paired local profiles, Codex CLI 0.154.0 and Claude Code 2.1.316. The sender proposed a second opinion on whether a small inbox should reuse its SQLite outbox or add a central queue. The recipient accepted locally for Claude. Idle Claude received the accepted-discussion notice, called `clanker_discussion_next`, then `clanker_discussion_reply` with an early final summary. Idle Codex received the result notice, called `clanker_discussion_get`, and displayed the recommendation, supplied evidence, uncertainty and next step. Both databases recorded `completed`, the same summary, and one agent reply. Protocol captures showed only those discussion tools during the exchange. No human prompt copying or remote execution was used after acceptance.

This live check does not exercise a full discussion in OMP or Hermes, nor automatic Codex desktop registration. These remain distinct from the existing native idle-display and desktop backend checks. Private evidence is retained under ignored `.local/notify-integration-check/`. No actual contact was messaged. The source remains an unreleased development build.


## Native Hermes/OMP discussion and 0.3.0 release checks, 1 November 2026

The full native test paired isolated Hermes v0.22.5 TUI and OMP 18.12.6 profiles using real signed-in OpenAI Codex model providers and synthetic product facts. OMP proposed the discussion. After one local acceptance for Hermes, idle Hermes claimed reply one and asked a focused follow-up question. Idle OMP claimed reply two and answered. Hermes claimed reply three and sent the structured final summary. Both databases recorded `completed`, three replies and identical summaries. Both agents called `clanker_discussion_get` after completion. The captured MCP calls, excluding the plugin's status polling, were discussion tools only. No actual contact was messaged.

The first reused Hermes test profile reported zero MCP connections. A clean disposable profile with an explicitly selected Python runtime and its MCP dependency installed connected successfully and completed the test. This was a test-runtime setup issue; no Clanker protocol change was needed. Hermes background self-improvement also wrote a skill in its disposable profile, illustrating why the host's own background features and permissions remain outside Clanker's protocol boundary.

All 37 automated tests passed again under Node.js 24.22.1 before preparing 0.3.0. Private provider credentials, test profiles, logs and transcripts remain excluded from the public source and archive. The preview release uses the existing release-archive plus Homebrew-tap distribution pattern. Upgrade both devices and run `clanker agents` again before opening new native sessions. Automatic Codex desktop registration remains unverified.

## 0.3.1 checks, 1 November 2026

All 41 automated tests passed under Node.js 24. A real MCP client on two paired local profiles called `clanker_overview` with five unread messages, one pending task request and a 5,664-character session handoff. The overview returned 2,613 characters in 8 ms; the previous unread-inbox call returned 9,834 characters for the same state. `clanker_message` returned the full handoff. In a disposable home, removing the Codex alert hook and then running the upgrade refresh restored both hook entries and left other hooks in place. On the maintainer's Mac, a Codex connection made before 0.3.0 had no alert hook; after re-applying the chosen agents and trusting the hook in `/hooks`, a new Codex chat registered as a live alert session. The service restart after `brew upgrade` and the daily version check run only in a Homebrew install and are verified against the published 0.3.1 package.
