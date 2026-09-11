# OpenCode Adapter implementation status

OpenCode is a First-party Adapter in the ordinary Tools selection, package
installation and upgrade flows. The selected route is read-only local SQLite
through the Host-owned bounded-pull Collector, with complete Canonical targets
published atomically and Raw recovered independently. Installing the package
alone does not enable capture. This integration does not publish npm packages,
deploy an instance or migrate a production database.

The accepted first-release source is **OpenCode 1.18.30 local v1 SQLite on macOS
arm64 and Linux arm64/glibc**, using Node.js 24 or later. Other source versions,
architectures, v2/mixed databases and JSON-only history have no support claim.
The Server must expose `atape.publication.v1` with configured publication limits;
CLI collection defaults are supplied automatically. See the
[package guide](../../adapters/opencode/README.md) for enablement and source paths,
and the [capture contract](../architecture/opencode-capture-publication.md).
The [0.5.0 release candidate](../releases/v0.5.0.md) coordinates all four npm
artifacts. The [Server rollout procedure](../operations/opencode-rollout.md)
provides explicit Compose enablement, admission review and paired recovery steps.

The sections below record the delivery sequence. Statements about private
candidates, unavailable entry points or pending gates describe their respective
historical increment; the current scope is above and the final increment is at
the end of this guide.

## Landed foundation: private capture journal

`CaptureJournal` is an application Interface with a Node SQLite Adapter. It
persists final delivery bytes that the Host has already validated, redacted and
encoded. This Module has no source-reading, conversion or network behavior;
those responsibilities stay in the Collector workflow. The explicitly configured
source Collector uses this journal; legacy Adapter recovery remains unchanged.

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
and close its source view before sealing. The explicitly configured source
Collector now selects this capability as described below.

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
Raw-enabled preparation. The explicitly admitted source scheduler now selects both.
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

The package remains private and unregistered. Source recovery, attribution and
unchanged-content handling are connected through the explicitly admitted Host
workflow described below. Stable-channel database discovery
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

`comparePublicationSource` compares a disposable source view before writing
per-record capture metadata. It shares formal preparation's masking/fingerprints,
compares actual published membership and independent Raw outcomes, and returns
unchanged without capture/version/unit/checkpoint writes or HTTP. A changed result
requires a fresh view after Begin; Raw-only changes use an independent observation.
Exact identity/frame counts and the entire operation have explicit bounds. Raw
capacity gaps stay stable under matching packing admission and are retried when
admission changes. See [ADR-0069](../architecture/adr/0069-source-comparison-before-capture.md).
Bounded archive browsing now pages observation-per-object history through the
Raw Module; the legacy listing explicitly refuses archives above 100 objects.
The native Collector acceptance below covers source mutation, rewind, compaction,
tools, child/fork identity, off/on Raw policy and Search through production
Interfaces. Private Adapter installation and installed CLI background acceptance
are verified below; supported-platform capacity and remaining failure/admission
evidence still gate the first usable release. Research prototypes remain on their separate
branch and are not bundled with the CLI.

## Landed Host capability: source collection and scheduling

`runCollectionCycle` now dispatches explicit source runtimes to the Host-owned
`SourceCaptureCollector`. Node composition requires a validated 16 KiB-bounded
`ATAPE_SOURCE_COLLECTION_LIMITS` JSON object with source, projection, journal, Raw,
comparison, recovery and cycle limits. Absence leaves source collection unavailable;
this internal admission switch does not install or register OpenCode.

Each cycle recovers frozen journal obligations before discovery, then attributes
fresh sources, compares actual coverage and prepares only necessary Canonical or
independent Raw work. Recovery works after deleting the source or Project directory.
Its cursor is independent of discovery and uses CAS in existing Collector state;
legacy cursors are rejected. The journal's format-5 indexed `unactivated` lookup
finds a new Canonical attempt behind older pending Raw. Upgrades preserve bytes,
receipts and account binding. Raw network failure no longer delays reclamation of
confirmed Canonical payloads.

Per-source deadlines isolate slow requests. Discovery finishes with interval
backoff while recovery continues from its own persisted position. Both Collector
loops pause after at most 16 consecutive catch-up cycles, including multiple
Projects whose scan ends never coincide. Cursors survive every pause.

