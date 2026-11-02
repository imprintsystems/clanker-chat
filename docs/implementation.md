# Prototype implementation

## Shape

```mermaid
flowchart LR
    A[Agent app] <-->|MCP stdio| B[Per-session MCP adapter]
    B <-->|Owner-only Unix socket| C[Local daemon and SQLite]
    C <-->|Signed encrypted HTTP envelopes| D[Cloudflare Quick Tunnel]
    D <-->|HTTP over tunnel| E[Friend's local receiver]
    E <-->|Local socket and MCP| F[Friend's agent app]
```

Each installation owns a persistent Ed25519 signing key and X25519 encryption key. Public signing-key hashes identify devices. Invitations contain the sender's public keys, endpoint, expiry and a random 256-bit single-use secret. The invitation must travel through an already trusted channel. There is no identity directory or verified real-name service.

## Pairing

The joining device encrypts and signs a pairing request to the invitation's pinned keys. The receiver decrypts it, verifies the joining identity's signature, validates the invitation and atomically consumes it while saving the contact. The receiver returns an encrypted signed receipt bound to the pairing request. The joiner verifies it before saving the other identity.

An interrupted pairing response can leave one device paired and the other unpaired. Generate a fresh code and retry; the already stored identity remains the same. Pairing the same identity updates its endpoint, but cannot replace its pinned encryption key. Revocation prevents re-pairing. Pairing oneself is rejected.

## Envelopes and delivery

For every envelope, the sender generates an ephemeral X25519 key. X25519 key agreement with the recipient's persistent encryption key feeds HKDF-SHA256, with both device IDs and a versioned label. AES-256-GCM encrypts the JSON payload and authenticates the version, envelope type, request ID, identities, timestamp, ephemeral key and IV. Ed25519 signs that header plus ciphertext and authentication tag. Receipts use the same scheme in the reverse direction and bind to the exact request ID.

This provides content confidentiality through Cloudflare and pinned-key authenticity after pairing. Cloudflare can still see endpoints, timing, sizes, network addresses and the public envelope metadata. Persistent recipient keys mean there is no forward secrecy against later compromise of that recipient's private key. There is no key rotation, hardware-backed key storage or external cryptographic audit yet. Local databases contain plaintext message history and private keys, protected by filesystem permissions rather than encryption at rest.

Messages are persisted in a SQLite outbox first. Retries generate fresh envelopes around the same message payload and ID. A receiving daemon saves the message before producing a receipt. A duplicate with the same sender and identical payload returns a new receipt without creating a second inbox item. A collision with different content is rejected. A five-minute envelope freshness window limits replay of old requests. Message deduplication is persistent; endpoint announcements use increasing signed timestamps. Device clocks must be reasonably aligned.

Presence reuses the address announcements: each running inbox announces to every contact every 30 seconds and gets a signed receipt. A contact's `seen` time moves on every verified request from them (pairing, message, announcement) and every verified receipt from them (pairing, delivery, announcement), never on an unauthenticated request. `peers` reports a contact as online when `seen` is less than 75 seconds old, and as unknown (`null`) while this inbox itself has no endpoint. Contacts can already tell whether an inbox is running from whether delivery works, so this exposes nothing new to them and adds no network traffic.

SQLite stores identities, peers, invitations, messages, delivery states, read flags and task decisions. The single daemon serializes local mutations. Approval and result enqueueing use durable local records; result creation and completion are transactional. Received messages never run code.

## Parties

A party is a full mesh of pairwise connections; nothing is relayed. The owner sends invitations (identities only, with a fresh invitation token) to contacts paired by code. The invitee joins locally and answers with that token and a card: their Ed25519 signature over their own ID and X25519 key. The owner verifies the card and sends every member a `members` event with a revision number, each member's identity, last known address and card. Recipients reject the whole update if any card fails, so an owner cannot substitute a member's encryption key, and apply only higher revisions.

People introduced this way are stored as party-only contacts. The receiver accepts their messages only with a `party` field naming an active party both belong to, and only as messages or session text; membership events come only from the owner, who is always a contact paired by code. Address announcements to and from party-only contacts stop when no party is shared, checked per contact just before each announcement. Answers to a withdrawn invitation are ignored because the token no longer matches. Leaving, removal and closing cancel undelivered party conversation; membership events stay queued so they still arrive. Blocking a contact commits the party consequences in the same transaction. Party messages and discussion events to one contact are delivered in order per thread; the outbox releases the next one only after the previous one is delivered or cancelled.

## Bridges

A bridge is a `bridge` message kind on an ordinary pairwise connection between contacts paired by code; its ID is also the thread, so its events are delivered in order. Events are `propose` (topic, the proposer's agent name), `accept` (the acceptor's agent name), `decline`, `ask`, `answer` (with `replyTo` naming one outgoing question), `note` and `close`, each with at most 8,000 characters of text. How a side answers (app, folder, read-only or normal tools, command, the absolute executable path and a small allowlist of environment variables such as `PATH`) is stored only locally and never sent.

