# OpenCode Adapter implementation status

The selected route is read-only local SQLite through the existing Host-owned
bounded-pull Collector. OpenCode is not yet an installable or enabled ATape
Adapter. Atomic publication and versioned reads are implemented; the first source integration
still requires runtime capability/scheduling and native acceptance. See the
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
This foundation still requires Host preparation and scheduling. The following
increment supplies fresh Raw observations; source coverage allocation remains open.

## Landed foundation: independent fresh Raw observations

A new Raw observation can reuse a genuine activation of the same source after
re-enabling, including an older head whose Canonical bodies were reclaimed. The
Collector verifies the existing proof and freezes it with the new observation
identity and current Raw authority before the Host prepares any source content.
It creates no new Canonical attempt and changes neither the selected head nor old
Canonical references. The Host still has to freshly observe and redact the source.

Journal format 3 adds immutable capture purpose. Verified format 1 and 2 journals
upgrade without changing bytes, receipts, ownership or Canonical checkpoints.
Raw observations permit only Raw units and require a nonempty, complete local seal
with an unchanged checkpoint. A restart discards an unsealed observation; a sealed
one resumes through the same Raw receipt and cancellation operation. Raw manifest
hashing retains one 100-unit metadata page at a time. Both purposes share journal
capacity, owner fencing and payload reclamation.

SQLite tests cover Raw-off Canonical history, old-body cleanup, independently sealed
fresh content, lost ACK, newer Canonical coverage, immutable purpose, wrong routing,
incomplete seals, unsealed restart and format upgrades. The actual HTTP/PostgreSQL
contract adds fresh observation preparation, a lost successful append response,
and a separate recovery process, while the newer Canonical head stays selected.
See [ADR-0061](../architecture/adr/0061-independent-raw-observations.md).

## Landed foundation: source record versions and coverage

Journal format 4 adds explicitly tracked source membership. A stable source key
receives monotonically increasing revisions for changed fingerprints/profiles and
reappearance after a complete observed absence. Abandoned captures may consume
versions; retries never roll counters back or combine different observations under
one capture identity. Existing Event versions retain their original Raw provenance,
including unavailable references from Raw-off preparation.

Every tracked record binds to frozen content or an explicit Raw limit/redaction gap.
Canonical membership points at its own replacement units. Raw can retain a matching
activated capture's pending or acknowledged obligation; its outcome follows the
actual unit receipt/cancellation even after payload cleanup. No canceled object is
recreated from a later source read.

Seals validate exact counts and complete bindings. Complete observed membership
and actually published Canonical coverage have separate pointers; activation switches
the latter atomically with its receipt and checkpoint. Raw coverage remains per
record. Tracked Raw-only observations can have no new units when recording gaps,
reusing obligations, or proving a complete empty scope. Their own-wire completion
does not turn a missing or pending archive into an ACK.

Known-source and record listings use indexed pages of at most 100 metadata rows,
so local recovery can still find a scope after its provider removes it. Tracking
requires an explicit record-count budget. A verified format 1–3 upgrade preserves
existing payloads and receipts; it does not initialize versions over an existing
untracked checkpoint. See [ADR-0062](../architecture/adr/0062-source-record-versions-and-coverage.md).

## Landed source capability: scoped read-only OpenCode SQLite

The private OpenCode workspace package now provides bounded discovery and scoped
source views. It probes the actual v1 tables and indexes, follows native parent
chains, and reads one proven root family in one SQLite snapshot. Fork roots remain
independent. Unknown/mixed v2 storage, missing parent evidence and inconsistent
relationships fail explicitly. Revert metadata is validated; the source still
returns actual stored rows for subsequent Active Path projection.

Every view has explicit byte, row, family and lifetime budgets. It checks source
sizes before loading values and verifies that traversal covered all admitted rows.
Raw-off reads expose only projection fields; Raw-on includes complete actual row
columns and original JSON TEXT. Unknown provider fields do not become Canonical
merely because the archive retains them. Oversized sources fail without replacing
existing published coverage. The Host still must validate/redact source output.

Real SQLite tests cover concurrent source changes, field filtering, identities,
unsupported layouts, invalid ordering and bounds. The controlled official 1.18.30
fixture's root/child/fork messages and parts match official exports through the
production source Interface. Direct reading of its retained native database also
matched all 23 records without changing the database mtime. These results establish
one source profile, not general platform/version support or end-to-end ingestion.
See [ADR-0063](../architecture/adr/0063-opencode-scoped-source-views.md).

## Landed source capability: Active Path projection and creation Origin

`openOpenCodeCapture` plans complete target counts and streams bounded Event/usage
drafts within the same read-only SQLite snapshot. One complete planning rescan is
allowed; neither pass writes intermediate provider payloads. Final versions,
redaction, encoding and Raw provenance remain Host responsibilities. The source
scope must close before journal sealing and content delivery.

Native creation events prove the root's original directory independently of later
Session moves. Missing or ambiguous creation evidence reports an attribution
failure; current directories never silently substitute for Origin. Native parents
define children and independent forks. Revert boundaries determine Canonical
membership, while stored suffixes still produce Raw frames. Tool call/result slots
keep stable identities and recognize actual completed/error states. Step usage
restores cache/reasoning components and preserves unknown counters.

