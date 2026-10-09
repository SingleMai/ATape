# ADR-0097: Claude compaction continuity through source identity

- Status: Accepted decision; implementation and verification belong to the Claude guide
- Date: 2026-10-09

## Context

[ADR-0094](0094-claude-repeated-single-read-auto-file.md) and
[ADR-0096](0096-claude-repeated-dual-read-auto-files.md) turned particular native
fixtures into admission templates. Their historical proof depends on the first
added slug, exactly two rounds, fixed intervening turns, tool counts and a short
window reaching the earlier round. Consequently a valid later compaction can
stop capture despite already understood source controls. Native evidence should
validate a reusable rule, rather than define a feature for each round number.

The product invariant is that a valid compaction establishes a continuation
point from which ordinary capture resumes. Repeating that operation must not
depend on how many previous compactions or ordinary turns occurred. Physical
replayed copies retain original UUIDs; boundaries and summaries have their own
identities. File reinjection and command scaffolding are source context, not new
user messages or billable model responses. A boundary does not declare an
expected number of reinjected files.

## Decision

Keep provider normalization inside the Claude Adapter Module. Its caller
Interface, Event projection revision 4, source identities and independent Raw
receipts remain unchanged. No new remote Seam, Server migration, source reset
or package-publication protocol is introduced. Canonical, Raw and Search keep
their existing ownership.

Use one source-control reducer for automatic and manual compaction. Its current
phases are replayed copies, required summary and continuation. Each phase
commits with complete physical records and survives EOF, incomplete next lines,
fresh runtimes and independent Raw progress. There is no round counter, fixed
tool count, required first-answer shape, fixed ordinary bridge or predicted file
count. Each real subsequent record returns to ordinary Event/usage projection.

Reconstruct normalization context from the same authenticated committed-prefix
bytes, with an index of original UUID locations and current graph context.
Compare a replayed copy with the complete decoded original, including unknown
values. The only admitted copy metadata difference is adding a slug when absent;
an existing slug remains unchanged. Copies produce neither Events nor usage.
They may commit independently as Raw-only context while the reducer waits for
the following boundary. A later conflicting control preserves the last valid
ACK; it does not retract already captured original messages.

A boundary must be a fresh source identity linked by its logical parent to the
current leaf. Validate its declared preserved identities, head, tail and fresh
summary anchor without inferring a fixed turn layout. Its summary must match
that anchor and boundary parent, with the source summary flags. Both remain
Raw-only. Retained UUIDs and copied UUIDs are different concepts: native text
compaction itself does not copy every retained record.

During continuation, typed file attachments, metadata, local command envelopes
and synthetic scaffolding remain Raw-only. Validate Thread identity and current
control-chain edges; do not invent a historical receipt requirement or require
all possible files before allowing the next real record. The exact source bytes
remain available in Raw. Ordinary edges must still advance the current leaf;
own-call result edges must belong to the currently open tool-response batch.
Global membership in seen UUIDs or historical tool calls does not authorize a
stale branch. A validated boundary is the explicit chain-reset operation.

Version private normalization independently from Event projection. Bootstrap
valid existing opaque checkpoints by rebuilding their committed source context
and checking their leaf, identities, calls and pending control state. Preserve
Event fragments and deferred usage; do not replay committed Events, change
their byte-based revisions, replace Raw generation or delete checkpoints.
Malformed checkpoints and changed/truncated source prefixes still fail.

Retain the existing bounded record parser and encoded/decoded checkpoint
capacity. Requested per-record Canonical and Raw budgets still apply. Remove
sample-specific 64-LF historical windows and atomic whole-replay requirements
that make continuation depend on distance from an earlier round. Prefix
reconstruction is bounded by actual source/checkpoint resources and costs
O(committed source) on a cold restart; it is not an atomic filesystem snapshot.

## Alternatives and verification

Extending the existing templates with another round repeats the same design
error. An atomic replay-group recognizer removes round counts but still couples
large compactions to one observation's budget. The selected per-record reducer
offers greater Depth and Locality behind the existing Interface. A fully durable
copy/receipt catalog would avoid cold scans but introduces a larger private
upgrade protocol and duplicates source data; source-derived context is the
smaller initial design.

Verify the public collect Interface with all existing native snapshots and
explicitly generated repeated-compaction sequences. Parameterize round counts,
ordinary gaps, tool batches/result order and zero or multiple context files.
Check append and restart at record and partial-line boundaries, exact retries,
small pages, Event fragments, usage deferral, Raw disabled/backfill and upgrades
from genuine old opaque inputs. Preserve original Event/usage identities and
Reader/Search anchors through installed-package and authenticated PostgreSQL
contracts. Test changed copies, conflicting B/S, stale parents and source repair.
Generated sequences are behavior tests, not claims of new native acquisition.

This supersedes the sample-specific compaction admission policies of ADR-0088
through ADR-0096; their native evidence remains evidence of its recorded source.
It does not itself implement fork/rewind/Active Path publication or loosen source
identity and committed-prefix integrity. The [Claude guide](../../adapters/claude.md)
owns current behavior, verification and material limits.
