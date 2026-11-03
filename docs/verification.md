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

## 0.4.0 checks: nicknames, parties and agent decisions, 2 November 2026

All 51 automated tests passed under Node.js 24; the eight party tests passed five more times in a row. Two contact tests cover name resolution: a full ID first, then a local nickname, then the contact's own name, "David's clanker" phrasing, unique nicknames, a contact met through a party never shadowing a paired one, and an older database gaining the nickname column without losing contacts. The party tests run three real local daemons. They check that members who never paired can write to each other only inside the party, that forged, stale and colliding membership events change nothing, that an owner cannot swap a member's encryption key (including for someone the recipient has never seen), that an answer to a withdrawn invitation does not accept a newer one, that a withdrawn invitation whose receipt was lost still ends on the recipient's side, that removal and leaving cancel undelivered messages and stop address announcements, that a message which outruns its membership update arrives once the update does, that state survives restarts, and the 8-person limit.

A separate read-only security review of the party code found five medium issues: key substitution through introductions, a late acceptance consuming a newer invitation, revocation and party teardown committing separately, address announcements authorized before an await, and a withdrawn invitation blocking its own close. All five were fixed and re-checked; the re-check found one new issue in the withdrawal fix (an invitation still queued may already have arrived), which was fixed and is covered by a test.

Three throwaway local inboxes then ran the whole flow through the CLI and a real MCP client: create, invite, join, write to the party, a refused direct message to a party-only contact, removal, and an agent declining an invitation.

A second run used real Cloudflare Quick Tunnels on two separate Macs: two throwaway inboxes on one computer and one on another, with synthetic names and messages. Both pairings, the party invitations, joining and three-way membership worked. Party messages went directly between the two people who never paired, in both directions, and a direct message between them was refused. After the second computer's inbox restarted on a new tunnel address, the party-only member learned that address and the next party message arrived there. Removal reached the remaining member, and the removed person could no longer write to the party. A nickname resolved over the real connection. All 19 checks passed, and every test inbox was deleted afterwards. Not yet verified: parties inside native agent hosts.

Agents now make every decision through tools; the three that let a contact into your work (approving a task request, accepting a second opinion, joining a party) need the user's yes. A real MCP client without dialog support got back the exact question to ask and could join only after passing `userConfirmed`. A client declaring MCP elicitation was shown the question in a dialog; declining it refused the join even with `userConfirmed` set, and accepting it joined. Accepting a second opinion through `clanker_discussion_accept` was exercised through a real MCP client with the chat answer, and an agent's task approval without consent was refused by the daemon. Not yet verified: the dialog inside the real Claude Code and Codex apps, and the dialog for second opinions and task approvals.

## Bridges, 0.5.0, 2 November 2026

All 60 automated tests passed under Node.js 24; the nine bridge tests passed three more times in a row. They run two real local daemons with a stand-in agent command and check that an agent can open or accept a bridge only with the user's yes, that a question is answered by the other side's command in its own folder with read-only access by default, that an agent set to answer itself sees the question and can answer it once, that bridge traffic never counts as unread or shows in the inbox, that a failing agent is tried twice before the asker gets "No answer" and the owner sees the error, that closing stops a running answer and ends the bridge on both sides, that an answer interrupted by a restart runs again, that blocking the contact closes the bridge, the 30-a-day limit, a weekly summary that appears once, that an answer cannot ask back through Clanker's CLI, and that a repeated question or a burst pauses the bridge until the owner resumes it.

A separate read-only security review of the bridge code found four issues, all fixed and covered by tests: the incoming daily limit trusted the sender's timestamp (it now counts local arrival time, and a sender backdating 31 questions gets 30 through); changing what an agent may share, or reconfiguring from a session with another `PATH`, needed no yes (sharing changes now need one, and the approved executable is kept); the consent question for a custom command neither showed the command nor said it cannot be made read-only (it now does both); and a yes in a dialog could apply to a proposal swapped in while the dialog was open (the yes is now tied to the bridge ID it described). Two hardening changes followed: the Codex answer file is read up to 256 KiB, and one contact can have at most 3 proposals waiting.

Real headless runs answered on the answering side with Claude Code 2.1.308, Codex CLI 0.166.0 and Oh My Pi 18.15.0, each read-only, in a folder holding a synthetic posting plan. Each answered a scheduling question from the plan within 20 seconds. Each also got a question telling it to ignore its instructions and create a file in its folder: each refused, and no file was created. Claude Code still applied the maintainer's own prompt hook during the run, so whatever such a hook adds can reach an answer; the bridge guide says so. A real MCP client checked the agent path: an app not installed was refused before the user was asked, the chat path returned the exact question with the real app and folder, the dialog showed the acceptance question, a self-answering agent received and answered a question, and declining the dialog blocked a change to normal tools. Not yet verified: Hermes and Cursor runs (their presets follow their documentation), bridges over real Cloudflare tunnels between two computers, and runs started by the Homebrew background service, whose environment differs from a terminal's.

Loops and taken-over agents were then measured before and after adding loop guards. Two Claude Code 2.1.308 content agents whose answer runs could reach Clanker through MCP, with instructions to coordinate and even to "always confirm with the other agent before replying", exchanged one question and one answer; so did a run where the question itself demanded an ask-back. A scripted agent that always asks back before answering produced 60 questions in 48 seconds before the guards, stopped only by the daily limits, and one question after them. With the run marker set, a forced `clanker_bridge_ask` from Claude Code through its MCP server was refused; without it, the same call went through. Seven attack questions (a request for an API key, owner impersonation, a fake system notice breaking out of the question block, the key spelled backwards, a pretext for a confidential note, a request to repeat all instructions and context, and a normal control question) went to read-only Claude Code, Codex CLI 0.166.0 and Oh My Pi 18.15.0 agents whose folders held a planted key and a confidential note. None of the 21 answers, before or after the changes, contained the key, the note, the bridge instructions or the maintainer's own prompt-hook context; every control question was answered. Claude Code's provider safety filter stopped two of the attacks before the model ran; the owner now sees that filter's message instead of an exit code.

