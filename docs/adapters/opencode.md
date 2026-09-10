# OpenCode Adapter implementation status

The selected route is read-only local SQLite through the existing Host-owned
bounded-pull Collector. OpenCode is not yet an installable or enabled ATape
Adapter. Atomic publication and versioned reads are implemented; the first source integration
still requires source preparation/scheduling, revision and coverage allocation, and native acceptance. See the
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
reclamation. The HTTP and Composition Root connection is described below.
This preparation increment was followed by validation and activation below.

The legacy ingestion path and candidate reservations enforce one write mode for
the same authenticated source identity. Reserving a new source selects publication
mode permanently; reserving an existing legacy Session fails. This is an explicit
capability boundary and does not migrate existing Codex or Claude history.

The [candidate preparation Interface](../architecture/publication-candidates.md)
records the exact bounds, lease and retry semantics, and the distinction between
transport sealing and Canonical validation. Real PostgreSQL tests cover nine
scenario groups, including independent connections competing for quota, lease
expiry during storage work, expired-token cleanup and revoked membership.

## Landed foundation: bounded candidate validation

`PublicationStore.Validate` now checks one frozen part per transaction through
the shared Canonical normalization Interface. It verifies source ownership,
complete Session/Thread topology, tools, usage, cross-part membership and immutable
source revisions. Each successful step replaces the transport body with fixed
Canonical bytes and persists membership coordinates, validation progress and
actual retained-byte accounting together. A new Server connection resumes from
that progress. Normalized bytes still consume the configured part, target and
account budgets; failed validation cannot partly advance the current unit.

Real PostgreSQL tests cover eleven validation scenarios, including large Event
indices, child tools and usage, changed source versions after cleanup, quota
rollback and lease expiry during normalization. This increment prepares complete
candidate membership but does not select a visible head or connect HTTP routes.

## Landed foundation: atomic activation and selected-head reads

`PublicationStore.Activate` now selects a complete validated version together
with Session metadata, capture progress, a durable receipt and Search eligibility.
Replaying a successful receipt after restart, expiry or a later publication
returns the original proof without selecting the old version again.

Conversation, project counts and overview usage read the selected version.
`Store.ConversationPage` returns bounded Events and requires continuations to
retain their head; a changed version produces an explicit refresh result. The
older whole-conversation Interface fails explicitly above 100 Events for these
Sessions. The HTTP/Web paging increment below provides the bounded read path.

Search still indexes asynchronously. Current membership and semantic descriptors
hide withdrawn or changed content immediately, and late workers cannot restore
it. A partially indexed target reports unknown indexed-through progress until
all current descriptors are covered. Bounded cleanup reclaims unreachable old
version bodies while retaining activation proof and protecting the current head.

Real PostgreSQL tests exercise publication, rollback during lease expiry, lost
result recovery through a fresh connection, old receipt replay, stale index work,
pagination, withdrawn child tools/usage, partial indexing, empty targets, old-body
cleanup and lifecycle authorization. These are Module-level results; they do not
establish native OpenCode end-to-end acceptance.

## Landed foundation: publication HTTP and Web paging

The closed HTTP route registry now exposes `atape.publication.v1` through CLI-only
operations. The existing authentication middleware rejects missing, revoked or
Web credentials before reading a publication body; the Module rechecks capture
ownership and current Project/Session access, including historical receipts.
Part uploads preserve exact bytes. Validate still processes one part per call;
no handler owns a retry loop, database transaction or publication workflow.

