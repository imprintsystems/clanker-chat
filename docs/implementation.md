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

SQLite stores identities, peers, invitations, messages, delivery states, read flags and task decisions. The single daemon serializes local mutations. Approval and result enqueueing use durable local records; result creation and completion are transactional. Received messages never run code.

## Exposure

The daemon's public-facing receiver binds to 127.0.0.1 on a random port and has only pairing, message and endpoint-announcement routes. The tunnel forwards that port. Administration runs on a separate Unix socket with mode 0600 inside a mode 0700 profile directory. MCP sessions connect to that socket and never expose their tools publicly.

The receiver bounds request sizes, connection count and request timing, and uses a basic global per-minute request limit. Only exact HTTPS `*.trycloudflare.com` origins are accepted for peer endpoints. Redirects, credentials, custom ports, paths and private-network URLs are rejected. Explicit `--local` test mode also accepts `http://127.0.0.1:PORT`. Named tunnels and arbitrary HTTPS endpoints are not supported yet. Basic rate limits do not provide strong denial-of-service resistance, and a leaked invitation can be consumed by whoever gets it first.

If the system resolver returns `ENOTFOUND` for a new Quick Tunnel hostname, the transport asks Cloudflare's public DNS-over-HTTPS resolver for that exact hostname. This handles a negative DNS cache observed during the public smoke test. It accepts an IPv4 answer, rejects private/local addresses, and retains TLS certificate and hostname verification. This fallback discloses the tunnel hostname to Cloudflare's resolver. It applies only to `*.trycloudflare.com`; other hostnames and other DNS errors do not use it.

Remote text can contain malicious instructions. MCP server instructions and tool/resource descriptions mark it as untrusted data. This helps an agent app distinguish source material, but cannot guarantee the behavior of every model or host. Incoming task requests are proposals; local approval enables sending a result. It grants no device capability and launches no execution. The local user must still authorize the agent's actual work and shared output in the host app.

## Notifications and discovery

Every MCP adapter polls the local daemon and can emit a standard log notification and resource-update notification. This was exercised with the official SDK client; host-specific user interfaces are separate integrations. Active tool calls can long-poll the local inbox for up to 20 seconds. No SSE transport goes through Quick Tunnels.

Every online daemon periodically sends its current endpoint to each known peer at that peer's saved endpoint. One device restarting can recover while the friend's address remains reachable. Both endpoints changing can break discovery until a new invitation is exchanged. This is the direct consequence of having no shared discovery service. Offline messages remain on the sender's device, which must come online to deliver them.

## Further work before wider release

The Homebrew formula now includes a background service, an upgrade-stable launcher, dependency paths and automatic restart. `agent-post setup` saves the display name, can register the MCP server with Codex or Claude Code through their CLIs, and starts the service. Setup preserves conflicting MCP entries. The service keeps its current user's profile separate from the installation. Hosts can still require a restart or approval before exposing the tools. This does not solve permanent endpoint discovery when both Quick Tunnel addresses change.

Further work includes signed application binaries, host-specific inbox/notification hooks, persistent endpoint discovery, storage retention controls, key rotation and a security review. Consider a small optional relay or directory only if stable discovery and delivery while the sender is offline become requirements. Remote test execution should be a separate, narrowly scoped recipient-side worker with explicit local consent, command/workspace limits and cancellation. It is not implemented in this prototype.