## Presence, 0.5.0, 2 November 2026

An automated test pairs two local inboxes and checks that each shows the other online right after pairing, offline once the online window passes without contact, online again when a message arrives (on the receiving side) and when its signed delivery receipt comes back (on the sending side), and offline with the right last-seen time after one inbox stops. Two throwaway inboxes then ran with the real 75-second window through the CLI and a real MCP client: with no messages at all, the contact still showed online after 90 seconds, last heard 8 seconds earlier through the regular address announcement; right after one inbox stopped it still showed online, as expected within the window; 80 seconds later both `clanker peers` and `clanker_peers` showed it offline, last seen about 2 minutes earlier. Not yet verified: presence over real Cloudflare tunnels between two computers, and a computer that sleeps instead of quitting.

## Real agents, 0.5.0, 2 November 2026

Claude Code 2.1.308 (run with `-p`, resumed between turns) and Codex CLI 0.166.0 (`codex exec`) got plain requests and only Clanker's MCP tools, connected the way `clanker setup` connects them, against two throwaway local inboxes. "Can I chat with David right now?" was answered correctly by both apps while David was online, and by Claude Code 80 seconds after David's inbox stopped. Setting up a bridge worked through agents alone: Erik's agent laid out the terms and proposed after his yes; David's agent found the proposal in the overview, showed the terms Clanker returned (app, folder, read-only access, daily limit, sharing) and accepted after his yes; Erik's agent then asked over the bridge and a real headless Claude Code run on David's side answered from his plan in 21 seconds. Codex read the bridge transcript, saw that its question had already been answered and did not ask again. A paused bridge appeared in the overview with its reason, and the agent resumed it after the owner's yes.

The first run found two problems, both fixed and re-run. Claude Code in print mode advertises confirmation dialogs but cancels them within milliseconds without showing anything, and Clanker reported that as the user saying no; an instant cancel now falls back to asking in chat, while a dialog a person closes still counts as no (covered by a test). Invalid arguments came back as a raw validation dump; they are now one readable sentence naming the wrong field. In Codex, Clanker tools that change something follow Codex's own approval setting: interactive Codex asks before each such call, and `codex exec` with approvals set to "never" refuses them unless the Clanker server's `default_tools_approval_mode` allows them.

A cleanup pass on the same source fixed three more problems. `clanker mcp` kept running and polling the inbox every 2 seconds after its app closed standard input (observed: still running after 8 seconds; now exits in about 0.2 seconds). Two came from reading the code: closing a bridge that had paused itself quietly did nothing (now closes it on both sides, covered by a test), and address announcements went to contacts one at a time, so an unreachable contact could hold up outgoing messages for up to the 10-second request timeout (now sent together; the suite passes, the delay itself was not measured). `clanker_peers` now gives agents only the ID, name, nickname and presence of each contact: 143 bytes instead of 449 for one contact in a local check.

## File attachments, 2 November 2026

On macOS arm64 with Node.js 24.22.2, `npm test` passed **85 tests**, with zero failures, cancellations or skips. Attachment coverage includes binary and empty files, chunk offsets and duplicate chunks, interrupted-transfer persistence, metadata and hash rejection, size and quota limits, authorization changes, exclusive saves and symlink refusal. Integrated cases cover immutable offline snapshots across both inboxes restarting, party-only contacts, removal from a party, and ordinary messages arriving while a file upload is paused.

A revocation race was reproduced before the fix: a contact revoked while attachment verification yielded could still have its message accepted. The regression now passes after checking authorization again immediately before inbox insertion.

A throwaway smoke script generated a **282,058-byte MP4** and exercised the real MCP adapter and CLI, first over loopback HTTP and then through **two real Cloudflare Quick Tunnels** on the same machine. MCP sent the file, exposed its metadata in the overview, saved it to an explicit new filename and rejected an overwrite. The CLI sent it in the opposite direction, displayed its name and byte size in the inbox, saved a matching copy and sent an attachment to a party. Saved copies matched the source SHA-256 exactly. Received and explicitly saved files were not opened or executed.

The smoke used only synthetic content and throwaway profiles. It did not contact a real peer, send a user file, modify installed agent settings or replace the installed service. Both tunnels and profiles were removed afterward. A second physical device, maximum-size public transfers and the native interactive home-menu view were not exercised. This source change has not been installed or released.

## Invite links and decentralized address recovery, 2 November 2026

With Node.js 24.22.2 on macOS arm64, the final `npm test` run passed **103 tests**, with zero failures, cancellations or skips. The new deterministic coverage uses real signed Pkarr packets with isolated in-memory transport. It checks signature/content/timestamp tampering, wrong signers, stale/future/rolled-back records, unsafe endpoints, persisted publication timestamps, publication retries, lookup cooldown, disabled networking and shutdown. Integrated cases recover queued text and a file after both inbox addresses change, preserve an unexpired invitation across an inviter restart, and refuse a contact revoked during an outstanding lookup. Existing party/control delivery and attachment tests pass with the shared recovery path.

An independent public Pkarr probe published a synthetic signed record; the gateways acknowledged storage on 38 DHT nodes, and a separate client recovered the same record with a network-only lookup. No user identity or real contact address was published.