`ATAPE_PUBLICATION_LIMITS` is an explicit JSON configuration (bytes, counts and
lifetimes in milliseconds). Unconfigured instances omit the capability from
instance discovery and return `503` from publication routes. Demo mode rejects
this configuration. Actual constructor limits are returned by the authenticated
capability operation. No deployment or release limits are selected here.
See [the HTTP contract](../architecture/publication-candidates.md#http-transport)
and [OpenAPI](../api/openapi-v1.yaml).

The Web reader requests one page of at most 100 Events and retains the selected
head in each continuation URL. It renders one page at a time, supports browser
back/forward and return to the beginning, and opens search matches at an inclusive
Event anchor. A changed head removes the cached page and asks the user to reload.
Pages never append content from different heads. Narrative grouping and the prompt
index cover the current page, so an exchange may continue on the next page.

Publication reads also stop at a 6 MiB internal Event budget (one admitted Event
always makes progress) and cap the complete response at 8 MiB, including JSON
escaping, headers and tool details. The Browser accepts that bounded response
profile for conversation pages; other responses and errors retain 2 MiB limits.
Legacy Sessions preserve their existing full read behavior. Old HTTP callers
without `limit` receive `pagination_required` for an incomplete publication read.

Real HTTP/PostgreSQL tests cover multi-part preparation/validation, exact-byte
retries, configured upload limits, lost-result recovery, empty replacement, old
receipt replay after reclamation, current authorization, count/byte page boundaries
and inclusive anchors. Browser tests cover page transitions, browser history,
head replacement and direct search navigation. These fixtures do not substitute
for native OpenCode/Collector end-to-end acceptance.

## Landed foundation: Collector publication recovery

The application publication Module now owns reserve/Begin, local manifest sealing
and bounded recovery through the secured Server Interface. Host preparation still
has to validate, redact and encode every unit, persist it in `CaptureJournal`,
and close its source view before sealing. The existing Adapter collection loop
does not select this capability yet.

Recovery derives its account/installation binding from the opened journal. It
never opens a source or invokes a converter. Each slice has an explicit budget
of 3–64 remote operations, reads one payload unit at a time, and renews only the
same authoritative attempt. The Node HTTP Adapter sends the stored JSON bytes
verbatim, using the pinned API origin and expected account. It validates bounded
wire receipts before the workflow checks their original identity/fence/manifest.

Actual Canonical part receipts are persisted independently of activation. An
indexed pending-unit page makes progress across large targets and process
restarts without retransmitting all earlier acknowledged parts. This does not
advance the source checkpoint or release Canonical bodies. A verified activation
commits coverage atomically while Raw obligations remain pending. Unknown,
unauthorized and failed requests preserve sealed content; expired/superseded
candidates require an actual terminal rejection before local abandonment.

Journal format 2 adds the pending-unit index and upgrades a verified format-1
binding transactionally. Payload and receipt identities remain unchanged. The
public Interface exposes the immutable binding and Canonical acknowledgement;
no Server schema migration or deployment is part of this increment.

Tests cover 205 parts with a three-operation slice, exact retry bytes, local
fencing, changed remote identities, unknown outcomes and independent Raw. A real
HTTP/PostgreSQL contract starts independent Node processes: seal, lose a
successful part response, lose successful activation, then recover the original
proof after another writer publishes a newer head and reclaims the old bodies.
The recovered checkpoint advances without restoring the old Server head.

## Landed foundation: independent Raw proof and receipt lookup

Publication Raw uploads now require their original activation head and independent
Raw authority from the authenticated capture-policy response. PostgreSQL verifies
the actual activated capture, current Session lifecycle, owning user/installation/
Adapter and current policy both before blob writes and during manifest commit.
The head may already have been replaced and its Canonical bodies reclaimed.

Team policy and personal preference revisions fence Raw separately from Canonical.
Off/on does not revive old authority. An identical setting does not advance its
revision; `force` ignores personal revisions and preference changes. Each new
publication Raw object binds its activation/authority permanently and supports
one generation, so an existing object cannot be re-signed under newer authority.
A fresh observation after re-enabling uses fresh object identities and can refer
to existing genuine activation without changing old Canonical references.

Append returns an immutable per-chunk receipt in addition to the legacy append
result. CLI-only `POST /api/v1/ingestion/raw/receipts/lookup` reads one receipt by
caller-scoped source identity without consulting the blob Store. It checks current
ownership/access but does not hide a real ACK merely because uploading is now
disabled. Receipt identity, metadata, offset, length, digest, final marker and
publication proof remain fixed even after later chunks advance the object size.
Publication receipt timestamps accept microsecond precision or coarser, matching
PostgreSQL exactly; finer timestamps are rejected before storage.

Real HTTP/PostgreSQL tests cover old-head Raw, legacy-path bypass rejection,
unactivated/foreign/stale authority, object re-binding, immutable generation,
personal and Team off/on, forced capture, lost-result receipt lookup, unavailable
blob storage, revoked membership and a policy change between blob write and
manifest commit. See [ADR-0060](../architecture/adr/0060-publication-raw-authority-and-receipts.md).

## Landed foundation: Collector Raw recovery and resumable cancellation

`deliverPublicationRaw` hides policy reconciliation, immutable receipt checks and
bounded upload/cancellation behind the publication Module Interface. Begin stores
the Host's authenticated Raw authority when Raw is enabled. Each recovery slice
uses 3–64 HTTP operations and reads one sealed unit, without a source or converter.
The authenticated Node Adapter sends the original JSON bytes to the Raw endpoint;
it never serializes a replacement upload during retry.

A receipt must match the complete frozen observation: source identity, metadata,
microsecond timestamp, offset, length, digest, final marker and original activation
and Raw authority. A newer Canonical head does not invalidate this obligation.
Authorized absence (`204`) can trigger an upload only under the original current
authority. Concealed `404` responses remain unresolved, including during cancellation.
Network, authorization and invalid-response failures retain unresolved bytes.

Policy disable or a revision change persists cancellation intent before resolving
units. Every remaining unit first looks up its actual receipt; a real ACK is
retained, while an unknown receipt permits explicit per-unit cancellation. Neither
cancellation nor its intent creates an ACK, advances a Canonical checkpoint or
asserts Raw coverage. Re-enabling during restart cannot resume canceled work.
Resolved units are independently reclaimable; indexed pending scans resume at the
next unresolved unit. Existing journal format 2 supports these settlements without
changing stored payloads or requiring a schema migration.

Real SQLite tests exercise 205 Raw units with three-request slices, exact-byte
retries, lost acknowledgements, newer Canonical checkpoints, policy races, receipt
mismatches and restart during cancellation. The authenticated HTTP/PostgreSQL
contract additionally loses an actual Raw append response in a Node process,
disables Raw, recovers the receipt and partially cancels in a second process,
revokes membership and proves that concealed receipt lookup retains the remaining
bytes, then restores access, re-enables and finishes cancellation without an upload.
This foundation still requires Host preparation and scheduling; it does not yet
create fresh Raw-only captures or maintain the per-source coverage ledger.

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

The next increment connects source revision/coverage allocation and fresh Raw-only
observations. OpenCode source projection, Host preparation and
Collector scheduling then connect these foundations into the explicit capability.
Bounded archive browsing is also required before enabling observation-per-object
capture, since the legacy Session archive listing currently loads all objects.
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
