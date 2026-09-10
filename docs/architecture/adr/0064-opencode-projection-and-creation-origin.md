# ADR-0064: OpenCode projection and creation Origin

- Status: Accepted implementation detail of ADR-0058 and ADR-0059
- Date: 2026-09-10

The bounded source reader supplies coherent provider rows. The Host also needs
complete target counts before freezing any publication part, stable pre-revision
Canonical identities, and evidence of where a root was created. Current Session
directories can change when OpenCode moves a Session.

## Decision

The private OpenCode Adapter Module exposes scoped `openOpenCodeCapture`. Its
Interface returns immutable creation attribution input, Session/Thread header
drafts, target counts, and a bounded frame reader. Each frame associates zero or
more Event/usage drafts with one actual source row key and optional original Raw
columns. Revisions, projection counters, Raw object references, redaction, final
wire encoding, journal writes and delivery remain Host responsibilities. Drafts
are deliberately not upload-ready observations.

The Implementation makes two deterministic bounded passes inside one live SQLite
snapshot: planning validates projected values and admits counts/frame sizes;
output supplies the same drafts for Host preparation. The source reader permits
one rewind only after a complete read. It does not reopen SQLite or create a
persistent cursor. Both passes share the original deadline and per-pass record
admission. Scope exit invalidates even a reader with buffered frames. A failed
output cannot resume; the Host must abandon unsealed preparation. This rescan is
never part of sealed delivery recovery.

Alternatives considered were retaining the entire projected target in memory and
spooling intermediate provider payloads to disk. Both would duplicate the Host's
bounded final-byte journal or weaken Raw-off behavior. Two passes retain only a
bounded source page, one pending frame, one output page, and metadata for the
bounded Thread family. Extra local reads buy a small Interface and keep provider
semantics local to this Adapter. The existing SQLite dependency makes this Seam
real; no mock-only projection service or repository is added.

## Origin evidence

An optional native `event` table must have supported columns, a single `id`
primary identity and an indexed `(aggregate_id,type,seq)` read path. Query at most
two root `session.created.1` records. Exactly one sequence-zero creation must
match the root ID, root creation time, absent parent and an absolute creation
directory. Bound source bytes before returning selected fields. The Origin key
hashes root/event identity; it never incorporates the database location or current
Session directory. The shared Host attribution resolver will consume this input.

Missing, ambiguous, oversized or mismatched evidence fails explicitly. Source
inspection remains possible without creation evidence, but publication projection
cannot invent it from current directories, assistant paths, task references or
the configured ATape Project. This probe does not claim the entire native event
log is complete or usable for crash recovery. The initial profile is the tested
OpenCode 1.18.30 schema, not a general historical-version compatibility promise.

## Projection semantics

Native parent chains define the root family. Independent forks stay independent;
task metadata can identify only a child whose native parent is the current Thread.
Only the tool call slot carries that relation. A fixed result slot uses the same
scoped correlation ID, and pending/running calls never fabricate a terminal result.
Native completed assistants are recognized by `time.completed`, including shell
messages with no `finish` string.
Running tool output and output retained in interrupted-tool metadata remain
visible; a failed result preserves both the actual partial output and its error.

The Active Path retains messages before a revert boundary and, for a part-boundary
revert, parts before the exact target part. The remaining stored suffix still
produces Raw frames; child Sessions remain when the native family retains them.
Compaction does not erase original tool output or create a new Thread. Source
lifecycle parts remain source-only; ignored text is source-only, synthetic/summary
text is derived. Unknown part types mark capture fidelity partial. Stable Event
and usage keys hash native Session/message/part/slot identities. Sequential
derived order is deterministic across pages; earlier insertion changes order,
which the Host must include in revision fingerprints.

Each `step-finish` supplies one independent usage record. Assistant/Session
aggregate counters are not summed or used as fallbacks. ATape input is native
input plus cache read/write, output is native output plus reasoning. A missing
component leaves that total unknown. Invalid counters and overflow fail rather
than becoming zero. A wholly unknown sample is omitted, as the shared Canonical
contract requires at least one actual counter. Step occurrence uses the source part creation timestamp when
no native part time is present, rather than a later message completion timestamp.

External/file attachment URIs are resource links and cause no fetch or file read.
Inline data and tool attachments remain Raw-only and mark the capture partial;
they cannot bypass Host text masking through Base64. No binary-content availability
is invented. Known lifecycle parts do not masquerade as assistant speech. These
explicit fidelity limits remain visible before this profile is registered.
Raw-off source queries return an inline-URI marker and attachment shape/count,
not the binary URI body or unused attachment elements.

## Validation and remaining work

Public Interface tests use actual SQLite, including selected official creation
events plus native root/child/fork messages/parts. Tests cover move/unknown Origin,
rewind/unrevert/deletion, tool states/foreign task references, completed shell
messages, per-step usage, compaction, media, same-time ordering, concurrent source
writes between plan/output, explicit bounds and scope exit. This package remains
private and unregistered. Host preparation, capability selection, scheduling,
bounded Raw browsing and native end-to-end/platform acceptance remain subsequent
increments; no release, deployment or database migration is authorized here.