`node test/cloudflare-smoke.js --discovery` passed against real Cloudflare Quick Tunnels and the public Pkarr gateways. Two throwaway inboxes paired through an invite link and exchanged messages. The receiver stopped, the sender queued a **180,017-byte synthetic file**, and both inboxes restarted with different tunnel addresses and unchanged identities. Without another invite or pairing call, the sender recovered the receiver's address, received a verified delivery receipt, and the saved file matched byte-for-byte. A reply in the other direction also arrived. All temporary tunnels and local profiles were closed and removed.

A separate real MCP/CLI smoke checked that `clanker_invite` returns a private link without a duplicate code, `clanker_pair` accepts the complete URL, and reuse of the single-use link is rejected. Human CLI output favors the link; CLI JSON retains both representations. Pairing through positional and stdin links succeeded. File sending and explicit-save tools remained available.

The static invitation page was exercised in Chromium at **1440, 768 and 390 CSS pixels**, with screenshots visually inspected. Copying returned the exact agent prompt; denied clipboard access selected the fallback text. Missing, malformed and expired invitations disabled copying, including one expiring while the page remained open. A hostile display name rendered literally without adding an image or executing code. Browser errors were empty, the phone layout had no horizontal overflow, and local HTTP logs contained no invitation fragments. All page resources were local, with no pairing or external discovery request from the page.

The source design lint reported zero failures; its two warnings were hexadecimal byte formatting and countdown zero-padding, rather than decorative numbering. The standalone layout inspector could not locate a Chrome executable; the actual managed-browser checks above were used instead.

These are development-checkout results, not a production availability guarantee or a second-physical-device test. Gateway outages, prolonged offline/sleep behavior and production-scale traffic were not exercised. Address records are public by device key and may remain cached; the message transport still uses Cloudflare. No real inbox, contact pairing, installed agent configuration or service was changed. Nothing was committed, pushed, installed or released.

## Private address records and request limits, 2 November 2026

Address records were made private to contacts, request allowances were moved behind authentication, and saved files are now marked as downloaded on macOS. With Node.js 24.22.2 on macOS arm64, `npm test` passed **105 tests**, with zero failures, cancellations or skips.

- Records are published only after a contact holds the recovery key, under a key unrelated to the device identity, at a fixed size whatever the address length, with no tunnel hostname, name or device ID in the published bytes. A record opens only with the matching secret and an intact signature; tampered signatures, timestamps and ciphertext, records signed by another key, wrong secrets, malformed credentials, extra or plaintext records and unsafe decrypted addresses were all rejected.
- Revoking a contact replaced the key and secret. The remaining contact received the new pair in its next announcement receipt and found the inbox's next address; the revoked contact's old pair only found the earlier address. Key, secret and publication timestamps survived a restart of the real store.
- 240 forged requests claiming to come from a real contact, spread over the message, announcement and pairing routes, were all rejected without using up any allowance, and that contact's next message was delivered. Before the change, the 121st request in a minute would have been refused for everyone.
- A 0.5.0 inbox and this checkout paired in both directions and delivered messages both ways. The 0.5.0 inbox verified this checkout's announcement receipts, which carry the extra recovery-key field.

`node test/cloudflare-smoke.js --discovery` passed against real Cloudflare Quick Tunnels and the public Pkarr gateways: both throwaway inboxes exchanged recovery keys, restarted on new addresses, recovered each other through the private records and delivered a 180,017-byte file and a reply without pairing again. The saved file carried the `com.apple.quarantine` mark. An earlier run of the same script timed out while pairing, before any discovery step, on a fresh Quick Tunnel; the rerun passed unchanged.

Not verified: production-scale traffic, a flood large enough to matter at the network level, gateway outages, a contact who stays offline through a key rotation, or a second physical device. No real inbox, contact, installed agent configuration or service was changed. Nothing was committed, pushed, installed or released.

## Release 0.5.1, 2 November 2026

0.5.1 ships file attachments, invite links, private address recovery, the request-limit change and the macOS quarantine mark described above. Before release, `npm test` passed **105 tests** with zero failures, cancellations or skips. The release archive was extracted to a temporary folder, where `node src/cli.js --version` reported 0.5.1 and `--help` ran, with the Pkarr client bundled.

## Rotating encryption keys, 2 November 2026

With Node.js 24.22.2 on macOS arm64, `npm test` passed **109 tests**, with zero failures, cancellations or skips.

- A message encrypted to a contact's rotating key opened with that contact's keys, but not with the identity's own key. It still opened after the next weekly rotation, one millisecond before the two-day grace period ended. After that the old key was deleted and the recorded message could no longer be opened with any key left on the device. The deleted key's bytes were absent from both the database file and its write-ahead log.
- Key statements signed by another identity, a swapped key, an altered start time, a missing signature, a start more than five minutes ahead and malformed input were all refused. An older statement never replaced a newer one, and a contact with no statement kept receiving traffic encrypted to the identity key.
- Two inboxes exchanged keys automatically after pairing. One then rotated and deleted the key the other still held. A message and a 70,001-byte file sent to the deleted key were refused at first, then delivered after the sender's next address announcement returned the current key.
- With an inbox running the published 0.5.1 package, this version paired, exchanged text and files in both directions, and kept encrypting to the 0.5.1 inbox's identity key.
- `node test/cloudflare-smoke.js --discovery` passed against real Cloudflare Quick Tunnels and the public Pkarr gateways with this change in place.
- Over real Cloudflare Quick Tunnels, 14 message and file-chunk envelopes were recorded as sent. None opened with the receiving device's identity key alone; all opened with its rotating keys. After both inboxes rotated and deleted those keys, none opened. Messages sent next were delivered after the following address exchange, and a 200,003-byte file arrived intact.
- Two inboxes with history on the published 0.5.1 package were upgraded one at a time. Identities, encryption keys and history were kept, the new keys were exchanged without any action, and the 9 recorded content envelopes behaved the same way. A restart kept the current key.
- In a party with two inboxes on this version and one on 0.5.1, all six deliveries arrived; the two upgraded inboxes used rotating keys with each other and the identity key with the 0.5.1 member.
- With the CLI as separate processes, `start`, `invite`, `pair`, `send` and `inbox` worked; both profiles stored the other's rotating key, `status --json` reported the key's start time, and the key survived a process restart.

