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
