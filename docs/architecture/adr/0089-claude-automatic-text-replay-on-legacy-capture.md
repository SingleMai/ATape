# ADR-0089: Claude automatic text replay on legacy capture

- Status: Accepted scope; implementation and acceptance are recorded in the feature guide
- Date: 2026-10-08

## Context

[ADR-0088](0088-claude-manual-compaction-on-legacy-capture.md) admits two native
manual compaction tail shapes without changing legacy capture. Automatic
compaction differs: native Claude Code 2.1.263 keeps the original file prefix,
copies the current user and token-reminder attachment UUIDs, then appends a
boundary, internal summary and real assistant answer. Ordinary strict-chain
collection rejects these repeated identities.

A controlled isolated run demonstrates three such rounds in resumed processes.
Each retained segment is exactly [A,U,G]: one real assistant text record A,
ordinary user U, and token-reminder attachment G, with direct A -> U -> G
parents. U/G are physically adjacent. The four appended control records are
copies of U/G, new boundary B and new summary S. The first copies add one common
slug to originals that have no slug; later copies preserve their existing common
slug and all other decoded values exactly. Every round uses new B/S identities
and the immediately following real answer is parented by S. Prior summaries
enter the model's context, but do not constitute additional user turns.

The run uses a loopback model mock and artificial usage to trigger compaction;
it is evidence of serialized source shape, not provider billing. The summary
model response has no assistant JSONL record. Wider copied tool histories,
replacement, cross-file continuation and rewind require separate decisions.

## Decision

Keep the public Claude Adapter Module Interface and projection revision 4.
Implement only the repeated fixture-proved root automatic text profile inside
the Claude source Implementation. The Host owns attribution, redaction,
Canonical/Raw uploads and checkpoint commits. No new uploader, Host/Server
Interface, Seam, source-capture manifest switch or checkpoint reset is introduced.

At an already-seen user candidate, admit a four-record transaction only when:

- A/U/G are the current committed prefix's last three unique UUID records, G
  is its final physical record and U/G are physically adjacent. A is a native
  root real assistant with one nonempty text block at API block index 0, valid
  API ID/model/role. U is ordinary non-meta user text; G is the sampled
  token-reminder attachment. All carry version 2.1.263 and selected root
  identity. Only sampled UUID-less bookkeeping kinds can separate A/U.
- Both copies match their complete decoded originals, including unknown fields,
  with exactly one of the sampled slug representations: A/U/G all omit slug and
  the copies add the same valid slug, or A/U/G already share that slug and both
  copies are completely equal. Object key order is irrelevant; array order and
  all values are exact. Mixed presence, changed existing slug or other changes
  are unsupported. Exact original source bytes remain the Raw authority.
- The next physically adjacent records are new root B/S, with matching slug.
  B is the native auto compact boundary, parent null and logical parent G;
  segment endpoints and both arrays name exactly [A,U,G], and both anchors name
  S. S is the native nonempty user-shaped summary parented by B, carrying both
  compact-summary flags and U's prompt identity. The sampled B/S omission of
  isMeta is retained; context counters are not assistant usage.

Prove originals from the same bytes that establish the current prefix hash.
Stream exactly 0..the current committed offset through the open source handle,
hashing while retaining a bounded LF-framed tail. Compare to the current hash,
including any A/U/G newly committed on the same page, then decode witnesses from
those retained bytes. Do not read an unauthenticated tail after a hash pass or
use seen UUID membership as semantic evidence. A record enters this prefix only
after all its Events and usage are admitted.

Before the first UUID record is admitted, compare its original identity with the
attributed header, including its CWD. Those actual committed bytes then join the
same prefix proof. This rejects a root rewrite between attribution and collection
without adding a separate root tail ledger or a smaller original-root record cap.
Compare parsed copied JSON with an explicit worklist: primitive values stay
exact, array order/length and object own-key/value sets stay exact, while nesting
does not consume the JavaScript call stack. Unknown fields are not normalized or
discarded, and this does not add a separate source-depth policy.

The Implementation policy caps each witness/control record at 64 KiB including
LF, the four-record group and retained tail at 256 KiB each, and tail decoding
at 16 physical records. These are admission limits, not native format limits.
After a complete first copy is identified, cap its admission and use bounded
lookahead for the remaining three slots. An unclassified first partial line
still uses ordinary parsing's 16 MiB limit: it may instead be a legitimate large
conversation record. The required real answer retains ordinary
text fragmentation and Canonical capacity rules. Prefix proof costs O(committed
prefix) I/O/hash; only retained proof memory and semantic decoding are bounded.
This does not impose a maximum total source size or supply an atomic snapshot.