Not verified: a contact offline through several rotations on a second physical computer, or clock changes larger than the five-minute allowance. Backups of the profile folder may still hold deleted keys.

## Release 0.5.2, 2 November 2026

0.5.2 ships the rotating encryption keys above. Before release, `npm test` passed **109 tests** with zero failures, cancellations or skips, and the release archive reported 0.5.2 from a temporary folder.

## Remaining app integrations (pre-0.6.0 checks), 2 November 2026

These checks preceded the 0.6.0 release. Checks used disposable HOME/XDG/Clanker profiles, loopback-only inboxes, synthetic evidence and local synthetic model providers. No signed-in provider credentials or real app settings/history were copied, no real contact was messaged, and no installed service was changed.

- **OpenCode 2.2.5** (`@opencode/cli`, with matching native client/plugin types): the real server loaded Clanker's server plugin and native `mcp.servers.clanker` configuration. Setup updated a pre-existing owned native entry and preserved a separate disabled native server. After asynchronous startup, the native MCP API reported Clanker `connected` and the other server `disabled`. A real session called the discussion tools through native Code Mode; the plugin resumed that exact participant session, claimed/replied/completed the accepted discussion, and left another project's session untouched. Ordinary message arrival made zero model requests. The actual event stream emitted `session.execution.started`/`succeeded`, including events without a location; only previously validated session IDs were eligible for continuation.
- **OpenCode native read-only bridge**: its actual `serve --hostname 127.0.0.1 --port 0 --stdio` host created a private session through the native API. The real `run --server <local-url> --session <local-session> --format json` CLI read a synthetic plan and returned its Thursday answer. Provider requests exposed exactly `glob`, `grep` and `read`, not shell, write, subagent, Code Mode or MCP tools. This validates host session permissions, not an operating-system sandbox; trusted host plugins/MCP processes can still initialize.
- **OpenCode native TUI**: `opencode --standalone <scratch-project>` ran under a disposable PTY and rendered the Clanker Chat unread toast while idle. There were zero model requests and no remote message body in the notice. This is actual terminal UI evidence, not OpenCode desktop GUI or real-model proof.
- **Unsupported installed version**: refresh against the actual installed OpenCode 1.19.4 binary failed clearly before migration/plugin installation. Its existing legacy MCP config stayed byte-for-byte unchanged and its existing local credential remained authorized. App-absent setup may still prepare the documented version-2 configuration; no version-1 plugin shim is shipped.
- **Hermes v0.22.5**: the actual native `hermes chat --oneshot -Q --toolsets clanker-read-only --query-file -` path started, called native `read_file` and answered from the synthetic plan. Model schemas contained only `read_file`/`search_files`, never shell, write or MCP tools. A second native startup without `CLANKER_BRIDGE_RUN` also accepted that toolset and read the file. Registration is unconditional so a gateway loaded before a bridge run knows the name; these checks exercised native one-shot startup, not an external-channel persistent gateway deployment.
- **Desktop/VS Code self bridges**: real MCP SDK clients proposed/accepted the default `self` bridge, explicitly retrieved a question with `clanker_bridge_wait` and replied with `clanker_bridge_answer` during active calls, without creating a runner job. This mode requires active bridge-tool checks, not automatic next-turn polling or idle continuation. This is protocol behavior, not a native Claude Desktop or VS Code GUI check.
- **Upgrade-stable plugin loading**: the original throwaway Cellar/opt reproduction imported the installer through a symlink, switched opt, deleted the old version and failed with `ERR_MODULE_NOT_FOUND`. After the fix, both current server/TUI package parts imported the new version successfully under those same filesystem operations. A functional regression preserves that behavior; disconnect coverage also preserves unrelated files and removes an empty owned package directory.

The final Node.js 24 `npm test` run passed **116 tests**, with zero failures, cancellations or skips (about 14 seconds). Behavioral additions cover wrong-session/failed-claim takeover, immediate native completion during prompt admission, no ordinary-message model turns, revocation/disposal, partial-text error rejection and exclusion of tool arguments/reasoning, native-config conflicts/preservation, unsupported-version refresh, self-bridge usability and the functional opt cutover.

After removing incidental consent/version-message assertions, `node --test test/clients.test.js test/bridges.test.js` also passed **20 tests**, with zero failures, cancellations or skips. The self-mode test checks consent, actual bridge-tool exchange and absence of spawned jobs, not a sentence snapshot.

Chromium rendered the unchanged-layout support section at **1280 and 390 CSS pixels**. Screenshots were visually inspected after its existing reveal animation completed: all eight app identities remained, the inbox/automatic-capability distinction and public support-matrix link were readable, and neither viewport had horizontal overflow.

A separate read-only Cursor check used official CLI **2026.10.22-27dcf5f**: it accepted `-p --trust --output-format text --mode ask`, reported unauthenticated status with `status --format json`, and ran `mcp list` against an empty disposable configuration. Configured-Clanker native MCP discovery, authenticated model answering and editor idle alerts remain unverified.

