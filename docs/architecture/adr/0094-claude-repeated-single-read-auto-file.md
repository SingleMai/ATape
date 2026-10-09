# ADR-0094: Repeated Claude single-Read automatic replay and prior-file reinjection

- Status: Accepted scope; implementation and acceptance are recorded in the feature guide
- Date: 2026-10-08

## Later decision

[ADR-0097](0097-claude-compaction-continuity.md) supersedes the sample-specific
compaction admission and recovery policies with source-identity continuity.
The original source evidence and checks below retain their recorded scope.
The [current Claude guide](../../adapters/claude.md) owns implementation and
acceptance of the later decision.

## Context

Amendment: [ADR-0096](0096-claude-repeated-dual-read-auto-files.md) later selects
the separately acquired planned dual continuation and two historical files.
The single-Read decision and its recorded native scope below remain unchanged.

[ADR-0091](0091-claude-read-turn-automatic-replay.md) selects first-slug
single/exact-two Read replay. A new isolated Claude Code 2.1.263 root Session
performs two consecutive single-Read automatic rounds and an ordinary resume.
The first round has a genuine complete public Adapter ACK before the second
native invocation. Each round reads a different real file with a fresh call/API
identity. The second six-record original/copy turn preserves the first slug
exactly, with new B/S and its current four retained P-through-A UUIDs.

After the second summary S, native Claude appends one file attachment containing
the complete first round's successful Read receipt. The new real index-0 answer
is parented by that file, rather than S. Removing the slug barrier alone still
stops this usable continuation. An independent two-Read capture returned its
results in reverse order and could not reach its first complete Adapter ACK;
it establishes no repeated two-Read support.

## Decision

Keep the Claude Adapter Module's collect Interface, legacy capture mode,
projection 4, identities and existing cursor fields. Provider-specific proof
remains inside its Implementation. Canonical, Raw and Search keep their existing
ownership; no Host/Server Seam, publication protocol or migration is added.

Admit an existing common slug for the six-record single-Read profile only when
all originals have it and each entire decoded copy equals its original. Preserve
the existing first-slug single/two-Read and repeated text profiles. Mixed/changed
slugs, changed unknown values, stale turns and reused B/S remain unsupported.

A separate bounded historical witness admits exactly one prior-file attachment
after the second single-Read summary. Reconstruct both consecutive single turns,
their complete copies and B/S, and the first round's two real answer records
from the same authenticated committed-prefix bytes. Check their original
own-call graphs, current seen-tail identities, retained metadata, first/common
slug rules and answer parents/API indices. The later user must follow the first
answer leaf. The old and current literal Read paths must differ. Compare the
attachment's entire stored receipt with the proved first successful Read receipt,
including unknown fields, rather than rereading a workspace file or trusting
known-call membership. Reject additional, current-file or unrelated attachments.

The file frame is at most 64 KiB including LF. Historical reconstruction retains
at most 64 physical LF frames within 4 MiB; selected witness frames also have
64 KiB limits. These are this new Adapter profile's policy limits, not native
format ceilings. Earlier ordinary large records may fall outside the witness;
existing automatic 64 KiB/512 KiB/640 KiB and manual larger-frame policies stay
unchanged. Prefix proof remains O(committed prefix) I/O/hash with bounded retained
serialized bytes, without an atomic filesystem snapshot or an RSS guarantee.
Before acknowledging the second replay group or its file, prove the proposed
committed prefix with that group's new B/S or file seen tail. Adding those
frames must leave the complete witness inside the same window. A proof that
fits only before the append cannot authorize an ACK that cannot be resumed.

Commit the fully proved file as Raw-only while retaining the existing autoText
pending answer. Its recognized seen tail is B/S/file, with the file as lastUuid.
No new field or round counter is necessary. Re-prove that file state against the
current prefix before admitting an index-0 real answer parented by the file.
Keep pending state through Event fragments and deferred usage; clear it only
when the complete answer record commits. The newly selected real answer has a
valid recorded timestamp, a fresh API ID and end_turn; the first historical
answer pair also has end_turn and a distinct API identity. Known async/status
controls on the new file must be absent, while unrelated unknown values remain
preserved. Nonzero Event progress at the file tail requires a complete valid
next answer, bounded Event skip and consistent recorded Event time. EOF/partial
input cannot supply that state. This is cursor/source consistency, not cursor
authentication against coordinated forgery or timestamp collisions.
Incomplete or conflicting file/answer records preserve the caller's input ACK.
Independent Raw receipts retain their existing contiguous recovery. File EOF
with zero Event progress remains pending without busy retries.

## Alternatives and verification

Ignoring attachments by type loses their provenance and allows an unrelated file
to replace the required answer. A generic search for any historical Read has
less Locality and admits layouts the source did not establish. A separate durable
file stage duplicates the existing pending-answer state and requires another
compatibility protocol; the authenticated B/S/file tail supplies the needed Depth
behind the existing Interface.

Verify the literal native prefixes through public collection, fresh runtimes,
one-Event pages and identical retries. Cover every incomplete group/file slot,
whole unknown-value equality, wrong historical/current paths, graph and cursor
faults, pending/fractured answers, source repair, requested fresh/remaining
capacity and Raw off/backfill/advanced receipts. Upgrade actual previous merged
opaque ACKs rather than constructing old checkpoints. Installed CLI/Adapter over
authenticated HTTP/PostgreSQL must preserve prior Reader Events, own-call result
anchors, latest-once actual API usage, message-only Search and complete physical
Raw bytes through idle restarts and deletion.

This increment establishes two consecutive single-Read rounds with one prior
file. Repeated two-Read, reverse result order, further rounds/multiple reinjected
files, same-path changes, larger automatic witnesses, other tools/children and
Active Path/fork/rewind adoption remain separate work. Missing summary API usage
remains missing; controlled usage counters are not billing. The
[Claude guide](../../adapters/claude.md) owns actual acceptance. Publication and
manual Server deployment remain separately authorized actions.
