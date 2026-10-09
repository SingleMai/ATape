# ADR-0101: Claude Active Path and explicit legacy adoption

- Status: Accepted decision; implementation and verification belong to the Claude guide
- Date: 2026-10-09

## Context

The Claude legacy collect Interface can append new versions but cannot remove an
abandoned branch from the selected Canonical conversation. Merely admitting an
older parent would keep both branches in Reader and Search. Existing publication
sources support complete atomic replacement, but deliberately cannot adopt a
legacy Session. Existing source views also cannot describe a missing previously
captured child without either dropping it or blocking the root.

Isolated Claude Code 2.1.263 acquisition demonstrates both a truncating resume
followed by ordinary continuation and a live `rewind_conversation` control. Native
JSONL retains the abandoned physical records. A new user message can reconnect
to an earlier chain entry. A successful rewind without a new prompt appends an
explicit `last-prompt` leaf selector; rewinding before the first user appends an
explicit null selector. A still-running source may append descendants after that
selector before writing another last-prompt record. These are source facts, not
permission to select a branch using newest timestamps alone.

## Decision

Keep graph interpretation inside the Claude Adapter Module. Build a bounded
complete-source index and a deterministic capture plan, sharing the current
normalizer, text/thought/tool projection, usage selection and child relationship
rules with legacy validation. Track validated logical predecessors, including
correlated tool results and declared compaction continuity, rather than walking
ordinary `parentUuid` alone. Select the current path from native branch and leaf
evidence. Unknown selectors, contradictory identities, changed authenticated
prefixes, invalid correlations and unsupported graph transitions fail closed.
Root failures stop that target. A failed previously captured child retains its
prior authenticated proof and Canonical membership with a diagnostic while the
valid root advances; a never-captured failed child has no header or link.
An explicit empty selector is a valid empty current conversation, with stable
creation Origin. Compaction remains one generic reducer; replay copies never
add Events or usage or resurrect an abandoned sibling path.

The complete target includes the current root path and only its proved direct
completed foreground children. Preserve source Session/Thread/Event/Usage keys.
Root and child thinking, tools, latest-original API usage and existing unlinked
delegation diagnostics remain supported. Raw admission includes all physical
records, including copies and abandoned branches, separately from Canonical.

Use a versioned sourceCapture v2 Interface, with complete draft pages, bounded
diagnostics, prior Thread metadata and explicit retained Thread declarations.
Keep OpenCode's v1 Interface unchanged. Claude declares a separate explicit
legacy-migration capability and returns sourceCapture only, never two competing
writers. An old Host must reject the new manifest version rather than silently
discard fields whose interpretation changes replacement semantics.

The shared Host owns migration and recovery behind its existing collection
Interface. The Adapter validates and decodes its own opaque legacy checkpoint;
the shared workflow never parses Claude cursor internals or guesses Origins.
Acknowledged root UUIDs permit offline decoding. A genuine pending first record
can leave no root UUID in that checkpoint, and older cursor formats can omit its
stream state. Only then the Adapter resolves the original header through bounded
read-only source access, checks Session/CWD and any authenticated prefix, and
validates pending projection state before adoption. The Server verifies existing
capture ownership and source scope, then pins the supplied Origin for publication.
Legacy storage did not preserve a separate root UUID Origin: a zero-byte cursor
cannot authenticate its partly delivered first record's historical UUID/body.
The fallback validates current source evidence without claiming that unavailable
proof. Missing or ambiguous evidence produces a source
diagnostic; it never authorizes inventing an Origin or resetting progress.
Freeze migration binding to the installation, account, Project creation, old
checkpoint and acknowledged Raw metadata before remote adoption. Source-free
journal recovery runs before new provider work. Legacy has no durable prepared
outbox: do not invent one or discard genuine existing sourceCapture obligations.
Checkpoint compare-and-set and Server source fencing protect concurrent writers.
Frozen snapshots are immutable per checkpoint digest. Multiple attempted freezes
may exist after a compare-and-set race, but only the digest selected by the
global cursor owns migration. Persist the new opaque source checkpoint and prior
Thread metadata with activation; subsequent views validate that proof instead
of repeatedly interpreting the old legacy cursor.
Ordinary sourceCapture collection still rejects legacy checkpoints without the
explicit capability and migration validation.