Unknown parts, inline media and unprojected tool attachments mark capture fidelity
partial. External/file media are links without content fetching. Compaction retains
original stored tool output; lifecycle parts do not become fabricated messages.
The controlled native fixture now includes its three actual creation events.
SQLite tests cover these semantics, source mutation between passes, bounds and
scope closure. See [ADR-0064](../architecture/adr/0064-opencode-projection-and-creation-origin.md).

## Landed Host capability: Canonical preparation under Raw-off policy

The Host can now consume a lazy scoped source, validate/mask each slice, allocate
record versions and freeze complete Canonical parts in the journal. It verifies
fresh Origin against the persisted claim, fixes Session/Thread headers across
parts, and seals only after the source closes. Event fingerprints include final
derived authors, and Thread-scoped native IDs remain independent. Interrupted
preparation with existing records must be abandoned before any new source read.

Packing admits both actual wire bytes and a conservative bound for the Server's
larger normalized records. Cross-language tests pass actual native-source Host
parts through Go normalization with maximum-width receive provenance. Real journal
tests recover frozen bytes after source deletion and response loss. These tests
also cover masking, changed versions, repeated native IDs in different Threads,
incomplete/oversized input and Origin mismatch. The existing Collector transport
reuses the extracted ACP mapping without changing its wire behavior.

The initial operation required Raw-off Begin; the following increment adds
Raw-enabled preparation. It is not selected by installed Adapters or the scheduler yet.
See [ADR-0065](../architecture/adr/0065-host-canonical-preparation.md).

## Landed Host capability: Raw preparation and receipt-aware reuse

The Host now prepares Raw-enabled Canonical captures and independent fresh Raw
observations through the same scoped source Interface. It masks actual source
rows, including nested JSON TEXT, and packs at most 100 records per admitted
archive object. Duplicate decoded JSON keys and masking collisions produce an
explicit redaction gap; oversized rows or exhausted Raw admission produce limit
gaps. Only final validated Base64 wire bytes enter the private journal.

Matching acknowledged records reuse their original object after payload cleanup.
Pending records retain the original upload obligation only under matching authority
and without cancellation intent; they remain pending until a real receipt arrives.
Indexed metadata lookup avoids repeatedly scanning hash-ordered membership. New
Raw observations after policy off/on never rewrite Canonical references or advance
its checkpoint. Existing Event versions keep their original provenance.

Tests cover native SQLite rows, escaped secrets and duplicate keys, changed and
unchanged versions, ACK/GC reuse, pending outcomes, policy changes, explicit gaps
and interrupted preparation. The real authenticated HTTP/PostgreSQL contract runs
the production Host in separate Node processes, removes the source before delivery,
loses a successful Raw response and recovers actual receipts, then prepares a fresh
changed observation after off/on. See [ADR-0066](../architecture/adr/0066-host-raw-preparation.md).

## Landed source capability: installed runtime boundary

The explicit `atape.source-capture.v1` manifest capability now connects package
factories to Host-managed discovery and scoped draft views. `AdapterRuntimes.open`
validates the selected capability, page/header admission, cursor progress, Raw-off
frames and resource lifetime. A late open after cancellation is closed; failed or
closed views cannot resume. Existing Codex and Claude runtimes keep `collect`.

OpenCode discovery emits proven native roots and forks once through bounded ID
pages, validates child ancestry, and shares original creation Origin with capture.
SDK paging includes the complete response envelope in its byte bound. Controlled
native tests load the actual source runtime through an installed package entry.
See [ADR-0068](../architecture/adr/0068-source-capture-runtime.md).

The package remains private and unregistered. Automatic Collector scheduling does
not select this capability yet; source recovery, attribution and unchanged-content
handling must be connected before enabling it. Stable-channel database discovery
uses the native XDG data location and respects `OPENCODE_DB`; non-stable channels
require that explicit override. No private history is read during verification.

## Bounds and remaining integration work

`CaptureJournals.open` keeps a bounded installation registry so losing both an
account database and its marker cannot silently reset that account. Metadata writes
and legacy checkpoints share a SQLite writer lock; interruption waits for actual
filesystem writes to settle before releasing it. Stop the pre-upgrade Collector
before a new binary writes this state; overlapping old PID-lock writers and new
SQLite-lock writers is unsupported.

`CaptureJournals.open` now binds lazy account journal initialization to the existing
Collector installation and its metadata lock. Versioned installation/account
markers distinguish never-exposed initialization from established state. Valid
interrupted initialization can finish; missing established databases or mismatched
identities fail without replacing recovery evidence. Missing Collector JSON state
also cannot generate a new installation while bound captures exist. Legacy
checkpoints remain unchanged. Real SQLite/filesystem tests include four concurrent
first-open Node processes. See [ADR-0067](../architecture/adr/0067-collector-capture-bootstrap.md).

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
lease/fence checks or source observation. The Host must use tracked membership
and actual per-record outcomes; the opaque checkpoint alone is not proof of full
Canonical or Raw coverage.

The next increment connects attribution and Collector scheduling to the source,
prepared publication and recovery Modules. Unchanged observations must be compared
before writing full per-record capture metadata; skipping activation alone still
retains duplicate local membership records.
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
