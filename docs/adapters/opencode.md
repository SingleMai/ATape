# OpenCode Adapter

OpenCode is available in ordinary Tools selection, installation and upgrade flows.
Its read-only SQLite Adapter uses the Host-owned source-capture capability:
complete Canonical targets activate atomically, while Raw recovers independently.
The [package README](../../adapters/opencode/README.md) owns installation and source
path configuration.

## Supported source and enablement

The accepted source is **OpenCode 1.18.30 local v1 SQLite on macOS arm64 and Linux
arm64/glibc**, with Node.js 24 or later. Other versions, architectures, nonempty
v2/mixed history, JSON-only history and remote servers have no support claim.
Source schema, indexes, creation Origin and family checks still apply within the
supported version. The Adapter never migrates source history or invokes OpenCode
or an export fallback.

Add OpenCode to the existing selection in **Tools and updates**, then review the
affected Projects. Tools apply globally to connected Projects; installing a
package alone does not enable capture. The receiving Server must advertise
`atape.publication.v1` with configured limits. The base Compose topology leaves
publication disabled; operators use the [rollout procedure](../operations/opencode-rollout.md).
A package upgrade does not authorize Server deployment or database migration.

## Source identity and projection

Source reads preserve database and WAL content; SQLite may update SHM lock
metadata. Setup performs metadata-only detection, which is not evidence that a
database is readable or supported. Default paths and `OPENCODE_DB` semantics are
in the [package guide](../../adapters/opencode/README.md#source-and-attribution).

Immutable creation Origin determines Project attribution. Shared Host Git
matching handles worktrees and independent clones; foreign repositories are
excluded, and an unknown Origin remains a diagnostic. Later directory changes
cannot move captured history. Native root Session IDs own source identity;
children become Threads, and forks retain their copied prefix under distinct
native identities. Unprovable families are not silently assigned to a Project.

Projection selects the active conversation path, including rewind and compaction
within the supported source layout. Changed membership becomes visible only on
activation, so reader and Search do not mix old and new targets. Tool values and
usage use shared Canonical representations; unknown parts and unsupported media
retain explicit partial fidelity. Copied fork usage describes captured history,
not proof of newly incurred spend.

## Capture, recovery and Raw

The [capture contract](../architecture/opencode-capture-publication.md) defines
ownership, identity, publication and recovery; the
[Server Interface](../architecture/publication-candidates.md) defines reservation,
staging, validation, activation and read consistency.

The Collector compares a bounded source view before allocating fresh capture
metadata. Unchanged history does no content upload. For changed history it freezes
validated, redacted delivery bytes in the account-bound journal before sending
content. Restart recovery uses those bytes and actual receipts instead of
rereading a mutable source. Canonical activation advances source coverage;
Raw acknowledgements record separate progress.

With Raw disabled, the Host does not save complete source JSON for later archival.
Re-enabling Raw can archive fresh observations still present in the source, but
cannot rewrite existing Canonical provenance just to add a Raw link. Old Raw
obligations can recover after a newer Canonical head; unknown receipts are not
acknowledgements. Session archives are paged through the separate Raw API.

Preserve CLI state and its bound journal. Missing established journals, owner
mismatches, corrupt state, unknown remote outcomes and disk exhaustion fail
explicitly; deleting state is not a recovery procedure. Capacity failures retain
the prior published head and pending obligations. Safe cleanup retires superseded
membership and proven-unneeded content while retaining identity and receipts.
It does not imply secure erasure or constant storage for unlimited history.

Package replacement preserves progress. A changed package version may require a
local Raw packing/admission observation; matching receipts are reused. Installed
upgrade tests use the current bundle under another version and do not establish
arbitrary old-binary compatibility.

## Bounds and support limits

The CLI supplies `defaultSourceCollectionLimits`; users need no environment JSON
for ordinary enablement. A supplied `ATAPE_SOURCE_COLLECTION_LIMITS` override is
strictly validated. [ADR-0076](../architecture/adr/0076-source-collection-release-admission.md)
owns the selected numeric profile, including source/page, projection, journal,
Raw and deadline limits. Server-advertised limits may be smaller.

These are independent admission ceilings, not guaranteed history sizes, RSS caps
or physical database-size limits. SQLite free pages, WAL and retained proofs cost
space beyond pending payload accounting. Unsupported layouts produce format
diagnostics, uncertain Origin produces attribution diagnostics, and oversized
source data produces limit diagnostics. None establishes successful capture.

## Verification

- `pnpm --filter @atape/adapter-opencode test` exercises the source Interface.
- `pnpm test:opencode-contract` exercises installed CLI/Adapter behavior over real
  authenticated HTTP/PostgreSQL, including frozen recovery, independent Raw,
  source changes, background capture and package replacement.
- `pnpm test:adapter-package` and `pnpm test:release` verify installed artifacts;
  release acceptance uses the exact checksummed tarballs.
- `pnpm test:collector-disk` exercises physical disk exhaustion and recovery.
  `pnpm test:go:integration` includes the installed OpenCode contracts alongside
  the other PostgreSQL suites.

The [v0.5.0 release disclosure](../releases/v0.5.0.md#validation-and-manual-acceptance-disclosure)
records native source and platform observations separately from exact-package
tests. Native observations and controlled tests do not establish production throughput or
manual staging acceptance for a new candidate. Use [release evidence](../releasing.md)
for candidate acceptance and the rollout procedure for operational checks.

## Remaining scope

Wider versions/platforms and alternate source storage need explicit compatibility
acceptance. Long-term capacity depends on workload and retained proof metadata;
cleanup is not an unbounded-history storage guarantee. The source capability does
not migrate existing Codex/Claude Sessions to publication mode or implement every
earlier byte-stream and opaque-reference proposal.
