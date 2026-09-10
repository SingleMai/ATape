# OpenCode capture and publication contract

This is the engineering contract selected with ADR-0058 and ADR-0059. See the
[feature guide](../adapters/opencode.md) for landed increments and remaining
production acceptance. OpenCode is not yet enabled as an Adapter.
It extends the existing pull architecture through an explicit capability; old
Adapters and already captured legacy Sessions keep their existing write mode.

## Module responsibilities

| Module / Seam | Owns | Keeps hidden from callers |
| --- | --- | --- |
| OpenCode Adapter | Read-only source discovery, capability probe, identity evidence, row interpretation, Active Path and observation encoding | SQLite schema, provider relationships and read consistency |
| Collector | Capture lifetime, bounds, transformation, prepared units, remote ordering, recovery and source progress | Retries, partial receipts, resource pressure and remote uncertainty |
| Local journal Adapter | Transactional reservations, manifests, pending payload units, receipts, coverage and ownership epochs | SQLite transactions, storage lifecycle and paginated access |
| Canonical publication | Authorization, write mode, candidate validation, head activation and durable Search work | Distributed writer conflicts and partial candidate invisibility |
| Raw Archive | Stable Session ownership, independent write authority, immutable objects and real receipts | Offset/fence reconciliation and partial delivery |
| Reader / Search | A consistent selected head and membership-qualified results | Provider-specific rewind and source storage details |

The Collector Interface provides a resumable operation over these dependencies.
It does not return a collection of transport/retry steps for Presentation to run.
TypeScript side effects, failures, requirements and resource scope use Effect;
the Go Server uses ordinary Modules with Fx only at its executable root.

## 1. Source identity and content

Use the native root Session ID for the source Session identity, scoped by the
existing installation/provider binding. Each native Session is a Thread.
Identity does not incorporate DB path, current CWD, title or content. Conflicting
duplicate source IDs require diagnosis rather than a path-dependent rename.

Resolve ownership before publication. Native parent chains establish the root;
task references are call relations, not permission to move a child across roots.
A proven family with uncertain immediate parent may use a Detached Subagent
Thread. A family or Origin that cannot be proved remains unpublished with a
source diagnostic. Do not introduce an implicit manual-attribution workflow.

Forks retain their copied prefix under their own native IDs. Compaction remains
inside the same Thread; use stored source history, not the model-input conversion
that substitutes compacted tool outputs. Source deletion never deletes captured
ATape history. A successful complete-scope comparison may record observed
absence; a missing page or a failed query cannot establish deletion.

Event keys combine native Session/message/part IDs and a versioned projection
slot. Call/result slots share a scoped tool correlation ID. Persist change
fingerprints and assigned revisions independently of capture retry; hashes and
milliseconds are not monotonic counters. A→B→A can be a new observed revision.
Use source occurrence time, a separate fixed observedAt, and deterministic
native/derived ordering with stable tie-breakers.

The first capability publishes replacement targets. A target explicitly names
its Session metadata, Thread topology, Event and usage membership. Omitted
members leave the current view only at successful activation. Copied fork usage
belongs to that captured history and is not evidence of newly incurred spend.

## 2. Reserve and Begin

Atomically reserve local source identity/origin, input checkpoint, attempt
identity and Begin request before a remote Begin. Authoritative source/Project
checks precede the reservation. Installation binding loss or journal corruption
must not silently initialize a different owner and overwrite existing progress.

Begin binds the stable Session, explicit publication mode, immutable base head,
candidate identity, writer fence and finite lease. Repeated identical Begin
requests return the same result; the same key with different content conflicts.
Begin is a control operation before capture, not a content upload.

The remote retry identity must have server-verifiable finite validity. Select a
server-issued, scope-bound reservation token for an initial Begin; losing that
token before local persistence only leaves a quota-bound, expiring reservation.
Persist it before Begin. An expired token cannot create a fresh attempt after
receipt cleanup. Existing successful request lookup still checks authorization
before returning its original receipt.

The Server advertises lease/renewal and lookup validity. Renew only an unchanged
still-authoritative attempt; never renew a stale fence into ownership of a newer
base. On expiration, query/reconcile. A missing expired receipt means unknown,
not permission to assume that no activation occurred.

## 3. Prepare and local seal

After Begin, read the chosen source scope in a controlled SQLite transaction.
Check size metadata before loading large TEXT values; row-count limits alone
are insufficient. Build a complete membership manifest while emitting bounded
units to Host-controlled staging. The Host validates, redacts and prepares the
actual Canonical wire values and Raw transport bytes, including encoding and
packing identities. It must not rely on rerunning a changed converter on retry.

Use the local journal's SQLite Implementation for both manifests and bounded
pending payload units, with indexed scope/state access. Do not serialize all
history as one BLOB or select all pending BLOBs into memory. Keep any existing
JSON state/installation identity through a versioned binding/migration boundary;
this does not silently convert the existing Adapters to the new capability.

Transactionally seal the manifest only when every promised page, metadata delta,
reserved revision, input/output progress relation and needed delivery body is
durable. Until then, no content part is sent. Close the source view before network
delivery. Unsealed recovery never attaches newly read tail pages to an old view;
discard that candidate and capture again using an authoritative attempt.

