# ADR-0096: Repeated Claude planned Read-pair automatic replay and prior files

- Status: Accepted scope; implementation and acceptance are recorded in the feature guide
- Date: 2026-10-09

## Context

[ADR-0095](0095-claude-reversed-read-pair-results.md) completes the first
planned dual-Read automatic round and its ordinary continuation. A new native
Claude Code 2.1.263 invocation resumes that same Session only after a genuine
complete public Adapter ACK of its 46 physical LF records. The second round
reads two different literal files with fresh call/API identities. Its eight
originals and copies retain the existing slug, while its results arrive A/B
after the first round's B/A order. New B/S retain the current six P-through-A
UUIDs in physical order.

After the second S, native Claude appends two file attachments containing the
first round's complete stored Read receipts, in call order A/B. The real answer
pair follows the second file. One ordinary U/reminder/assistant turn connects
the two rounds; the second U follows that ordinary assistant. The old Adapter
preserves its ACK before the second replay, so replacing slug rejection alone
does not establish safe historical file provenance or resumable file stages.

## Decision

Keep the Claude Adapter Module's collect Interface, projection 4, legacy capture,
Event/usage/Raw identities and existing cursor fields. Its Implementation hides
the historical proof and recovery. Canonical, Raw and Search remain separately
owned; no Host/Server Seam, reset, migration or publication protocol is added.

Select two completed planned eight-record Read turns with exact original/copy
equality, the first added slug and the second unchanged common slug. Prove both
own-call result graphs, complete B/S retained metadata, distinct round/control
identities and the first real two-record answer. This historical dual profile
selects the observed first-round B/A and second-round A/B result orders. Reuse
the already selected own-call bijection rather than sort source results. Prove the
intervening ordinary turn as an external user, native token reminder and one
real index-0 text assistant with end_turn, its recorded parents/root/slug and a
distinct selected API identity. Only UUID-less admitted bookkeeping surrounds
that bridge. Native bookkeeping also flushes a last-prompt record naming the
current round's later reminder before the current U is physically appended;
that forward leaf must bind the exact current user text. Global seen/call
membership cannot replace this source proof.
The existing consecutive single-Read profile keeps its scope.

Derive the two expected historical files from the first turn's Read call
indices, independently of result arrival order. Each current literal path is
distinct from the selected historical paths. Bind each file's filename and
entire content object, including unknown values, to its proved historical
receipt. Do not open referenced workspace files or search arbitrary history
for a convenient matching receipt. Reject omitted, reordered, duplicate,
current-file and unrelated attachments, invalid controls or parent edges.

Commit each fully proved file independently as Raw-only while retaining the
existing pending autoText answer. Its seen suffix recognizes B/S and zero,
one or two proved files; no durable count field is needed. Reconstruct the
required sequence from authenticated committed-prefix bytes on restart,
including EOF. A real index-0 answer must follow the complete file sequence,
with valid recorded time, end_turn and a distinct selected API identity.
Pending Event fragments/deferred usage retain the state until that record
fully commits. A fabricated nonzero Event skip at summary/first-file EOF or
before the second file cannot bypass the required sequence. Existing complete
file-tail Event progress must match its next full valid answer and recorded
Event time. This verifies cursor/source consistency; it does not authenticate
coordinated cursor forgery or prove global historical API uniqueness.

Retain at most 64 complete physical LF records within 4 MiB for the historical
witness; each selected original/copy/control/bridge/first-answer/file frame fits
64 KiB including LF. Existing automatic 512 KiB original-tail and 640 KiB group
limits and ordinary/manual policies stay unchanged. Before acknowledging the
second B/S group or either file, prove that the proposed committed prefix still
retains the complete historical witness inside the same window. Preserve the
preceding recoverable ACK on unsupported/limit failures. Missing/partial input
waits without busy retry; independent Raw recovery retains its own receipts.
Prefix proof is O(committed prefix) I/O/hash with bounded serialized retention,
without an atomic filesystem snapshot or an RSS guarantee.

## Alternatives and verification

Ignoring files by type loses their historical provenance. A generic known-call
lookup admits stale branches and layouts absent from this source. A new durable
round/file counter adds an upgrade protocol without Leverage. Making both files
atomic couples their requested capacity and prevents independent first-file
ACKs. The bounded source-derived sequence provides Depth and Locality behind
the existing Interface and reuses the single-file profile's recovery rules.

Verify literal native cuts through public collect, fresh runtimes, one-Event
pages and identical retries. Cover both file boundaries, incomplete groups and
files, whole unknown-value equality, both rounds' graphs and the ordinary
bridge, cursor/answer faults, repair, prospective historical bounds, requested
fresh/remaining capacity and independent Raw off/backfill/advanced receipts.
Upgrade actual previous-main opaque ACKs, including its blocked second-round
input; do not construct an old summary/file checkpoint the old code never made.
Installed CLI/Adapter over authenticated HTTP/PostgreSQL must preserve old
Reader Events, both rounds' own-call anchors and source result order, latest-once
persisted API usage, message-only Search, full physical Raw and deletion retention.

This scope establishes the sampled two planned dual-Read rounds with one ordinary
bridge and two historical files. Further rounds, arbitrary bridges, same-path
changes, tool-only layouts, other/more/error/async/interleaved calls, children,
larger automatic witnesses and Active Path/fork/rewind adoption remain separate
work. Summary API usage absent from JSONL remains absent; controlled counters
are not billing. The [Claude guide](../../adapters/claude.md) owns actual checks
and material limits. Package publication and manual Server deployment remain
separately authorized actions.