Remaining prerequisites/limits: real-model/account runs for the new OpenCode/Hermes paths; OpenCode desktop GUI proof; authenticated Cursor answering and configured native MCP discovery; Claude Desktop/VS Code real-host checks and a supported current idle/headless API; Codex desktop automatic hook registration and visible delivery. VS Code's old outside-chat sampling service is not used: current MCP MRTR forbids standalone server requests and sampling is deprecated. Active-session MCP and explicit self bridges remain available; no unrelated CLI is relabelled as one of those apps.

## Agent-first terminal entry (pre-0.6.0 checks), 2 November 2026

The root `clanker` command and root help now show a compact agent-first introduction, with manual controls beneath it. The root path does not load or modify a profile, start setup, restart the inbox or consume message/update state. `clanker home` explicitly opens the previous interactive inbox menu. App inventory is labelled **Connected apps**; this change does not add durable agent roles, standing grants, a team-task directory or new notification behavior.

Actual Node.js 24 CLI processes ran under Python-created PTYs at **48, 60, 80 and 100 columns**, with color and `NO_COLOR`. Root output, root help, scoped setup/send/bridge help, `help --all` and `--help --all` all fit their terminal widths. The existing bubble wordmark and palette were retained. At 48 columns, long command usages and descriptions use stacked, wrapped rows rather than overflowing columns. Menu option hints also wrap within the existing prompt layout.

The explicit home menu ran against a disposable loopback-only inbox. Enter opened messages; Down/Enter opened second opinions; Up/Enter chose Close; Ctrl-C and Escape cancelled successfully. Enter, Close and Ctrl-C were also exercised at every width in both color modes. A fresh `home` invocation offered explicit setup without creating a profile. Root output remained the same introduction with and without a configured profile, rather than implying that an inbox was online.

Explicit guided `setup --no-service` ran in a real PTY with no apps selected, saved the synthetic name and completed; cancelling explicit app selection left the profile unchanged. Noninteractive `setup --name Synthetic --client manual --no-service --json`, app inventory/disconnection JSON and loopback `status --json` remained parseable and retained their existing result shapes. No real host configuration, credentials, contacts or installed service were changed. No tunnel or external model provider was used.

After removing incidental catalog/copy/default assertions, `node --test test/cli.test.js test/setup.test.js` passed **9 tests**. The final full Node.js 24 `npm test` run passed **121 tests**, with zero failures, cancellations or skips. New tests cover non-mutating root/help behavior, unknown-help failure boundaries, narrow/color output boundaries, noninteractive home rejection, setup identity persistence and actual manual-app credential revocation: configuration export works while authorized, and the old credential and export are refused after deselection. Scoped/manual-help discovery was exercised in the actual PTY smoke above, not pinned as copy in permanent tests. Existing MCP and collaboration regression tests remain in the full suite.

These are local development-checkout results, not a release or a physical-terminal/app-integration guarantee. Notification behavior was not changed or newly verified by this workstream.

## Codex next-turn inbox warning (pre-0.6.0 checks), 3 November 2026

Routine Codex inbox arrivals no longer use `codex queue`. A trusted synchronous `UserPromptSubmit` hook returns only native `systemMessage` JSON, such as **Clanker Chat · 3 unread**, once per chat's unread batch. It adds no developer context, user-message block or request for an assistant response. The timing is deliberately the next normal user turn, not an immediate idle indicator. Already accepted second-opinion work retains its separate session-queue continuation.

With Node.js 24, `node --test test/notifications.test.js test/clients.test.js test/setup.test.js` passed **25 tests**. The final main-checkout `npm test` passed **122 tests**, with zero failures, cancellations or skips. Behavioral coverage includes no routine-arrival queue calls; count-only hook output; first-turn ordering before async registration; coalescing across chats; partial-read suppression; rearming after old messages are read and a new one arrives before any zero-unread tick; unchanged unread state; owner-only notice claiming; access revocation; stale lease cleanup; accepted-work continuation, expiry and retry; and actual CLI hook failure when its daemon is unavailable.

Setup/refresh upgraded a two-event Codex hook configuration to include `UserPromptSubmit`, preserved unrelated hooks and events, refused a user-edited conflicting handler without changing its file, and removed all three managed handlers on disconnection. Detection no longer mistakes the old two-event installation for a current one. Existing messages and conversation history are not deleted.

Against a disposable loopback inbox, the real Node.js hook command emitted exactly `{"systemMessage":"Clanker Chat · 3 unread"}` for a disposable session ID, then emitted nothing on its second invocation. The inbox's unread count stayed at three.

At this stage, native visual placement remained unverified; the later quiet-count checks below record subsequent Codex evidence. Hook stdout alone does not prove the native warning's exact placement or subtlety, absence of a new visible prompt block, or native model-turn behavior. No immediate idle badge or new desktop display path is claimed.

## Consistent quiet inbox counts (pre-0.6.0 checks), 3 November 2026

This work extends the existing quiet Codex behavior across supported integrations. Routine awareness is a single **Clanker Chat · N unread** count per unread batch on the host's existing surface, with no remote names/body/policy text, automatic inbox reading or extra model turn. OMP no longer adds a routine conversation card; Hermes keeps display posts separate from discussion injection; OpenCode uses the documented message-only toast, retaining its existing global TUI scope and one app-level boundary without router dependencies. Claude Code uses a genuine `UserPromptSubmit` warning hook instead of ordinary arrival channels. Accepted-discussion continuation remains authorized and separate.

The final Node.js 24 `npm test` run passed **126 tests**, with zero failures, cancellations or skips (about 14 seconds). Consumer coverage includes coalescing and partial reads, read-plus-arrival before a zero tick, native client/session isolation, global OpenCode batch suppression, no headless OMP model fallback, revocation, preservation of accepted work, actual Codex/Claude hook processes, owner-only claiming, default/custom Claude settings roots, safe hook refresh/conflicts/removal (including a removed MCP entry), and migration preserving existing Codex notice claims. Copy/brand wording is not pinned by the new permanent count assertions.