The budget Interface includes per-record/unit bytes, per-target bytes, total
pending bytes, metadata page sizes, read/capture deadlines and concurrency. It
reserves quota for a target before sealing, reports exhaustion as backpressure,
and does not evict another unacknowledged target to make room. It measures
prepared content, not source DB file size; large independent Sessions can be
processed separately. A target that exceeds available quota remains unpublished
or keeps its old view and reports the required capacity. Numeric defaults are
selected and stress-tested with the first release, not guessed from tiny models.

Keep current whole-record masking bounds until the byte-framed capability is
implemented. Unsupported large Raw records are explicitly partial/limited;
they are never truncated or Base64-encoded to evade masking. A missing Raw
projection cannot be counted as a successful Raw obligation. Canonical partial
content follows the existing shared bounded-value fidelity rules.

## 4. Remote staging, validation and activation

Put numbered parts with immutable digests. The same part/digest is a no-op
replay; changing content under that identity conflicts. Remote seal binds the
complete part set, replacement mode, base and transform versions. Validate
membership, unique source keys, topology, references, ownership and counts with
bounded, resumable work. Incomplete or invalid candidates cannot activate.

First Activate checks current authorization and lifecycle, write mode, lease,
writer fence, validated state and `currentHead == baseHead`. One short database
transaction writes the new pointer, the activation receipt, visible aggregates
and durable Search work. Expensive parsing or whole-target validation does not
belong inside that transaction.

When an attempt already activated, check authorization then return its original
activation receipt. Do not write the pointer again, even if currentHead is now
newer or the original lease has expired. Unknown transport results use this
operation/status lookup to recover; a changed fence before first activation
requires a new Begin and source capture rather than renaming old payload.

Readers select one active head. Page requests carry it and receive an explicit
refresh response when it is no longer the selected head. Search queries join
current membership and the appropriate content/search descriptor, so withdrawn
or outdated indexed rows stop matching at activation. New indexing is
asynchronous; stale workers cannot mark a newer descriptor as indexed.

## 5. Raw observation and references

Raw describes complete row states actually observed, with a versioned ATape
envelope: fixed observation identity/time, table/row identity, source relations,
operation and source JSON including unknown fields. It is not a native OpenCode
event journal or a SQLite file backup. Preserve original legal JSON text where
promised, subject to declared masking; parsing and re-encoding do not preserve
original bytes by themselves.

Pack complete records into bounded immutable objects. Each object uses one
generation permanently. Reserve object/record IDs before network effects;
later changes use new objects. Source offsets and redacted transport offsets are
separate metadata. Fragment identities do not claim byte offsets after masking.

When Raw is enabled during preparation, Canonical may reference the fixed object
before upload completes. The reader must show it as not ready/unavailable until
the corresponding archive exists; it must never redirect to a newer object.
An upload failure does not require withdrawing the published Canonical target.

When Raw is disabled during preparation, retain only needed Canonical projection
data and ordinary source progress metadata. Do not preserve complete source JSON
or scan extra fields for future archival. That Canonical version's reference is
unavailable and remains so. Re-enabling Raw can independently archive a fresh
observation of rows still present, reachable from the Session archive; it cannot
retroactively prove the old Raw or change the old Canonical version solely to add
a link. Row ID, timestamp or matching projected text is insufficient proof of
identical full source bytes. This first capability does not require ADR-0028's
opaque multi-generation anchor.

## 6. Independent recovery and completion

Record actual activation separately from Raw acknowledgements. Raw delivery
requires the activated capture's genuine proof, current Raw permission and an
independent Raw ownership/fence, against the stable Session lifecycle. The
capture need not remain the latest Canonical head. Raw result uncertainty is
reconciled using caller-scoped metadata or the same fixed write identity, never
by downloading remote Raw bodies as a recovery source.

Each Raw obligation has a pending/acknowledged/canceledByPolicy disposition.
Cancellation stores no fabricated receipt and advances no Raw source/server
offset. After a policy change, continue Canonical work, retain actual receipts
and mark archive coverage gaps explicitly. Re-enabling does not resurrect
discarded pending bodies or silently re-sign stale writes.

The local transaction commits activation/receipt/disposition, source coverage,
scanner progress and reclaim eligibility together. A successful target may
advance its Canonical coverage while Raw remains independently pending; only
completed or explicitly canceled obligations release their required payloads.
The scanner never calls a Raw gap complete merely because its cursor advanced.

Use local ownership epochs and CAS to fence both progress writes and reclamation;
remote fences independently protect server effects. Journal deletion/corruption,
binding mismatch, unknown remote outcomes, disk exhaustion and failed cleanup
are observable errors. Garbage collection is restartable and removes only
unsealed abandoned staging or content proved unneeded. No TTL turns an
unacknowledged delivery into success. Expired remote authority may require
explicit reconciliation; it does not authorize old payload to bypass current
permission checks.

## 7. Required evidence before delivery

The native prototype must exercise the selected public Interfaces: controlled
OpenCode SQLite/export parity; root/child/fork/revert/compaction; multiple pages
and large values; source mutation and process restarts; missing parts; competing
fences; activation commit with lost response; old receipt replay after a newer
head; head-aware readers and asynchronous Search; Raw recovery after a newer
head; policy off/on and cancellation; journal/lease/receipt loss; quotas and
cleanup. Include actual PostgreSQL/HTTP and supported-runtime/OS checks.

The existing scratch SQLite models provide evidence for individual transaction
and state-machine claims only. They do not satisfy these gates. Follow the
repository cadence: land one usable capability increment through required PR
checks before expanding the next. Package publication, Server deployment and
running production migrations remain separate actions.
