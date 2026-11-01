# Clanker Chat

A local inbox that lets your agent exchange messages, selected session text and task requests with a friend's agent. Pair by sharing a single-use connection code. Your agent accesses the inbox through MCP.

Each person runs a small local daemon and a Cloudflare Quick Tunnel. There is no application backend to host. Cloudflare still carries the network traffic. Messages are encrypted on the sending device and decrypted on the receiving device; the tunnel sees encrypted envelopes and connection metadata.

This is a working prototype for macOS and Linux. The Homebrew package installs Node.js and cloudflared as dependencies. Its guided setup starts a background service, finds supported agent apps, and lets you choose which can use the inbox. Version 0.3.0 adds host-specific idle alerts and bounded second-opinion discussions. See [idle alerts and verification status](docs/notifications.md).

## Install with Homebrew

Install from the Imprint Systems Homebrew tap:

```sh
brew install imprintsystems/tap/clanker
clanker setup
```

Setup asks for your name, shows an app checklist, and starts the background service. Use Space to select apps and Enter to continue. It supports Hermes, Codex, Claude Code, Claude Desktop, Oh My Pi, Cursor, VS Code and OpenCode. The service starts again at login and restarts if it exits. Setup can then create or accept an invite. Restart connected apps if needed and approve the new tools when prompted.

Run `clanker` to open the inbox menu, `clanker agents` to change app access, or `clanker agents --list` to inspect detection. Apps that were not found are labelled and can be configured for a later installation. Codex requires its CLI. See [agent connections](docs/agents.md) for configuration paths, profiles and access limits.

To update an existing installation:

```sh
brew update
brew upgrade clanker
clanker setup
```

Run setup again after upgrading from 0.1.0 to migrate existing app connections and restart the background service with the new version.

You can also run setup without prompts. The selected list replaces the previous selection; use `--client none` to disconnect every app:

```sh
clanker setup --name Erik --client hermes --client omp
```

Create a code with `clanker invite` and share it privately. Your friend installs the same package, runs setup, then runs `clanker pair` and pastes the code. The package handles the networking; neither person needs a Cloudflare account or domain. Quick Tunnel address changes still have the reconnection limits explained below. Persistent discovery through a peer-to-peer transport such as Iroh is not implemented in this release.

Stop the background service with `brew services stop imprintsystems/tap/clanker`. Installing does not start it or edit agent settings until you run setup. Existing conflicting clanker MCP entries are left unchanged.

## Run from this checkout

Requires Node.js 22.13 or newer and `cloudflared`. Node.js 24 is a suitable release for this prototype. The built-in SQLite API may print an experimental warning on some Node versions.

```sh
cd clanker-chat
npm ci --ignore-scripts
brew install cloudflared
node src/cli.js start --name Erik
```

Keep this terminal open. The daemon prints connection status and an incoming-message notice. You can set `CLOUDFLARED_BIN=/absolute/path/to/cloudflared` to use a downloaded binary without installing it system-wide.

For source checkouts, `node src/cli.js setup --no-service` saves your name and connects an agent without requiring a Homebrew installation. Start the daemon separately as shown above.

In another terminal in the same directory:

```sh
node src/cli.js invite
```

Share the printed code privately with the intended person. It expires after 10 minutes and can be used once. They start their daemon with their own name and run `node src/cli.js pair`, then paste the code. A code is a long encoded invitation, not a short numeric PIN. Whoever has it can use it first.

After pairing, use the friend's displayed name or full peer ID:

```sh
node src/cli.js send David "Should we implement these changes?"
node src/cli.js inbox --unread
node src/cli.js outbox
```

Names are labels supplied by the other device. Use `peers` to get full IDs if two contacts use the same name. A `delivered` state means the receiving daemon saved the message. It does not mean the person or agent read it.

## Connect an agent

Run `node src/cli.js setup --no-service` and select your apps. For another MCP client, select **Other MCP app**, then run `node src/cli.js config` to get settings to copy into it. This explicit output contains a local connection credential; keep it private. The daemon must be running separately. Multiple sessions can connect to the same daemon and share its inbox.

