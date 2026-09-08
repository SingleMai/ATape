# Production CLI terminal validation

- Date: 2026-09-08
- Scope: guided setup and Project console in the current working tree
- Status: implemented and locally verified; not published or deployed

## Candidate

Ink 7.1.1, React 19.2.8 and `@inkjs/ui` 2.0.0 are pinned. The CLI remains one
Node 24 ESM executable with no separately installed runtime dependencies. Its
four-file npm allowlist, shebang and 1 MiB compressed-artifact gate are unchanged.
The optional Ink DevTools exclusion and `createRequire` bridge are part of the
release build. Views use `createElement`, retaining native Node TypeScript dev
execution without a second TSX development loader.

The same local candidate was installed in an isolated npm prefix on each platform:

| Platform | Runtime | Result |
| --- | --- | --- |
| macOS arm64 | Node 24.18.0 | Installed terminal and package checks passed |
| Linux arm64, Debian bookworm container | Node 24.20.0 | Identical artifact, installed terminal and package checks passed |

- CLI ESM file: 2,139,659 bytes
- Compressed npm tarball: 424,582 bytes
- Candidate SHA-256: `ef4a2dea2fc3190be98eae2fbe688d82b3324d21660047f886027bcb2c53728e`

This is a development candidate carrying the repository version, not a published
release. Linux ran from `node:24-bookworm` with the package scripts and artifact
mounted read-only; the installed executable did not use host dependencies.

## Permanent acceptance checks

`pnpm test:cli-package` now invokes `apps/cli/scripts/verify-terminal.py` against
the installed binary. Python 3 is needed on the verifying macOS/Linux machine.
The fixture Instance, credentials, source package, directories and Collector
state are disposable. No user's configured Instance or local history is used.

The checks exercise:

- Real PTY directory completion with a Unicode/space directory, bracketed paste
  that cannot submit, and resizing from 80×24 to 38×12.
- Escape, Ctrl+C and SIGTERM, checking the complete terminal attributes and
  restoration of primary screen/cursor; signal termination may retain the
  conventional SIGTERM exit status.
- CI with a TTY, piped invocation, version and JSON without ANSI or input waits.
- Bare `atape` through real device-grant HTTP polling, zero Teams, opening the
  verified Web onboarding destination, then Refresh after a Team appears.
- Source selection and final review, proving local capture remains absent before
  confirmation. Completion starts the installed managed Collector and reaches
  the truthful empty-history state, “Waiting for a first conversation”.
- Reopening the Project console, updating source selection, and verifying that
  exiting the TUI leaves the independent Collector running.

The first terminal runs caught stale input during buffered key events. The text
control now updates its editing reference synchronously while React renders its
snapshot. Tests drain PTY output during shutdown so terminal flush backpressure
cannot be mistaken for a lifecycle hang.

Application tests separately cover explicit source authorization, interrupted
installation, retained directory registration, durable account-scoped creation
keys, source replacement, identity-safe global resume and distinguishing empty
history from an already captured Project after a zero-observation cycle. Shared
Git tests cover both Harness contracts, worktrees/clones/nested repositories,
changed origins, deleted directories, immutable evidence, aliases, authentication
failures and retry recovery.

`pnpm test:release` also passed for the CLI plus both first-party Adapters,
including Claude package replacement with retained capture progress. The existing
`pnpm test:e2e` CLI/Go tests passed for nonempty Canonical ingestion, Raw and Search;
they exercise the shared ingestion workflow, not a second TUI-specific uploader.

To verify a previously built candidate with the same checks, set
`ATAPE_VERIFY_CLI_TARBALL` when running `apps/cli/scripts/verify-package.mjs`.
This switch belongs to the verification script and is not a shipped CLI flag.

## Local-machine walkthrough

On 2026-09-08, the candidate was exercised again on the user's macOS arm64
machine with Node 24.18.0. The local executable and the installed candidate had
the same SHA-256:
`4818e0b81885bf9732d6dfef630e979bb5bdb8fce54a8b51a1b514bc8e8692e5`.
Native Terminal window automation was unavailable, so the walkthrough used a
local OS PTY, with real keystrokes and terminal-attribute restoration checks.

Using the existing local configuration and signed-in account, the walkthrough
opened the Project list, inspected a previously recorded transport failure,
opened source management and returned without applying changes. Adding the
current Git worktree successfully reached source selection and final review
using the live Instance's account and Team data. The walkthrough cancelled at
that review; it did not create a remote Project or upload personal history.
An intentionally nonexistent directory produced a recoverable error; Retry,
Escape and Ctrl+C worked. Project registrations and Collector status were
identical before and after the walkthrough.

A separate direct `curl` request failed during TLS connection, but the actual
CLI subsequently read live account/Team data successfully. That request and
the historical Collector failure do not establish a current CLI outage.

The following isolated checks also passed again on this machine:

- Installed candidate PTY acceptance: controlled device login, Web onboarding
  and Refresh, confirmed setup, source changes and background Collector lifetime.
- Both CLI/Go end-to-end tests: nonempty Codex and Claude Canonical ingestion,
  Raw and Search, using disposable source records and the real local Go server.
- All seven shared Git attribution tests using real Git repositories and the
  filesystem, including clones/worktrees, foreign repositories, changed origins,
  deleted directories, retry recovery and durable attribution evidence.

These checks found no new product defect. Live browser authorization and live
upload were not exercised by this walkthrough; the existing signed-in account
was used only through final review. Controlled login and ingestion checks remain
distinct from those unverified live operations.

## Limits

Full x64, Windows interactive terminals, SSH/tmux, physical terminal/font
combinations, IME composition and screen-reader acceptance remain unverified.
Unicode/paste tests are not a claim of full IME or accessibility coverage. A real
external browser-provider account was not used by the controlled login fixture.
Restart/login persistence is deliberately absent; users run `atape start` after
reboot. Git capture requires matching Host and Adapter capabilities, so release
of this CLI must include compatible first-party packages.
