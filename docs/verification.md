# Verification, 31 October 2026

Environment: macOS arm64, Node.js 25.9.0, npm 11.12.1. Official MCP SDK 1.32.2 and Zod 4.6.7 are pinned in the lockfile. The live test used cloudflared 2026.10.7, downloaded from Cloudflare's GitHub release and checked against its published SHA-256 asset digest. No system-wide installation was made.

## Automated suite

`npm test`: 13 tests passed, 0 failures, 0 skipped after the Homebrew setup changes.

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
