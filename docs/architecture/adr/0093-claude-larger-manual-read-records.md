# ADR-0093: Larger Claude manual Read records

- Status: Accepted scope; implementation and acceptance are recorded in the feature guide
- Date: 2026-10-08

## Context

[ADR-0092](0092-claude-manual-read-file-reinjection.md) proves two successful
root Read results, manual compact controls, reverse-order file reinjection and
the later internal Continue/bridge. Its 64 KiB selected-frame limit can reject a
Read result that ordinary collection already admitted, stopping real later turns.
Increasing the caller's source-page budget cannot overcome this Adapter limit.

A new controlled Claude Code 2.1.263 Session actually reads two 98,304-byte files
without truncation, performs manual compact and resumes twice. Its original
receipt frames are approximately 194 KiB; reinjected file frames approximately
97 KiB. The UUID graph has the same ten adjacent originals and two atomic
groups. Additional UUID-less mode/atis-latch records use the existing proof's
bookkeeping shape, but the generic compaction transition rejects them after
files. This decision admits them only within the proved file continuation.
The source snapshots retain strict byte prefixes; entire
stored file objects equal the earlier receipts. Source evidence does not prove
caller acceptance or the largest native-supported file size.

Original receipt records include both tool-result text and stored file content.
The policy must count complete UTF-8 JSONL frames including LF, paths, escaping
and unknown values, rather than promise a limit on file-body bytes.

## Decision

Keep the Claude Adapter Module and its collect Interface, existing opaque
projection-4 checkpoints and two-group ordering. Provider proof remains private
to its Implementation; the Host still owns delivery, Raw policy and checkpoints.
No new Seam, cursor field, migration or Server provider rule is introduced.

- Only selected original receipt slots R0/R1 may use 2 MiB frames. Other selected
  originals, the five compact controls and Meta/synthetic records keep 64 KiB.
- Selected file slots B/A may each use 1 MiB frames; their complete two-record
  group is at most 2 MiB. The separate Meta/synthetic group keeps 128 KiB.
  Each group must fit fresh requested source capacity, including with Raw off;
  insufficient remaining capacity defers the whole group.
- A bounded ring may retain larger potential Read-result records. This
  classification controls storage only. Independently enforce the selected
  positional caps, physical adjacency, current-prefix hash, complete identity
  and own-call graph before admission. Compact control slots 0..4 never receive
  the larger candidate limit; slots 5/6 retain larger values only for file
  candidates. Oversized unrelated earlier records can still fall out of the ring.
- Authenticate the same committed source bytes, including records completely
  committed earlier on the page. Compare entire decoded receipt/file objects,
  including unknown values, using the existing iterative equality. Do not reopen
  source files, omit values, loosen depth or use a remembered call as proof.
- A first unclassified partial record keeps ordinary 16 MiB scanning. Recognized
  second file slots use the 1 MiB limit; an occupied cap without LF cannot fit a
  complete frame and fails. Meta second-slot limits remain unchanged. Complete
  conflicts and capacity failures preserve the caller's input ACK.
- Full file/bridge groups remain Raw-only and atomic for parser admission;
  independent Raw receipts may advance inside a proved group while retaining an
  older parser cursor. Retrying re-proves the group, preserves Raw identity and
  continues contiguous bytes. Real Events and latest recorded API usage retain
  their identities; no internal file/control usage is invented.
- After a committed file pair, authenticate the current prefix, selected files
  and incoming bookkeeping before preserving the resume stage in a Raw-only
  transition. This includes the newly sampled mode/atis-latch slots. The generic
  no-file compaction transition and its bookkeeping types remain unchanged;
  seeing these type names alone cannot authorize source progress.

The larger envelope is an Adapter policy choice with headroom above the observed
sample, not a native format ceiling. It does not cover all ordinary 16 MiB
records. Automatic text/tool proof, ordinary Read-pair call proof and no-file
manual behavior keep their existing limits. The shared Canonical tool-value
64 KiB/depth/node policy also stays: large tool output is omitted from Canonical
details while actually captured Raw retains its complete bytes.

## Resources and alternatives

For a valid selected graph, original frames total at most 4.5 MiB, five controls
add 320 KiB and files add 2 MiB: 6.8125 MiB of serialized frame equivalents.
Meta/bridge adds at most 128 KiB. An untrusted ten-record candidate ring can
retain ten 2 MiB potential receipts before graph validation; adding bounded
control/file slots gives a worst-case 22.3125 MiB of serialized equivalents.
These figures exclude the ordinary 16 MiB scanner, transient decoding, JSON
objects, incoming buffers and equality worklist; they are not RSS guarantees.
Prefix verification remains O(committed prefix) I/O/hash/decoding, with existing
concurrent-writer limitations and no atomic filesystem snapshot.

A uniform 1 MiB receipt/file limit would cover the observed sample but gives less
headroom to the duplicate content in original receipts. Separate 2/1 MiB limits
make the resource Interface explicit and retain Locality behind the same caller
contract. The file group occupies one eighth of default 16 MiB source capacity.

A private resumable per-file checkpoint could admit individual records up to
ordinary 16 MiB without requiring a two-file group to fit one page. It changes
ACK ordering, adds durable compatibility states and requires new pending,
malformed-cursor, Raw-receipt and source-repair recovery rules. That greater
Leverage is unnecessary for this usable envelope; it remains a separate design
if larger real histories require it. Raising every limit to 16 MiB would still
leave pairs too large for fresh default capacity and obscure retained memory.

## Verification and remaining scope

Use the public Adapter, previous actual opaque checkpoints, installed package
and authenticated managed CLI/HTTP/PostgreSQL Interfaces. Verify native snapshots,
fresh-runtime identical retries, receipt/tool links with omitted large Canonical
details, exact Raw, latest-once usage, real-message-only Search and old Reader
prefixes. Cover exact/above selected caps, remaining/fresh capacity, all partial
slots, independently advanced Raw receipts, source repair, unknown values and
the unchanged smaller control/automatic bounds. Measure larger-source resource
behavior separately from serialized capacity calculations.

Single/no-plan/more/error/async tools, repeated file reinjection, other orders,
children, larger automatic replay and Active Path/fork/rewind adoption remain
separate work. Parser-first unsupported-tail Raw backfill and concurrent source
rewrite limitations persist. Controlled counters are not billing; missing
summary API usage remains missing. The [Claude guide](../../adapters/claude.md)
owns actual implementation and acceptance. Publication and Server deployment
require their separate authorization.
