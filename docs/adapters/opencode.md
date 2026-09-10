# OpenCode Adapter implementation status

The selected route is read-only local SQLite through the existing Host-owned
bounded-pull Collector. OpenCode is not yet an installable or enabled ATape
Adapter. The first integration still requires atomic replacement publication,
head-aware conversation reads and Search, and independent Raw recovery. See the
[capture and publication contract](../architecture/opencode-capture-publication.md).

## Landed foundation: private capture journal

`CaptureJournal` is an application Interface with a Node SQLite Adapter. It
persists final delivery bytes that the Host has already validated, redacted and
encoded. This Module has no source-reading, conversion or network behavior;
those responsibilities stay in the Collector workflow. The existing Collector
does not use this journal yet, so its previous recovery behavior is unchanged.

The Interface hides transactional byte accounting, identity checks, local owner
epochs and payload reclamation. Its operations support these behaviors:

- Reserve the immutable attempt, input checkpoint and Begin request before
  remote Begin; append bounded, numbered Canonical and optional Raw units.
- Seal only the declared complete unit set. Delivery reads cannot expose an
  unsealed candidate. Retrying a unit cannot substitute different bytes.
- Record genuine activation proof and the next source checkpoint in one local
  transaction. Replaying an earlier receipt cannot restore an older checkpoint.
- Retain Raw independently after activation, until actual acknowledgement or
  explicit cancellation. Raw cancellation works before activation, prevents new
  Raw units and creates no acknowledgement or offset advancement.
- Keep an uncertain sealed attempt intact. A workflow-verified terminal remote
  rejection permits abandonment without advancing the checkpoint; timeout or
  an expired/missing receipt alone is not evidence of rejection.
- Fence earlier local owners on every operation, including reads and cleanup.
  Recover through bounded metadata pages and one payload unit at a time.
- Reclaim only resolved payloads in batches, retaining identities and receipts.
  Pending scans include terminal captures that still need reclamation, so a
  crash between completion and cleanup does not hide their payloads.

The Layer requires explicit `create` or `open`, a binding to the ATape instance,
user and installation, and configured limits. Opening missing, unsupported or
corrupt state fails instead of silently creating a replacement. The source
Origin remains immutable within that binding. The database uses WAL and FULL
synchronous transactions; new journal files use mode `0600`.

## Landed foundation: Server candidate preparation

The PostgreSQL `PublicationStore` now supplies the Server-side candidate Module:
finite reservations, immutable Begin identity, writer fences and leases, bounded
parts, transport sealing, metadata recovery, renewal, explicit rejection and
reclamation. It is not yet connected to HTTP routes or the Composition Root.
No candidate can activate, enter ordinary conversation reads, grant Raw authority
or enqueue Search work in this increment.

The legacy ingestion path and candidate reservations enforce one write mode for
the same authenticated source identity. Reserving a new source selects publication
mode permanently; reserving an existing legacy Session fails. This is an explicit
capability boundary and does not migrate existing Codex or Claude history.

The [candidate preparation Interface](../architecture/publication-candidates.md)
records the exact bounds, lease and retry semantics, and the distinction between
transport sealing and Canonical validation. Real PostgreSQL tests cover nine
scenario groups, including independent connections competing for quota, lease
expiry during storage work, expired-token cleanup and revoked membership.

## Bounds and remaining integration work

Limits cover each payload unit, retained bytes per target, total retained
payload bytes and unit count per target. Metadata input strings are bounded;
list calls return at most 100 records and cleanup handles at most 32 units.
The limits are required constructor inputs. This foundation selects no release
defaults and makes no claim about production capture throughput.

These are logical retained-payload budgets, not a hard filesystem-size ceiling.
SQLite free pages, WAL, and retained identity/receipt metadata can occupy more
space; logical reclamation is not secure erasure. A disk error preserves pending
obligations and surfaces a typed failure. Filesystem stress, long-term metadata
retention, admission/deadline policy, and supported-platform acceptance remain
release gates before the new capture workflow is enabled.

Remote receipts are bounded opaque JSON owned and validated by the publication
workflow. The journal does not authenticate them or replace remote authorization,
lease/fence checks, source revision allocation, Raw coverage or scanner state.
Those fields must be given a concrete workflow contract before activation in the
Collector; the journal's opaque checkpoint alone is not proof of full coverage.

The next increment adds bounded Canonical validation and head materialization,
then atomic activation with head-aware Reader/Search integration and HTTP routing.
Collector journal recovery and the OpenCode projection then connect to that
complete publication Interface.
The first usable OpenCode release also needs real source mutation, rewind,
compaction, tool/subagent replay, off/on Raw policy, and Search acceptance through
the production public Interfaces. Research prototypes remain on their separate
branch and are not bundled with the CLI.

## Verification

Behavior tests use the public application Interface and real temporary SQLite
files. They cover fresh-runtime recovery, `SIGKILL` after activation and before
Raw acknowledgement, separate open connections and owner fencing, immutable
identities, incomplete seals, checkpoint replay, Raw cancellation before and
after seal, terminal rejection, bounded metadata/cleanup, capacity pressure,
missing state and corruption. Application and CLI typechecks/tests also run.

Run the focused suite with:

```sh
pnpm --filter @atape/cli exec vitest run src/runtime/captureJournal.test.ts
```