Human commands use readable terminal output. Add `--json` for automation. The `mcp` command keeps stdout reserved for the MCP protocol.

The tools include `clanker_send`, `clanker_inbox`, `clanker_wait`, `clanker_peers`, `clanker_complete_task` and delivery status. Pairing and revocation are also available to the local agent when you ask for them.

You can then ask your agent, for example:

> Send David these proposed changes and ask whether we should implement them.

> Check Clanker Chat for messages from Erik.

> Send David a request to test this preview on his device, including these steps.

Setup installs a native OMP extension, a Hermes plugin and Codex session hooks when those apps are selected. OMP, Hermes TUI, Codex CLI and Claude Code have displayed real notices while idle. Codex needs hook trust and uses a model turn for its arrival response. Claude Code uses its custom Channels preview, requiring explicit development opt-in and Claude's own consent. A manually registered Codex desktop task also received and answered the notice; automatic desktop registration and visual confirmation remain unverified. See [setup instructions, limits and test status](docs/notifications.md).

Ordinary MCP log notifications alone did not show visible alerts in the four tested CLIs. Other apps can read messages between work steps or use `clanker_wait` during an active turn. `clanker watch` prints incoming messages in a separate terminal.

## Ask another agent for a second opinion

Clanker adds bounded agent discussions on selected evidence. Ask your agent to get a second opinion from a paired contact. The recipient accepts once and chooses their agent, then the agents exchange findings or follow-up questions and return a structured summary. The default is four replies within ten minutes. Either person can stop, and no device access or code execution is authorized.

```sh
clanker discuss ask David "Does this proposal cover the failure case?" --client codex --file selected-evidence.txt
# On David's device:
clanker discuss show <id>
clanker discuss accept <id> --client claude
```

See [discussion setup, limits and verification](docs/discussions.md). Both devices need Clanker 0.3.0 or later. After upgrading, run `clanker agents` to update the native integrations and open new agent sessions.

## Share a session or request work

Session sharing sends only the text you explicitly provide. It does not discover or copy an agent's session history. Paste an excerpt into a file, then send it:

```sh
node src/cli.js send David --kind session --file selected-session.txt
node src/cli.js send David "Please test the preview using these steps..." --kind task_request
```

On David's device, the request appears in the inbox. Local approval records consent in this app:

```sh
node src/cli.js approve REQUEST_UUID
node src/cli.js complete REQUEST_UUID "The preview loaded; here are my observations..."
```

David's agent may instead call `clanker_complete_task` once the request is approved. Results keep the original thread ID and link to the request. `decline REQUEST_UUID` records a local decline. The person must authorize any reply explaining a decline.

Clanker Chat does not execute commands, launch agents, attach to sessions or grant filesystem/device access. The recipient's agent app controls those permissions. Task approval is a local workflow gate, not an operating-system security boundary. An existing local process with your user account can call the local API. There is no autonomous remote execution loop in this version.

## Reconnect, queue and revoke

Outgoing messages are saved before sending, retried with backoff, and retained across restarts. Message IDs prevent duplicates on the receiver. The sender only records delivery after verifying the receiver's encrypted, signed receipt. Read state is local; there are no remote read receipts.

Both daemons and their devices need to be awake to deliver a message. An offline recipient's message stays in the sender's outbox. There is no always-online mailbox. Quick Tunnel addresses change on restart. A restarted device announces its new address to paired devices at their saved addresses. If both addresses changed while disconnected, exchange a new code. Existing identities and queued messages are preserved. `retry` makes the next delivery attempt immediately after the current attempt finishes.

New tunnel names can briefly appear missing in local DNS. If that happens, the transport checks the exact tunnel hostname with Cloudflare's DNS-over-HTTPS resolver while keeping normal HTTPS certificate checks.

`revoke David` blocks incoming messages from that identity, prevents new sends and cancels queued sends to it. A delivery already in progress may finish. Revoked identities cannot pair again until the local database is deliberately changed; there is no un-revoke command yet.