Native SQLite, installed runtime and real Node Collector tests cover initial and
unchanged collection, source edits, Raw-only changes, policy off/on, response loss,
deleted directories, fairness and bounded recovery. The complete Collector path
now also passes actual authenticated HTTP/PostgreSQL acceptance below. See
[ADR-0070](../architecture/adr/0070-source-collector-recovery-and-scheduling.md).

## Native Collector acceptance through authenticated HTTP/PostgreSQL

The controlled official OpenCode 1.18.30 SQLite fixture now runs through a locally
installed private tarball, full Node composition and `runCollectionCycle`, actual CLI
credential storage, authenticated HTTP, PostgreSQL publication and the production
conversation, Raw and Search Interfaces. Each phase starts a separate native Node
process; no publication, journal, attribution or transport workflow is substituted.

The contract verifies initial capture and unchanged scans, an in-place text rewrite,
rewind/unrevert, native compaction and tool details, child Thread search anchors,
an initially excluded fork later attributed as a separate Session, and paginated
head-consistent reads. Old-head continuation requests fail explicitly. Rewound
messages immediately lose Search eligibility; the actual asynchronous projector
then makes current membership searchable. Tool output remains in details under
the existing ADR-0030 summary-only Search contract.

Raw-off Canonical changes keep unavailable references after Raw is enabled again.
An actual stored Event reference resolves through the Raw HTTP API to the precise
masked source member; that historical row stays unchanged after later captures.
A Raw-only source field produces an independent observation and no Canonical PUT.
The test drops successful activation and Raw responses after Server commit. A new
process recovers from the existing journal with the source and Project directory
unavailable. Raw receipt recovery performs zero uploads, and final Raw browsing
contains both original and later observed rows without the controlled secret.

This is production Interface acceptance of a locally packed and installed private
Adapter. The installed CLI background extension is described below; neither
contract establishes a general native version/platform claim. The package stays private and unregistered.
Bounded Raw object browsing and metadata admission are implemented below; physical
admission, retention and the final supported-platform scope remain release gates.

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

### Bounded Raw browsing

The Raw drawer now reads 50-object manifest pages ordered by immutable server
first receipt time and ID. Existing objects do not move when their contents grow;
first/next and browser back/forward replace the displayed page. Content reads one
chunk with a 5 MiB successful-response bound, including legal 3 MiB source chunks.
Legacy all-manifest callers receive `pagination_required` above 100 objects.
See [ADR-0071](../architecture/adr/0071-bounded-raw-manifest-browsing.md).

This closes the unbounded manifest-list gap. OpenCode remains private/unregistered;
physical capacity/deadline defaults, retention and the final supported-platform
scope still precede enablement. No package
publication, server deployment or production migration is part of this increment.

### Account journal metadata admission

Source Collector now requires explicit `journal.metadataEntries` (1–1,000,000),
covering scopes, captures, units, source versions and observation membership across
the account journal. This is additional to payload-byte and per-target limits;
there is no production default. Journal format 6 upgrades verified format 1–5
bindings transactionally and counts existing metadata without discarding it.

At capacity, new metadata is rejected with used/limit/required counts. Existing
receipts, activation, cancellation and payload reclamation remain available even
when reopening below current usage. Increasing explicit admission permits new
captures. Completed or abandoned metadata remains charged after its body is
reclaimed. The bounded membership retirement below now credits eligible old
observation rows; version/receipt pruning and state reset are not introduced.
Stop older Collector processes before a format upgrade; mixed-version writers
are unsupported. Concurrent current-version writers must use the same admitted
configuration, as with existing payload budgets.

The controlled 1,000-capture probe retained zero payload bytes but a 4,153,344-byte
SQLite file, demonstrating why metadata admission is separate. That fixture had
ten records and one 256-byte unit per capture; its local 2.7-second run and about
1.1 MiB WAL do not define platform-independent latency, memory or disk defaults.
See [ADR-0073](../architecture/adr/0073-capture-journal-metadata-admission.md).
Physical capacity/deadline defaults, retention and the final supported-platform
scope remain required before OpenCode registration or enablement.


