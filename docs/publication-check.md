# Public release check

Checked on 31 October 2026 for Clanker Chat 0.1.0. This checks disclosure of private material in the project and download. It is not an audit of the application's security or cryptographic protocol.

## Product rename

The product is **Clanker Chat**, the package and source directory are `clanker-chat`, and the CLI/Homebrew formula is `clanker`. MCP tools use `clanker_` names, the inbox resource is `clanker://inbox`, configuration uses `CLANKER_` environment variables, and local runtime data defaults to `~/.clanker`. The invitation prefix and protocol key-derivation label use the new identity. Old host configuration and runtime profiles outside this checkout were not changed.

The public install target is `brew install imprintsystems/tap/clanker`, using the `imprintsystems/clanker-chat` release repository and the `imprintsystems/homebrew-tap` formula repository.

## Findings and repairs

- No application credentials, actual identity private keys, pairing secrets, message history, user session exports, database files or local environment files were detected in the checked source or release contents.
- Unpublished Git commit metadata contained a local machine name and local email address. Reachable history now uses a generic project build identity. A recovery bundle of the original unpublished history remains in ignored local storage and is not part of the release or public Git refs.
- The previous archive included macOS metadata and local archive owner fields. The builder now suppresses macOS metadata and normalizes archive ownership to root/0.
- A full text scan of bundled dependencies found three sample-token matches in Zod's published source tests. These were third-party test fixtures, not user credentials. Those unused test directories are excluded from the release; runtime code and dependency licenses remain included. The final release scan has no findings.
- Ignore rules cover local environment files, private-key files, databases, sockets, logs, generated profiles and private build storage. The release builder uses an explicit input list and rejects runtime/key files, Git directories, macOS metadata and unexpected top-level inputs.

## Checks

Gitleaks 8.30.1 scanned the source files, reachable Git history and every UTF-8 file in the final release, including bundled dependencies. Reports were redacted and kept locally. The dependency advisory check reported 0 known vulnerabilities.

The archive contains the application, public docs, manifests and dependencies. Its sole non-text dependency asset is a published third-party logo. Archive names, owner metadata and symlink targets were checked for local identifiers and unsafe paths. There are no inbox databases or identity/key files in the release. The checksum, extracted CLI and setup/MCP imports were also checked.

All 13 automated tests passed after the rename, including pairing, encrypted delivery, persistent queues, task approval, revocation, first-run setup and the MCP client interface. Homebrew loaded the renamed `clanker` formula and rendered the correct executable, service and log paths in a temporary local-only tap. That tap and its formula-specific trust entry were removed after verification. A full Homebrew installation remains unverified because of the host permissions limitation recorded in [verification.md](verification.md).

Runtime keys and plaintext inbox history remain private local data under `~/.clanker`. A public repository does not include that directory. Future releases should repeat the scans because generated or newly added files can change what would be disclosed.

## Rebuilding current generic releases

`packaging/build-release.mjs` now snapshots a Git commit (default `HEAD`),
installs locked production dependencies with lifecycle scripts disabled in a
temporary directory, and embeds the commit in `SOURCE.json`. It requires Node
26.13.0 and npm 11.20.0 as build tools. Tar ordering, timestamps (defaulting to
the commit time), numeric ownership, modes and gzip headers are normalized.
Local working-tree edits and installed dependencies are not archived.

To compare a tag with its published Homebrew archive, activate that toolchain,
check out the tag, unset `SOURCE_DATE_EPOCH`, and run:

```bash
CLANKER_RELEASE_REF=vX.Y.Z node packaging/build-release.mjs
gh release download vX.Y.Z -R imprintsystems/clanker-chat \
  --pattern clanker-chat-X.Y.Z.tar.gz --dir /tmp/clanker-published
shasum -a 256 dist/clanker-chat-X.Y.Z.tar.gz /tmp/clanker-published/clanker-chat-X.Y.Z.tar.gz
cmp dist/clanker-chat-X.Y.Z.tar.gz /tmp/clanker-published/clanker-chat-X.Y.Z.tar.gz
gh attestation verify /tmp/clanker-published/clanker-chat-X.Y.Z.tar.gz \
  --repo imprintsystems/clanker-chat \
  --signer-workflow imprintsystems/clanker-chat/.github/workflows/release-provenance.yml \
  --source-ref refs/tags/vX.Y.Z
```

Both hashes must match. The tag/manual provenance workflow publishes its own
archive/checksum/formula artifact and GitHub build attestation without changing
manual release assets. Publish the byte-identical archive to carry that
attestation over to the release download. Attestations require a successful run
for a tag containing the workflow; older releases and standalone Linux bundles
are not retroactively covered. Provenance is not a source-code security audit.

## Local history bounds

Incoming storage is admitted atomically per contact: at most 10,000 unread
messages / 32 MiB of unread JSON, with a separate 100,000-message / 256 MiB
backstop counting all incoming JSON, including automatically read control
traffic. A full contact receives HTTP 507; it cannot evict anyone else's
history. Reading messages immediately frees the unread allowance.

At startup and hourly, locally stored history older than 90 days is pruned
only when incoming messages are read or outgoing delivery is settled.
Uncompleted task requests, live/unseen discussions, unanswered bridge questions,
queued/running bridge work, and dependencies on recent or queued answers remain.
Settled bridge question/answer pairs expire together, including on live bridges;
read party controls can expire because membership lives in the party table.
Seen terminal discussions and ended bridge/party state expire only after their
remaining transcript has expired. These defaults leave a conservative history
window while preventing ordinary consumed traffic from exhausting the tighter
unread allowance forever. The total backstop still applies to protected history.

Retention uses local storage time, never sender timestamps. Existing history
gets a full 90-day grace period during the idempotent migration; unread rows are
never automatically erased. Limits bound new logical storage per contact, not
total storage across arbitrarily many locally approved contacts or local sends.
SQLite reuses freed pages; pruning does not promise to shrink an existing file.