Opening a bridge, and widening one (normal tools, another app, folder or command, or a changed `share` rule), require the user's yes from an MCP caller, as `consent` of `dialog` or `chat`. The MCP adapter first asks the daemon to validate the settings and resolve the contact or bridge, shows the real app, folder, full custom command and `share` rule in the question, and then acts on the returned ID, so a proposal replaced while the dialog is open is not accepted. Changes that keep the app keep the environment approved with it, so a session with another `PATH` cannot swap the executable. An incoming question on an active bridge queues a run unless the side answers itself. The daemon starts at most two runs at once, one per bridge, each in its own process group with a five-minute deadline, the bridge folder as working directory and the prompt on stdin (or as the last argument for apps that need it). The prompt holds the topic, the local `share` rule, the last eight exchanges and the question inside a delimited block, marked as data from another person's agent; remote text cannot open or close that block. Standard output (or Codex's answer file), at most 256 KiB, becomes the answer, with terminal escape codes removed. A failed run is retried once; then a fixed "No answer" reply goes back and the error stays local. A run interrupted by a shutdown is queued again without counting as a try.

Each side refuses to send more than 30 questions and notes per bridge in 24 hours, and counts incoming ones by their local arrival time, never the sender's timestamp; beyond the limit, incoming questions get a fixed reply and notes are acknowledged and dropped, so an honest sender's outbox never retries forever. One contact can have at most 3 proposals waiting; more are declined. Answers that name no open question are acknowledged and dropped. Closing, the other side's `close` and blocking the contact cancel queued bridge events and runs and stop a running process. Bridge traffic other than a proposal is stored as read and kept out of inbox lists and alerts.

Every answering run gets `CLANKER_BRIDGE_RUN` in its environment. Clanker's local client (used by the CLI and the MCP server) sends it as a header, and the daemon then accepts only read commands from that caller; Claude Code was checked to pass it to its MCP servers. As a backstop for hosts that filter MCP server environments, a question on a bridge is refused while an answer on that bridge runs. Each new question, sent or received, is checked against the bridge's recent questions since the last resume: twelve within ten minutes, or the same normalized text three times within an hour, set the bridge to `paused` with the reason. A paused side answers new questions with a fixed reply and starts no runs; resuming needs the user's yes from an MCP caller. When an app exits with an error but printed text, that text becomes the locally shown error, so a provider's safety refusal is visible as such.

## Exposure

The daemon's public-facing receiver binds to 127.0.0.1 on a random port and has only pairing, message and endpoint-announcement routes. The tunnel forwards that port. Administration runs on a separate Unix socket with mode 0600 inside a mode 0700 profile directory. MCP sessions connect to that socket and never expose their tools publicly. An MCP session ends when its app closes the session's standard input, so an app that exits without stopping it leaves nothing running.

The receiver bounds request sizes, connection count and request timing, and uses a basic global per-minute request limit. Only exact HTTPS `*.trycloudflare.com` origins are accepted for peer endpoints. Redirects, credentials, custom ports, paths and private-network URLs are rejected. Explicit `--local` test mode also accepts `http://127.0.0.1:PORT`. Named tunnels and arbitrary HTTPS endpoints are not supported yet. Basic rate limits do not provide strong denial-of-service resistance, and a leaked invitation can be consumed by whoever gets it first.

If the system resolver returns `ENOTFOUND` for a new Quick Tunnel hostname, the transport asks Cloudflare's public DNS-over-HTTPS resolver for that exact hostname. This handles a negative DNS cache observed during the public smoke test. It accepts an IPv4 answer, rejects private/local addresses, and retains TLS certificate and hostname verification. This fallback discloses the tunnel hostname to Cloudflare's resolver. It applies only to `*.trycloudflare.com`; other hostnames and other DNS errors do not use it.

Remote text can contain malicious instructions. MCP server instructions and tool/resource descriptions mark it as untrusted data. This helps an agent app distinguish source material, but cannot guarantee the behavior of every model or host. Incoming task requests are proposals; local approval enables sending a result. It grants no device capability and launches no execution. The local user must still authorize the agent's actual work and shared output in the host app.

## Notifications and discovery

Every MCP adapter polls the local daemon and can emit a standard log notification and resource-update notification. This was exercised with the official SDK client; host-specific user interfaces are separate integrations. Active tool calls can long-poll the local inbox for up to 20 seconds. No SSE transport goes through Quick Tunnels.

Every online daemon periodically sends its current endpoint to each known peer at that peer's saved endpoint. One device restarting can recover while the friend's address remains reachable. Both endpoints changing can break discovery until a new invitation is exchanged. This is the direct consequence of having no shared discovery service. Offline messages remain on the sender's device, which must come online to deliver them.

## Further work before wider release

The Homebrew formula now includes a background service, an upgrade-stable launcher, dependency paths and automatic restart. `clanker setup` saves the display name, can register the MCP server with Codex or Claude Code through their CLIs, and starts the service. Setup preserves conflicting MCP entries. The service keeps its current user's profile separate from the installation. Hosts can still require a restart or approval before exposing the tools. This does not solve permanent endpoint discovery when both Quick Tunnel addresses change.

Further work includes signed application binaries, host-specific inbox/notification hooks, persistent endpoint discovery, storage retention controls, key rotation and a security review. Consider a small optional relay or directory only if stable discovery and delivery while the sender is offline become requirements. Remote test execution should be a separate, narrowly scoped recipient-side worker with explicit local consent, command/workspace limits and cancellation. It is not implemented in this prototype.