Add an explicit, authenticated, provider-neutral `AdoptLegacy` operation to the
Publication Module. Ordinary reservation continues to reject legacy Sessions.
Adoption verifies the same capture scope and preserves the Session identity,
existing Canonical records, Raw ownership and receipts. It fences subsequent
legacy writes. Reader, Search and Overview continue selecting legacy data until
the first complete target activates. Preparation, upload, validation, timeout or
process failure must not expose a partial replacement. Activation selects the
new Canonical and Search head atomically. Version allocation must not reuse an
old source/projection version for changed content or Raw references.

Retaining a missing child is a Server operation over immutable, already stored
Canonical membership, bound to the target's base. A target explicitly declares
which nonroot Threads it retains. Their current parent relationship must still
be proved by the selected root and agree with the base; the Server must reject
contradictory, cross-source or root retention. Inherited Events, usage and Raw
references keep their original versions. A child whose root receipt leaves the
current path is omitted, not retained. A versioned target profile and advertised
capability prevent an old Server from ignoring retention. Fresh projected counts
remain the client's honest declaration; complete visible counts come from the
Server's resulting selected membership. Do not rewrite frozen client payloads
to pretend that it projected inherited records.

Preserve existing Raw objects, ownership, generation, receipts and usable links.
New sourceCapture targets use the existing Host prepared packed Raw format and
new legal Event versions. Raw-off old references without an uploaded object do
not establish an obligation to recreate that obsolete object identity. A later
Raw-enabled capture archives all available physical source history through the
new path. Source disappearance still prevents fresh backfill; frozen delivery
obligations remain recoverable without the source. No local permanent transcript
cache, provider-specific Server graph logic, package publication or deployment is
introduced by this decision.

Deliver complete physical Raw records to the Host before redaction. Do not split
unredacted strings across frames, which could break masking across boundaries.
The existing packed Raw object's per-record capacity remains an explicit limit;
admitting a 16 MiB source record does not guarantee that it fits the 3 MiB packed
Raw object. A larger redacted record reports a Raw limit gap. This increment does
not introduce a new multi-object Raw-record receipt protocol.

## Alternatives

1. Continue legacy append capture and admit older parents. This cannot retract
   abandoned Canonical/Search membership and gives an incorrect current view.
2. Provide legacy and sourceCapture simultaneously, selecting a writer per
   Session. This duplicates protocol selection, scheduling and recovery and
   still does not recover a missing child's previous content after migration.
3. Export all old Canonical content to a new Host transcript cache, then merge
   complete snapshots locally. This adds a broad transfer Interface and a new
   durable history lifetime to solve membership the Server already owns.
4. Use one sourceCapture workflow with explicit adoption and base-bound retained
   membership. This adds real production Seams where ownership varies, keeps
   provider knowledge local, and increases the Publication Module's Depth and
   Leverage without leaking migration steps to presentation callers.

Choose the fourth design. Keep migration preparation and ordering private to
the collection Implementation instead of exposing a prepare/adopt/finalize API
whose caller would have to reconstruct the workflow.

## Verification

Verify through installed factory/sourceCapture and collection Interfaces, using
the retained native snapshots separately from generated corruption mutations.
Cover rewind-only and empty rewind, new and subsequent messages, thoughts,
tools, latest usage, partial LF, retries, compaction, child retention/removal and
bounded diagnostics/Raw. Use genuine previous-main checkpoints and its frozen
installed artifact for migration evidence. Authenticated HTTP/PostgreSQL checks
must establish stable identities, old visibility before activation, atomic
Reader/Search/Overview replacement, Raw links, scope authorization, fencing,
concurrent CAS and source-free crash recovery. The feature guide records shipped
scope, checks actually run, remaining limits and the next increment.