### Private installable Adapter artifact

The private `@atape/adapter-opencode@0.0.0` package now exports a bundled ESM
`createAtapeAdapter` entry and declares `atape.source-capture.v1`. All runtime
code is bundled; installing it needs no workspace or runtime npm dependencies.
It remains excluded from the public release contract and default tool registry.
The normal build and Adapter artifact checks include this private candidate.

`pnpm --filter @atape/adapter-opencode verify:package` packs the exact four-file
artifact (entry, manifest, README and license), installs it offline with lifecycle
scripts disabled, and copies the verifier and controlled native fixture outside
the checkout. A fresh Node process imports only that installed bundle and Node
builtins. It checks root/fork discovery across child-only pages, original-directory
attribution, bounded frames, six Canonical Events, Raw off/on, one active view,
close/reopen, lifetime cancellation, missing-source errors and unchanged source
hash/mtime. The controlled local tarball measured 145,420 bytes; this is build
evidence, not a contractual future package-size value.

The full authenticated HTTP/PostgreSQL Collector contract now packs this same
package once and installs it into its isolated Adapter directory. Each subsequent
phase loads that persisted installation. The previous source-import wrapper has
been removed, so rewriting history, response-loss recovery and exact Raw references
also exercise the shipped entry and its manifest. No personal history is read.

This increment verifies the private Adapter artifact. Installed CLI background
execution is verified below. Platform-specific admission evidence remains a
release gate; publication, server deployment and production migration are separate
actions.

### Physical disk exhaustion and recovery

The journal now preserves SQLite's `SQLITE_FULL` capacity failure when SQLite
automatically rolls back a transaction. A second unconditional rollback formerly
replaced that failure with a generic I/O error; frozen content was retained, but
the caller lost the capacity classification.

`pnpm test:collector-disk` runs the production journal Interface in a dedicated
16 MiB tmpfs within a network-disabled Docker container. It fills that filesystem
to actual `ENOSPC`, verifies capacity rejection without a partial new unit, and
compares a sealed, unacknowledged 512 KiB unit, its source revision and progress
before/after failure and across fresh Node processes. Removing only the filler
permits a new 2 MiB append; old bytes and unconfirmed progress stay unchanged.
The contract never supplies an ACK or activation receipt. CI runs it separately
from ordinary unit tests with a pinned Node 24 bookworm multiarch image.

The regression failed with `io` before the fix and passed with `capacity` after it
on Linux arm64. Closing SQLite can release filesystem space, so reopening before
removing the filler does not promise successful writes at strictly zero free
bytes. This test establishes failure preservation and recovery, not a physical
disk quota, a release default or general OS capacity evidence.


### Installed CLI background acceptance

The authenticated HTTP/PostgreSQL contract now also packs and installs the CLI
outside the checkout and runs its actual `start`, `status` and `stop` commands
against the previously installed private OpenCode Adapter. It keeps the same
account credentials and journal across separate managed processes. Source-control
fixture phases only recreate, edit or remove the controlled native database;
they perform no collection. Snapshot phases inspect the existing journal after
the daemon stops, without running a hidden collection cycle.

The contract verifies one process for repeated start, background Canonical and
Raw delivery, a new process after stop, capture of a source changed while stopped,
and automatic capture of a later source update while that process remains running.
It observes both bounded status and the actual paginated selected-head reader;
Search indexes the latest update and withdraws the earlier text. New background
Raw observations have distinct identities, and each selected Event's actual Raw
HTTP reference resolves to its own new source text with the secret masked. Earlier
Raw reference bytes remain unchanged. Removing the source produces a failed job in a still-owned
running daemon, and stopping it preserves the selected head, source checkpoint,
record references and empty pending backlog. Cleanup uses the production process
ownership check even if the parent test times out.

