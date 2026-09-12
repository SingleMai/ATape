# ADR-0037: Shared Git Source Attribution

- Status: Accepted; implemented and locally verified, integration pending
- Date: 2026-09-08
- Current feature guide: [CLI user journey](../../cli/user-journey.md)

## Context and alternatives

Codex currently accepts lexical descendants or a privately normalized remote;
Claude compares Git common directories. These rules disagree on independent
clones and can attach nested unrelated repositories or a changed origin to the
wrong Project. Users approved Git identity, not a selected folder, as the capture
boundary. A source's original identity must remain stable across `/cd`, relocation
and deletion of its original checkout.

One alternative is a shared TypeScript normalizer plus a downloaded repository
alias set. That duplicates the Go normalization contract and requires a new alias
API and freshness policy. Another is to let each Adapter resolve the server's
Project itself, which exposes credentials and distributes authorization policy.

## Decision and Interface

A deep application Git Source Attribution Module resolves an original source to
`included`, `excluded` or `unknown`. Both first-party Adapters use the Host's
versioned `atape.git-attribution.v1` callback. Adapters supply a stable source ID,
original CWD, immutable origin key and optional source-recorded remote. The
callback owns Git lookup, authoritative matching, metadata persistence and errors.
It never receives or returns conversation bodies or bearer credentials.

- The existing authenticated Project match endpoint is authoritative for protocol
  equivalence, host/path case rules and historical aliases. Match requests pin the
  configured User, Team and Instance. Only an active exact match for the configured
  Project can be included. No second client-side normalization is introduced.
- Source-recorded Git metadata takes precedence over a live CWD. Without it, the
  Host resolves the original CWD's nearest repository and origin. Missing CWD,
  missing/invalid origin or conflicting immutable source evidence yields unknown.
  A known different repository is excluded without becoming a source failure.
- Confirmed evidence is written to a private metadata-only store, scoped by
  Instance/User/Project/local registration timestamp/Adapter/source ID. It records
  the original source key, CWD and remote, not a claim that ingestion completed.
  Its saved remote is matched again against the server on subsequent collection.
  Atomic create-if-absent preserves the first evidence under concurrent collectors;
  incompatible evidence is never overwritten. Publication failures do not advance
  the Collector cursor, and evidence persistence is not a capture checkpoint.
- Successful lookups are bounded and cached only within a collect call. Failures
  are not cached across retries. Network/authentication errors fail the job rather
  than being reported as an unknown source. Unknown attribution becomes a bounded
  local `attribution` diagnostic while other sources can continue.
- Configured Git paths are locators, not required live directories for capture.
  Repeating authenticated setup from a clone/worktree updates the locator and
  verified display metadata while retaining registration time, enabled sources
  and checkpoint identity. Explicitly selected sources may be added; an omitted
  selection never disables existing sources.
- New setup stores optional server repository identity in config v2. Old v2
  configs remain readable; capture resolves against their existing authoritative
  Project ID, without reinterpreting the configured path as authorization. Old
  cursor formats remain readable and retain their progress, but are not treated
  as proof of trustworthy Git attribution. Codex v3 adds an optional last-completed
  Canonical Session marker so newly attributable history behind the watermark
  completes Canonical before its first Raw acknowledgement. Idempotent Canonical
  replay is allowed; no conversation cache or new ingestion contract is added.
- Git directories cannot be configured using `--type directory`. Existing
  directory configurations whose locator is now inside Git fail with guidance to
  reconnect as Git, rather than silently retaining path-based Git capture.
- Git-capable packages declare the new attribution capability. New Hosts reject
  Git capture by older packages before importing them; new first-party packages
  reject Git capture on older Hosts without the callback. Ordinary directory
  capture keeps its existing Interface. No version number is used as a proxy for
  a capability, and Adapters remain independently distributed.

The filesystem evidence store and Git locator are local-substitutable Adapter
Seams; the owned HTTP match endpoint is a remote Seam. Tests use real filesystem
and Git plus a controlled remote Adapter. Source interpretation remains in the
Harness Adapter, while authorization and evidence ordering have one Implementation.
Deleting this Module would redistribute these rules across every Harness, reducing
Depth and Locality. Its small decision Interface gives Adapters Leverage without
exposing credentials, configuration paths or server transport.

## Consequences and validation

Git capture now needs the match API as well as ingestion. Bounded call-local
caching reduces repeated CWD/remote work without indefinite authorization caching.
Matching sends remotes to the configured Instance; local CWDs stay local. Unknown
history is not guessed, and a lost evidence store cannot recreate facts absent
from provider records. Existing historical uploads are not deleted or reassigned.

Validated through public Interfaces: cross-clone/worktree setup, preserved checkpoint
identity and sources, shared matching of both Adapters, changed origins, nested
repositories, source-recorded metadata after directory deletion, established
evidence after restart, unknown historical sources, server aliases, credential
changes, retryable failures, capability mismatch and unchanged directory capture.
The installed CLI/Adapter release suite and existing CLI/Go directory end-to-end
suite also pass. Canonical, Raw and Search contracts remain separate and unchanged.
The metadata store is adjacent to the Collector state file in
`<state-file>.git-attribution/`; reads reject symlinks and oversized/invalid files,
and writes use owner-only, fsynced atomic create-if-absent publication. No new
server migration or repository alias API is required.
