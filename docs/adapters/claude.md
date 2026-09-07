# Claude Code: first implemented vertical slice

Install and use [@atape/adapter-claude](../../adapters/claude/README.md). The package
is production-path code loaded by the existing Collector; it is not a scratch
reader or an alternate uploader. Broader prototype expansion is paused under
[ADR-0029](../architecture/adr/0029-claude-first-vertical-slice.md).

On 2026-09-07 the package was built, installed and enabled through the real CLI.
It read the original 9,193-byte controlled native Claude 2.1.263 Session
`5f7e23bb-372f-4ca5-9fac-c3af52778fca`, not its reserialized test fixture, and sent
one Canonical batch plus one Raw chunk to an isolated loopback Go development
server. The existing Web conversation page displayed six events, including Read
completed/failed and `ATAPE_TOOL_DONE`. Its ordinary Raw drawer opened the source
snapshot. A second collection returned zero observations, batches and chunks.
No unrelated history was read and no configured remote instance received data.

Initial vertical-slice checks: eight Adapter tests (including linked-worktree ownership),
the real CLI/Go Claude and Codex end-to-end tests, six existing Codex Adapter tests,
31 CLI tests, TypeScript checks for Adapter/CLI/Web, and Go HTTP/Composition Root
tests. The native fixture was copied into the package's test fixtures, preserving
its existing path substitutions; it no longer depends on scratch prototypes.

The local demo required a generic bootstrap fix: its already explicit development
Principal now supplies the browser session response instead of returning 503.
No production authentication path was changed or credential issued. A separate
pre-existing demo Workspace response-shape mismatch still affects its sidebar
switcher; the Session and Raw direct routes were verified. Do not confuse this
ephemeral in-memory demo with a durable deployed installation.

Project-scoped automatic discovery is now implemented in the production Adapter.
After installation and Project enablement, normal `collect` no longer needs a
selected-file environment variable. It scans bounded headers under the Claude
home, uses original CWD / Git common-directory attribution, and stores incremental
progress for multiple Sessions in the existing Host checkpoint. The original
single-file override remains available. No server or view changes were needed.

Follow-on checks: 17 Adapter tests, 31 CLI tests, Adapter/CLI TypeScript checks and
both real CLI/Go end-to-end tests passed. The Claude end-to-end case now uses an
isolated Claude home without a selected-file override: one native-fixture Session
appears in the existing conversation/Raw/Search APIs; a foreign CWD is excluded;
a new Session and an appended answer produce two further observations; repeating
collection produces zero observations. Existing Event IDs remain stable. This
follow-on used synthetic native fixtures, not bulk uploads of local private history.

The next production slice implements bounded shared tool input/output under
[ADR-0030](../architecture/adr/0030-bounded-tool-details-implementation.md). The Host
validates and redacts ACP values, the v2 Canonical profile persists their encoded
JSON in current/version rows, and the existing conversation view shows collapsed
Input/Output details. Tool summaries remain the Search projection; full tool
values are not separately indexed. Claude refreshes old projections once using
higher projection revisions without changing Event IDs or source revisions.

Checks cover shared TypeScript/Go JSON vectors, Host credential masking, native
Claude extraction/oversize omission, legacy reprojection, PostgreSQL current and
version persistence across database reopening, escaped common view rendering,
and the real CLI/Go Claude+Codex pipeline. The end-to-end fixture includes synthetic
tool secrets and confirms they do not appear in Canonical or Raw responses.
Deploy the server/migration before the new CLI; this turn does not publish a package
or upgrade the user's running demo instance.

Compaction, ambiguous branches and large histories remain explicitly rejected
until their production support lands. Discovery capacity and unsupported-header
behavior are documented in the package README; this is not unrestricted Claude
archive compatibility.

## Delivery checkpoint

This increment contains the production Claude Adapter, Project discovery, shared
tool details, migration 000010 and the common reader integration. It is integrated
with main's narrative reading/index controls and larger Raw transport chunks; the
Claude source snapshot limit remains 4 MiB. Local research models are not shipped.

The first increment landed in PR #71. The next bounded increment implements
[source failure isolation](../architecture/adr/0031-source-failure-isolation.md):
healthy Sessions proceed while failed sources retain their checkpoints. Shared
redacted diagnostics reach one-shot CLI output and managed `partial` status, not
server data. Native-fixture CLI/Go tests cover mixed healthy/broken discovery,
nonzero partial exits, repair and incremental recovery without resets. Adapter
tests also cover duplicate identities, oversized sources, changed prefixes,
diagnostic limits and cancellation; existing Codex collection stays unchanged.

Source isolation landed in PR #73. The next increment adds Claude to the shared
release contract, packing/checksums, npm publication list and GitHub assets. Both
Adapters share the same installable-package verification; packaged CLI verification
now captures the native fixture and replaces a distinct-version test package with
the exact Claude release tarball. It verifies preserved cursor/Raw progress,
zero duplicate uploads and a later append. Package version alone is not a cursor
compatibility rule; schema and captured-prefix checks remain authoritative.

The upgrade fixture re-versions the current bundle, not a historical release, so
it proves package replacement/recovery mechanics only. No new old-version support
or real deployment is claimed. Remaining release work is the existing candidate,
staging/operations signoff and explicit publication/deployment workflow in the
[release guide](../releasing.md); unsupported Claude history shapes stay deferred.