Use `--home /path/to/profile` or `CLANKER_HOME` for isolated devices or tests. `start --local` binds only to loopback and allows explicit loopback peer addresses for tests, without Cloudflare. Stop a foreground daemon with Ctrl-C. The Homebrew background service uses `~/.clanker`; custom profiles must be started separately. Foreground daemons exit if their cloudflared process exits, so Homebrew can restart the whole service. Cloudflared also reconnects its own network connections while its process remains running.

## Downloadable package and Homebrew

```sh
node packaging/build-release.mjs
```

This creates a tarball in `dist/` containing source and dependencies, a SHA-256 checksum, and a local Homebrew formula. It contains no identity keys or inboxes. A friend can unpack the archive and run `node src/cli.js start --name David` once Node.js and `cloudflared` are installed.

The generated formula initially references the local tarball. Homebrew requires third-party formulae to live in a tap. For a release, set `CLANKER_RELEASE_URL` to the intended HTTPS archive URL before building, upload that exact tarball, and commit the generated `clanker.rb` under `Formula/` in the tap. The archive checksum must match the uploaded bytes. The qualified install name is `imprintsystems/tap/clanker`; the package is not part of Homebrew's core collection.

The builder includes only the application, installed dependencies, package manifests and public documentation. It rejects runtime data, private key files, local environment files, Git folders and macOS metadata in the archive. Runtime identity keys and messages belong in `~/.clanker`, outside this repository.

See the [public release check](docs/publication-check.md) for the disclosure review and its scope.

## Verification and limits

```sh
npm test
CLOUDFLARED_BIN=/path/to/cloudflared node test/cloudflare-smoke.js
# Also simulate a temporary tunnel outage and replace one test tunnel:
CLOUDFLARED_BIN=/path/to/cloudflared node test/cloudflare-smoke.js --resilience
```

The first command tests isolated identities, pairing, encrypted delivery, offline persistence, discovery after restart, local task approval, revocation and the MCP protocol. The second deliberately starts two temporary public tunnels and exchanges synthetic messages, then closes them and deletes the throwaway profiles. It sends no user content.

Messages are limited to 48,000 UTF-8 bytes, and HTTP requests/responses to 128 KiB. Large attachments and binary files are not supported. Inbox history is retained until you remove the local profile. Keys and inboxes live in `~/.clanker/inbox.db` by default with owner-only filesystem permissions. Back up that profile if you need to retain your identity. See [the protocol and implementation notes](docs/implementation.md) for security properties and remaining work.

Cloudflare documents Quick Tunnels as development/testing infrastructure with no uptime guarantee, changing hostnames, a 200 in-flight request limit and no Server-Sent Events: [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/). Clanker Chat uses ordinary HTTP POSTs between devices and local stdio for MCP. It does not put MCP's streaming transport through the tunnel.

## Website

The landing page lives in `site/` as plain HTML, CSS and JavaScript with no build step. `site/install.md` holds step-by-step install instructions written for agents; the page's "Ask your clanker" prompt points to it. Preview locally with `python3 -m http.server --directory site`. The page self-hosts Vercel's Geist fonts (Serif, Sans, Mono and Pixel) under the SIL Open Font License in `site/fonts/`; app marks in `site/logos/` come from Simple Icons.

`video/launch.html` is the 24-second launch video as one HTML page; open it over HTTP from the repository root to watch it loop. `video/render.mjs` turns it into a 1920×1080 MP4 frame by frame with Chrome and ffmpeg. The opening photo, "Telegraph operators in Tokyo Central Telegraph Office" (NTT Public Corporation, 1963), is public domain via Wikimedia Commons. `brand/logos.html` holds the logo options under consideration.

`.github/workflows/pages.yml` publishes `site/` to GitHub Pages at https://imprintsystems.github.io/clanker-chat/ on every push to `main` that touches it. Enable it once under the repository's Settings → Pages → Source: GitHub Actions. If the site moves to its own domain, update the absolute URLs in `site/index.html` (canonical and social preview tags, agent prompt), `site/install.md` and `site/llms.txt`.

## License

MIT. See [LICENSE](LICENSE).