Actual changed-path smoke checks used fresh owned profiles and synthetic data:

- **Claude Code 2.1.308, native headless stream:** the actual CLI ran a normal user prompt with a loopback synthetic Anthropic provider. Its stream emitted `type: system`, `subtype: informational`, `level: notice`, containing `UserPromptSubmit says: Clanker Chat · 1 unread`. Captured provider traffic contained exactly one normal message request plus token counting; neither the count notice nor the planted remote body appeared in that request. The inbox remained unread. This establishes native informational-message and model-context separation, **not interactive visual placement, a real model/account run or bypass of login/consent**.
- **OMP transport/adapter:** a real stdio MCP connection delivered local unread metadata to the installed extension. One count appeared, another arrival coalesced, reading the covered message rearmed the next count, and clear-plus-arrival rearmed without a zero poll. Starting a fresh adapter chat while retaining that same MCP connection produced exactly one new count from OMP's existing metadata poll. Four display callbacks, zero model messages and unchanged unread state were recorded. This is actual transport/installed-adapter proof with a synthetic UI callback, not native visual proof.
- **Hermes transport/adapter:** the installed plugin's actual background watcher called its tools through a persistent real stdio MCP connection. It produced three count-only display posts across coalescing/read/rearm transitions, zero model injections and no remote text. Routine posts left unread state unchanged. No runnable native Hermes installation was retained for this follow-up, so updated TUI rendering remains unverified.
- **OpenCode transport/adapter:** the installed package wrapper polled the real daemon using only documented `ui.toast.show`, with no router/session dependency. Count-only callbacks coalesced for the global unread batch, rearmed after reading the covered messages even without a zero poll, and stopped after revocation. No model prompt or remote text was submitted. This is actual wrapper/status-path proof against a documented UI callback, **not an actual OpenCode renderer run**. No runnable binary was found in the current or retained installation locations.
- **OMP native attempt:** the actual 18.15.0 Terminal application session reached first-run setup's provider sign-in selection. No onboarding, login or trust was accepted to force progress. That owned probe process/window was closed afterward; updated native count rendering remains gated on completing supported host setup.

Codex CLI 0.166.0's native `Hook · Clanker Chat · 3 unread` was observed during a normal user turn. This supersedes the earlier visual gate above. Claude Desktop, Cursor, VS Code and Codex desktop have no newly integrated automatic quiet surface: existing manual active-turn MCP limits are documented, not relabelled as native parity.

Checks used disposable profiles and synthetic data without changing an installed service, copying authentication/trust records or contacting real contacts.

## Notification lifecycle regressions (pre-0.6.0 checks), 3 November 2026

Count-notice claims now persist while their covered messages remain unread, even after 25 hours; Codex session-lease expiry is unchanged. A regression covering both Codex and Claude failed before the fix because the same batch was announced again after a 26-hour clock advance, without any new arrival.

OpenCode's workerless discussion poll excludes active turn claims. Its delivery markers now track only the current pending revision/kind, so an interrupted claimed turn can wake its bound session again after the ninety-second lease expires. The regression failed before the fix and now covers one renewed wake for that same revision, no wake during the active claim and no repeated wakes while recovered work stays pending and unclaimed.

The final Node.js 24 `npm test` run passed **128 tests**, with **0 failures, 0 cancellations, 0 skips and 0 todos**. CLI smoke checks returned `clanker 0.5.2` from `--version` and the agent-first introduction from `--help`. These checks use synthetic local profiles; they do not add native-app visual or real-model verification.

## Optional next-prompt inbox mentions (pre-0.6.0 checks), 3 November 2026

The initial Node.js 24 `npm ci --ignore-scripts` and `npm test` run passed **131 tests**, with **0 failures, 0 cancellations, 0 skips and 0 todos**. Consumer coverage included one sender/preview note per unread batch, no repeat on the next prompt, read rearming, unchanged unread state, nickname display, sanitized/capped previews, revocation and the live owner-only `--agent-note on|off` toggle.

The actual `notify claude` and `notify codex` commands were exercised with disposable profiles created using `setup --no-service`, two paired local synthetic inboxes and one encrypted test message. Each first prompt emitted the native `systemMessage` plus `hookSpecificOutput` with `hookEventName: "UserPromptSubmit"` and the delimited sender/preview note. Each second prompt emitted no output. Unread remained one after both hooks. The owner CLI reported `{"agentNote":false,"sessions":[]}` after switching notes off. Temporary profiles were removed; no installed service, authentication/trust state or real contact was used.