If all four records validate and fit the fresh source-page capacity, commit
them together: exact bytes/hash/offset, physical order plus four, seen adds only
new B/S and last UUID becomes S. Emit no Events or usage for any control slot,
preserve calls/children/title and finish that page. Raw transport may independently
split the admitted prefix according to normal upload receipts and UTF-8 bounds.
If the group fits a fresh page but lacks current remaining capacity, defer the
whole group and return earlier progress. A permanently oversized group fails
with a typed source limit. Parser offset/hash/state cannot cross an individual
copy before the complete group proves. Once proved, independent Raw receipts
may stop within a copy while the Host still retains the input parser cursor;
normal retry revalidates the group and resumes those receipts. This is not a
multi-request Host/Server transaction.

An optional private stream autoText state stores v:1, boundaryUuid, summaryUuid,
promptId and slug. It always means waiting for the first real answer. Its B/S
are the last two unique seen UUIDs, lastUuid is S and it requires a resumable
projection-4/usage-version-1 cursor. Reject invalid state and child checkpoints
carrying it; never silently drop recognized state during cursor decoding.
It is mutually exclusive with active manual compaction state.

The next complete record must be the sampled root real single-text assistant at
block index 0, parent S and admitted slug. Keep the state while Events fragment
or usage is deferred; clear it only when the entire record and its exact prefix
commit. Exact EOF remains pending without inventing an answer or immediate
busy-loop continuation. No completed-round flag or counter is stored. Every
later group needs fresh proof of its current A/U/G and unseen B/S, so a previous
group cannot be reused after the answer or while another answer is pending.

Incomplete slots wait without advancing beyond the first copy; complete malformed
or conflicting slots fail through existing source failure isolation and preserve
the input acknowledged cursor. If earlier ordinary progress is returned for a
waiting/deferred group, that page can be acknowledged normally. A whole failed
Session call does not persist temporary progress made earlier in that call.
Existing version-1 Session, version-2 discovery and compressed z3 cursors remain
supported without resetting or replaying unchanged projection-4 history.

## Alternatives and consequences

- Migrate Claude to atomic source publication before handling automatic replay:
  supports wider replacement semantics only with explicit generic legacy
  adoption and retained Raw/checkpoint ownership. This sampled append case does
  not need that larger Interface change.
- Flatten source order or skip all seen UUIDs: hides conflicting branches and
  treats identity repetition as proof of semantic equality. Rejected.
- Persist a semantic tail ledger in every cursor: saves reread I/O but expands
  durable compatibility and needs recovery for existing cursors. Selected lazy
  bounded source proof keeps this knowledge local to the Adapter Implementation.
- Admit one automatic round only: would be a delivery policy, not a source
  integrity requirement. Three native rounds prove repeated current-tail groups;
  each admitted round retains the same strict proof and pending-answer contract.

The selected design adds Leverage without expanding the caller Interface and
preserves Depth and Locality in the Claude Module. It retains pre-compaction
chronological conversation and stable Event, Session, Thread and Raw identities.
Copies and summaries stay out of Reader/Search; only actual recorded assistant
responses contribute latest-revision usage. Summary-call usage remains unavailable.

Same-handle hashing is not a frozen filesystem snapshot. The inherited final
stat permits growth; a prefix rewrite plus append after proof can evade existing
checks. Do not claim atomic replacement or concurrent-writer protection beyond
the captured-prefix and final-stat checks.

## Verification and remaining scope

Verify through public Adapter and installed package Interfaces: all three native
rounds, fresh and supported old cursors, same-page originals, byte/line cuts,
runtime restart and exact retry, full Raw off/on backfill, strict copy equality,
current-tail reuse rejection, pending answer fragmentation/usage, budgets and
prefix changes. Verify through installed managed Collector and authenticated
HTTP/PostgreSQL that old Reader/Search content remains, user copies and internal
summaries add no Events, real answers append once, actual recorded usage upserts
once by API ID, Raw offsets/generation remain stable and source deletion retains
captured history.

The [Claude guide](../../adapters/claude.md) owns actual checks and delivery status.
This decision does not admit tools inside the retained segment, copied assistant
records, arbitrary replay, child compaction, cross-file history, forks/rewind or
Active Path replacement. Composition with wider manual/auto shapes and other
Claude versions needs source evidence. Publication and deployment remain separate.

[ADR-0091](0091-claude-read-turn-automatic-replay.md) separately selects two
first-slug native Read-turn replay shapes; it preserves this text profile's
repeated-round scope and resource policies.