This is installed CLI/Adapter background acceptance with a real Server and
PostgreSQL, using the controlled native fixture. It does not replace the separate
[official native platform evidence](https://github.com/SingleMai/ATape/blob/855b9661858e67aa541d8b2e7b642d795cc99d7f/docs/research/opencode-platform/OBSERVATIONS.md),
which records exactly tested binary/platform combinations and the distinction
between unchanged DB/WAL data and SQLite SHM read-lock metadata. OpenCode remains
private, explicitly configured and outside the default tool registry. Final
release admission and support boundaries remain to be accepted.

### Bounded retirement of superseded observations

The Collector now automatically retires obsolete full record memberships through
the journal's `pruneRecords` Interface. Each fenced transaction deletes at most
100 metadata rows from one completed or explicitly abandoned capture. The current
published Canonical, last complete Canonical/Raw observations and all unfinished
captures stay protected. Recovery and cleanup run before new source admission;
cleanup yields between batches, uses the existing source deadline and resumes
without rereading the provider. A timed-out cleanup postpones new capture.

Journal format 7 verifies its binding and initializes retained record counts
before enabling cleanup. A retirement marker makes old record reads/replays fail
explicitly rather than returning an incomplete list or implying source absence.
Capture and unit identity, immutable seals, source versions, Event Raw provenance
and receipts remain. Identical reservation/seal/receipt replay still works, changed
proof conflicts, and an old activation cannot restore its checkpoint. New Raw
observations can continue reusing original units after the original membership
has been retired. Existing Server Raw objects and historical references are
independent of this local cleanup.

Tests cover bounded interruption/reopen and actual `SIGKILL`, protected roots,
pending Raw, binding-before-upgrade, old proof replay, absence/reappearance and
abandoned source versions. Twenty complete 60-Event rewrites fit an unchanged
250-entry journal budget. The real Source Collector additionally completes 25
native fixture rewrites under 500 entries and then skips the unchanged source;
the installed CLI/Adapter HTTP/PostgreSQL contract continues to pass.

This removes repeated full-membership amplification. Distinct source versions,
capture headers and unit receipts still consume admission, and protected current
or pending work is never evicted for space. SQLite can reuse freed pages; this
does not promise an immediate smaller file or constant storage for unlimited
history. See [ADR-0074](../architecture/adr/0074-capture-observation-retention.md).
The [continuous retention capacity experiment](https://github.com/SingleMai/ATape/blob/262508f3bd1605245f918b51f918989a24e43704/docs/research/opencode-platform/retention-capacity/OBSERVATIONS.md)
completed five 10,000-Event Raw-enabled observations under an unchanged 110,000
entry budget. Each rewrite changed one Event, retired 30,003 membership rows in
301 batches and retained 9,999 unchanged Event Raw references. Post-cleanup usage
rose from 60,229 to 60,317 entries; each later round added only 22 capture/unit
proof rows. Cleanup took 1.09–1.32 seconds. This single macOS arm64 experiment used
simulated ACKs; it does not replace the real HTTP contract or select release
defaults. The full process peaked at 493,715,456 bytes RSS, and its SQLite file
reused pages without shrinking. Remaining work is explicit first release
admission/support, followed by the ordinary detection/enablement flow.
OpenCode remains private and unregistered; no publication or deployment occurred.

### Installed Git Project attribution

The OpenCode manifest now declares `atape.git-attribution.v1`, allowing the existing
Host to load it for Git Projects. The Adapter supplies immutable creation Origin
metadata; the shared Host Module owns Git inspection, durable repository evidence
and current Server matching. No provider-specific Git resolver is added.

The package regression builds the actual tarball and installs it through
`installAdapter`, then verifies the setup capability check and public
`AdapterRuntimes` Interface. A real Git worktree provides the original source
directory while ATape is configured against a separate clone. A fork originates
in a foreign repository nested inside that clone, and mutable OpenCode directory
metadata points there too. The root is included and projects six Events; the
foreign fork is excluded. Removing the original worktree preserves established
attribution across fresh runtimes, while an unseen source remains unknown and a
revoked credential still fails. Source DB hash/mtime remain unchanged.

Only the owned Project-matching remote Seam uses a TestAdapter in this focused
regression; package installation, source reading, filesystem/Git inspection and
durable bindings use production Implementations. This is Git attribution
acceptance of the private artifact, not a package publication or default enablement.

### Confirmed Project progress across empty cycles

Source collection now records confirmed Canonical publication in its existing
Collector checkpoint. The CLI experience keeps a captured Project up to date
after an unchanged cycle, including with Raw disabled. Discovery and unsuccessful
preparation do not establish this progress. Current failures, partial work,
queued work and stopped collection retain their existing precedence.

The existing bounded journal recovery walk restores the flag from an activated
source checkpoint when older Collector JSON lacks it, even after source deletion.
It also repairs progress after a lost activation receipt is reconciled. Inspection
does not open or claim the journal or interpret a provider cursor; the generic
checkpoint fact is separate from authoritative source coverage and Raw receipts.
Tests exercise real persisted Collector state and the SQLite journal through their
public Interfaces. See [ADR-0075](../architecture/adr/0075-confirmed-collector-progress.md).

Final first release admission/support and ordinary detection/enablement remain
open. The artifact is still private and explicitly configured.

### First release scope and default Collector admission

The owner accepted OpenCode 1.18.30 local v1 SQLite on macOS arm64 and Linux
arm64/glibc as the first supported scope. Actual source capability, immutable
Origin and relationship checks still apply. Old JSON, a selected family's nonempty
v2/mixed history, other versions and other platforms have no first release
compatibility promise. Unknown parts and unsupported media retain explicit partial
fidelity; source history is never migrated or silently read through a fallback.

The Node Collector now supplies a bounded default profile, so source collection
does not require manually writing `ATAPE_SOURCE_COLLECTION_LIMITS`. Present
overrides remain strictly validated. The selected profile admits 1 MiB source
rows, 4 MiB pages, 128 MiB frozen targets, 256 MiB account pending payload and
1,000,000 account metadata entries. Source, projection, Raw, comparison, recovery
and outer work deadlines are all explicit in
[ADR-0076](../architecture/adr/0076-source-collection-release-admission.md).
These are independent admission ceilings, not guaranteed history sizes, physical
database file limits or process memory limits. Negotiated Server limits may be
smaller. Existing safe cleanup and capacity backpressure remain unchanged.

A default-profile regression uses the real Source runtime, Host boundary,
Collector and SQLite journal for three 1,000-Event text observations, unchanged
polling and an oversized-row rejection. Only the owned remote dependencies use
TestAdapters. Limits and uncertain attribution now retain their actual diagnostic
category across the foreign Interface. The installed background CLI HTTP contract
also runs without an admission override. Ordinary tool registration, installation
and upgrade integration are the next increment; the package remains private here.

### Ordinary tool enablement and coordinated packages

OpenCode is now in the shared official tool catalog. Setup, global tool selection,
version discovery and device update reporting use that catalog. Existing explicit
tool selections remain unchanged. The provider owns one pure database-location
resolver used by both runtime and metadata-only setup detection; setup neither
opens SQLite nor executes OpenCode. Explicit `:memory:`, directories and missing
files are not detected as durable history.

The self-contained OpenCode artifact now follows the same version and public
package metadata contract as the CLI, Codex and Claude artifacts. The release
manifest, checksum list and workflow asset list include all four tarballs. The
OpenCode-specific installed-artifact verifier accepts the exact release tarball;
it does not rebuild or substitute it during verification. Publication and Server
deployment remain separate actions.

Public Interface tests cover OpenCode selection, subsequent Project inheritance,
metadata-only detection and bounded version checks. The actual installed CLI
HTTP/PostgreSQL acceptance also installs a re-versioned fixture package, captures
a source change, and replaces it via `adapters upgrade opencode` with the actual
candidate. Package replacement leaves Collector JSON unchanged; the next
cycle records the installed version without uploading Canonical or Raw content,
changing the published head, changing retained record/Raw references or resetting
capture progress. When the version string changes Raw envelope byte width, one
local Raw observation rechecks packing admission and reuses existing receipts;
the following unchanged cycle does no work. The same test then resumes stopped and live background changes.
This uses the current bundle under a fixture version and does not claim support
for any older OpenCode format.

Remaining scope: remote OpenCode servers, source control/orchestration, additional
OpenCode versions/platforms and automatic source-format migration. Native capacity
measurements are controlled evidence, not universal performance guarantees. New
version support requires native compatibility evidence before extending the matrix.