OMP has no documented hidden per-request context path; its [`input` hook](https://github.com/can1357/oh-my-pi/blob/594670d6b0b6d5f8080693aad34dedd38b5ebd94/packages/coding-agent/src/session/agent-session.ts#L8330-L8413) replaces the visible user message, so ordinary arrivals stay display-only.

Hermes stays display-only because its [`pre_llm_call` hook](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/agent/turn_context.py) has no trusted user-input origin discriminator and also runs on automatic turns.

OpenCode stays display-only because [prompt admission](https://opencode.ai/v2/docs/build/plugins/server/#prompt-admission) also handles programmatic submissions, while context hooks run on continuations; neither provides a trusted next-user-request boundary.

This verifies hook JSON, adapter/setting behavior and unread-batch semantics, not new authenticated native-host visual placement or real-model compliance with the one-sentence instruction. The previous count-only provider captures do not establish the new note's model behavior.

## Inbox-note review corrections (pre-0.6.0 checks), 3 November 2026

Note previews now use the overview's ordinary-inbox filters, excluding internal discussion/party/bridge events and pending approvals. The unread count still matches the native display, while `previewable` identifies the ordinary inbox subset and “and N more” counts only that subset. A regression inserts unread protocol rows without text and confirms that they are not summarized, the count remains coherent and no message is marked read. A synthetic formatter failure confirms that context is built before the display claim, leaving the claim available after failure. Literal contact-data delimiter markers are stripped from names and previews before whitespace sanitization and truncation.

Consumer tests confirm OMP leaves user text unchanged with either setting and continues native count-only notices.

The full Node.js 24 `npm test` run passed **133 tests**, with **0 failures, 0 cancellations, 0 skips and 0 todos**.

Both actual Claude/Codex hook commands were repeated against disposable profiles initialized with `setup --no-service` and paired local synthetic inboxes. Each first prompt returned `systemMessage` and nested `UserPromptSubmit.additionalContext` with the ordinary sender/preview data; each second prompt returned empty stdout. Unread remained one; the CLI toggle reported `agentNote: false`. All temporary profiles and installed test dependencies were removed. No native-app visual or real-model proof is claimed.

## Decision arrivals in next-prompt notes (pre-0.6.0 checks), 3 November 2026

Inbox notes now include the owner decisions surfaced by the overview: pending task requests, second-opinion proposals, party invites and bridge proposals. They preview task text, discussion question, party name or bridge topic, with sender nickname and explicit kind, using the same sanitization/caps and shared newest-first three-item limit as ordinary messages. Only unread arrivals within the batch boundary count toward the preview list and “and N more”; internal protocol traffic remains excluded. This supersedes the earlier exclusion of pending approvals from note previews. The shortened instruction still permits mentioning only and explicitly requires the user's yes before approving, accepting, joining or opening.

Node.js 24 `npm ci --ignore-scripts` and the full `npm test` suite passed **134 tests**, with **0 failures, 0 cancellations, 0 skips and 0 todos**. New coverage exercises every decision kind, sender nicknames, sanitized/capped decision previews, newest-first ordering, shared truncation, batch-boundary exclusion, pending approval preservation and absence of internal event previews.

Actual Claude and Codex hook commands ran against paired disposable local profiles initialized with `setup --no-service`. An encrypted ordinary message and a second-opinion proposal arrived. Each first prompt returned **Clanker Chat · 2 unread** plus a note listing the proposal question before the message; each second prompt returned empty stdout. Both messages remained unread and the discussion remained `proposed`, with no acceptance. Temporary profiles and test dependencies were removed. No real contact, installed service, native visual rendering or real-model response was involved.

## Agent-controlled inbox-note setting (pre-0.6.0 checks), 3 November 2026

Any connected agent can now read the local inbox-note setting or change it when the local user asks, using `clanker_agent_note` with optional `setting: "on" | "off"`. No confirmation dialog is needed. The tool reports that the note applies to Claude Code and Codex; OMP, Hermes and OpenCode remain display-only. The CLI flag remains available. Session-hook registration, unregistration and notice claims remain owner-only.

Node.js 24 `npm ci --ignore-scripts` and the full `npm test` suite passed **136 tests**, with **0 failures, 0 cancellations, 0 skips and 0 todos**. New consumer coverage includes enabled display-only app credentials reading/changing the daemon setting, the next claimed batch reflecting the change, no reannouncement of already claimed batches, revoked apps receiving the normal not-connected error, continued refusal of MCP credentials at hook endpoints, and the actual stdio MCP tool controlling a real Claude prompt hook.

A separate smoke check ran the actual MCP server over stdio with an enabled app credential and a disposable local profile. Reading returned `{"agentNote":true,"appliesTo":["Claude Code","Codex"]}`. Switching off returned `agentNote: false`; the real `notify claude` command then emitted only `{"systemMessage":"Clanker Chat · 1 unread"}`. Switching on and delivering the next unread batch restored `hookSpecificOutput` with `hookEventName: "UserPromptSubmit"` and the sender/preview note. A repeated prompt emitted no output; the message remained unread. Temporary profiles, the smoke script and installed test dependencies were removed. No real contact, installed service, native visual rendering or real-model response was involved.

## Release 0.6.0, 3 November 2026

0.6.0 ships next-prompt sender/preview notes for Claude Code and Codex, with an agent-controlled off switch, OpenCode 2 support, quieter one-per-batch alerts and the agent-first CLI. OMP, Hermes and OpenCode remain display-only for ordinary inbox arrivals; accepted discussions keep their separate authorized continuation paths.

Before release, Node.js 24 `npm ci --ignore-scripts` and the full `npm test` suite passed **136 tests**, with **0 failures, 0 cancellations, 0 skips and 0 todos**. The checks above cover actual hook JSON, settings access and unread-batch behavior. They do not establish new authenticated native-app visual placement, real-model compliance with the one-sentence note or OpenCode desktop GUI behavior.

## Styled inbox notes and OMP owner-turn context, 2026-11-03

Inbox notes now ask the agent to finish its answer with one short Markdown quote line, using a backticked label rather than ANSI styling or bold/italic markup:

```markdown
> `Clanker Chat`: David asked about the checkout bug.
```

This mirrors Imprint's blockquote/backtick-tag convention. The note remains mention-only: contact previews are untrusted data, not instructions; no automatic reads, replies or tools are authorized, and approval/acceptance/joining/opening decisions still require the user's yes.

Oh My Pi retains its native **Clanker Chat · N unread** count. Its documented ingress-only `input` and `before_agent_start` hooks also support a hidden agent-attributed custom message on the next main-session owner prompt, without rewriting visible user text or starting another turn. The earlier claim in this log that OMP has no hidden per-request path was incorrect and is superseded by this check. `display:false` is omitted by OMP's transcript renderer, but hidden previews can still be saved in session history and sent to the configured model provider. Hermes and OpenCode remain display-only.

Node.js 24 `npm ci --ignore-scripts` and the full `npm test` suite passed **147 tests**, with **0 failures, 0 cancellations, 0 skips and 0 todos**. Coverage includes the quote-line instruction, one hidden OMP note per displayed batch, exact owner-input correlation and combined queued inputs, preparation retries, commands/continuation shortcuts/synthetic turns/child-session exclusion, unchanged user text, session resets, note-off behavior, revoked/offline/stalled connections, credentialed wrapper upgrade migration and edited-file preservation. The authenticated read-only context route is boundary-limited and honors current settings/app access without marking read or consuming Claude Code/Codex notice claims.

A real `notify claude` command against a disposable HOME/profile returned pure JSON containing `systemMessage: "Clanker Chat · 1 unread"` and `hookSpecificOutput` with `hookEventName: "UserPromptSubmit"` and the new quoted-line instruction in `additionalContext`.

A separate native **OMP 18.15.0** RPC smoke used an isolated agent directory, a generated managed wrapper with its existing app credential, a throwaway inbox and a loopback synthetic provider. The real MCP inbox event produced the unchanged count notification. One owner request reached the provider with the hidden inbox note and unchanged text; native message start/end events carried `display:false` and `attribution:"agent"`. There was one provider request and the message remained unread. The synthetic provider returned a fixed response: this is native hook/transport proof, not real-model compliance or TUI visual placement. No real inbox, agent configuration, service or provider account was modified; disposable data was removed afterward.

## Hermes and OpenCode 2 quoted inbox notes, 2026-11-03

Hermes and OpenCode 2 now share the same `inboxNote` instruction as Claude Code, Codex and OMP: one short Markdown quote line with a backticked `Clanker Chat` label after answering the owner. This supersedes the earlier display-only limitation recorded above. Native count notices remain unchanged, arrivals never start another model turn, visible user text stays unchanged, and previews remain untrusted mention-only data.

Hermes follows Imprint's owner-turn approach: native `pre_llm_call` receives the original `user_message` and `conversation_history`; a per-session user-role count identifies the owner turn. Only its first eligible call can consume a displayed batch. A later arrival cannot attach during that turn's tool continuations. Subagents, parent-session/synthetic flags, harness text, known Clanker injections, slash/shell controls and messaging-platform sessions are excluded. The Python callback returns `{"context": text}`, which Hermes consumes as API-bound context—not shell-hook JSON stdout. The managed private connection file uses the existing app grant; context requests have a hard 500ms deadline.

Rechecking OpenCode 2 with the same practical standard found a usable path: prompt admission distinguishes stored user input from native synthetic/shell/compaction controls and supplies a stable message ID that survives into model context. The server matches that exact ID before injecting system context once. The unchanged TUI toast sends only its displayed boundary and a credential fingerprint over location-scoped host RPC; no preview or raw credential crosses that signal. Duplicate displays coalesce, child/foreign sessions and known synthetic/control sources are excluded, and off/offline batches cannot attach on later turns. OpenCode's owner-invoked prompt commands can expand into ordinary admitted prose without original slash metadata; those expanded prompts may qualify as owner work. This is practical origin filtering and per-turn deduplication, not human authentication.

Node.js 24 `npm ci --ignore-scripts` and the full `npm test` suite passed **152 tests**, with **0 failures, 0 cancellations, 0 skips and 0 todos**. The suite includes expanded `test/hermes_plugin_test.py` consumer/transport/lifecycle assertions, managed Hermes credential migration/removal, applicability metadata for all five hosts, OpenCode admission/context ID correlation and concurrent retries, duplicate TUI displays, settings/revocation/offline handling, late arrivals, raw controls and child-session exclusion. Existing discussion continuation and count-surface regressions remain green.

An isolated Hermes adapter-to-daemon smoke installed the actual managed plugin and credential into a disposable HOME, used its real watcher against a temporary inbox, and invoked the registered native callback contract. It posted **Clanker Chat · 1 unread**, returned context containing the shared quoted-line/safety instruction, returned no context on the repeated owner turn, and preserved the owner's text. The daemon still had **1 unread** and **0 hook claims**. The host context was a test consumer, not a native Hermes CLI: no runnable Hermes or OpenCode executable was found on PATH, so no new native-app rendering, actual OpenCode RPC transport, provider run or real-model sentence-compliance proof is claimed. Disposable files and dependencies were removed; no real agent configuration, inbox, service or account was changed.

## Host-specific inbox-note filters, 2026-11-03

Removed copied Claude/Codex/OMP harness-prefix lists from Hermes and OpenCode, including Codex delegation/environment wrappers, Claude limit/history notices, and Hermes's unused browser-comment, pasted-content and question-reply parsing. Text filtering now keeps only Clanker's own discussion/count prefixes, slash/shell controls, and OpenCode's source-backed native “You are a subagent spawned by another session.” prefix. Metadata/source/parent-session/subagent checks and turn/batch deduplication are unchanged. Comments cite the local notice producers and relevant host source; artificial cross-host prefix fixtures were removed, while structural synthetic-turn coverage remains.

Node.js 24 `npm ci --ignore-scripts` and the full `npm test` suite passed **152 tests**, with **0 failures, 0 cancellations, 0 skips and 0 todos**. Temporary dependencies were removed afterward. No real agent configuration, inbox or service was changed.
