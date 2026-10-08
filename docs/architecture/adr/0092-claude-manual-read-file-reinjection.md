# ADR-0092: Claude manual Read file reinjection

- Status: Accepted scope; implementation and acceptance are recorded in the feature guide
- Date: 2026-10-08

[ADR-0093](0093-claude-larger-manual-read-records.md) later selects separate
larger receipt/file bounds for this same graph; the original decision below
records the smaller initial envelope. The current guide owns implemented scope.

## Context

[ADR-0088](0088-claude-manual-compaction-on-legacy-capture.md) admits selected
manual text tails and their internal control sequence without replacing the
Active Path. [ADR-0090](0090-claude-read-pair-result-parents.md) admits successful
own-call Read pairs; [ADR-0091](0091-claude-read-turn-automatic-replay.md) adds
selected automatic Read replay. These decisions do not admit manual file
reinjection.

A controlled Claude Code 2.1.263 root Session records a text plan, two successful
Read calls/results, a token reminder and two final text blocks. Manual compact
preserves only those final text blocks. After boundary, summary and local
command controls, two new file attachments reinject the Read results in reverse
call order. Each complete attachment content object equals its corresponding
persisted toolUseResult. On the next process, an internal Meta Continue and a
zero-token synthetic assistant precede the real user turn. Summary and files
actually reach model context; they remain provider-generated internal records.

The current reader stops at the first file attachment, preventing capture of
later real turns. The source remains append-only and no old UUID is replayed,
so this case does not require legacy-to-publication adoption.

## Decision

Keep the existing Claude Adapter Module and collect Interface. Provider proof,
bounded parsing and internal-record admission stay inside its Implementation;
the Host retains delivery, redaction, Raw policy and checkpoint ownership. No
new Interface, Seam, Server provider rule, cursor field or projection revision
is introduced.

- Select only the sampled first-slug manual root shape: ten physically adjacent
  originals U/G/P/C0/C1/R0/R1/reminder/A0/A1. The plan and calls share one real
  API response at indices 0/1/2; successful ordered results name their own
  calls, literal paths and common user prompt. The final texts share a later
  API response at indices 0/1. The manual retained metadata names exactly A0/A1.
- Authenticate the current committed prefix through the same open source handle,
  hashing those exact bytes. Retain bounded candidate originals with physical
  positions, then revalidate the selected boundary/summary/caveat/command/stdout
  chain and root Session/CWD/version/ownership. Current calls-map membership or
  the saved compaction phase alone cannot authorize file contents or control
  position. Originals become proof only after Events, usage and bytes commit.
- Oversized unrelated earlier records fall out of the candidate ring; the new
  witness cap applies to selected records. Allowed UUID-less bookkeeping carries
  the sampled root Session identity and cannot insert graph/control evidence or
  change the current leaf. Bookkeeping between original records breaks adjacency.
- Prove the two adjacent files B then A against the entire corresponding receipt
  objects, including unknown decoded values. Filename, original Read input and
  receipt filePath agree literally. Do not reopen files or normalize paths to
  create evidence. Both new file UUIDs, parent edges and native markers agree
  with the selected root and compact slug.
- Commit both files as one Raw-only parser group and leave compaction in resume.
  The compact EOF can therefore commit without waiting for a later process.
  Then admit Meta Continue and its adjacent zero-token synthetic bridge as a
  second Raw-only group, proving the already committed file pair again. Clear
  compaction only after the second group commits. Neither group can acknowledge
  its first record alone. A direct synthetic bridge remains valid only at a
  proved stdout leaf in the existing no-file profile; the file branch cannot
  omit or duplicate Meta Continue.
- After the bridge, ordinary user/assistant admission resumes. The sampled Meta
  and user share a new prompt, but this design does not persist a new real-user
  prompt protocol. Files, summary, controls, Meta and synthetic records emit no
  Canonical Events or usage. Missing summary API usage is not reconstructed from
  stdout, context counts or captured model requests.

New selected witness/control/file/bridge records are at most 64 KiB including
LF; each two-record group is at most 128 KiB. Ten original witnesses and five
manual control witnesses have bounded retained storage. Prefix verification is
O(committed prefix) I/O/hash with existing ordinary scanning limits; it does not
supply an atomic filesystem snapshot against concurrent source rewrites.

An incomplete second slot waits before the group; a conflicting complete slot
fails at the same acknowledged cursor. A group must fit fresh source capacity
even with Raw disabled; insufficient remaining page capacity defers the whole
group. Independent Raw receipts can advance inside a proved group while the
Host retains its older parser cursor. A retry re-proves the group and continues
Raw bytes without changing source object/generation or replaying old Events.
Group atomicity concerns parser admission, not a distributed Server transaction.
At caught-up resume EOF, existing progress semantics need not report a pending
Canonical Session merely because a later process may append a bridge.

## Alternatives and consequences

Two atomic groups (selected) preserve Depth and Locality behind the same caller
Interface and opaque checkpoint format. They require a new prefix proof at
each group and cannot acknowledge a lone file or lone Meta record.

A private resumable file/bridge substate could commit individual records and
report explicit pending progress. It would add durable cursor modes, receipt
digests/content, malformed-state recovery and optional new-user prompt binding.
The sampled small groups do not require that extra protocol. One group spanning
files through the later bridge would prevent compact EOF from committing and
couple two native processes. Generic attachment filtering would discard the
source evidence needed to distinguish internal context from ordinary records.

## Verification and remaining scope

Verify through the public Adapter, installed package and authenticated managed
CLI/HTTP/PostgreSQL Interfaces: six native snapshots, bounded fresh runtimes and
exact retries, old opaque checkpoints at every manual phase, genuine original
fragments/usage-pending positions, all incomplete group slots, copy/control and
receipt faults, exact byte caps and budgets, Raw-off/backfill and independently
advanced receipts. Retain old Reader prefixes/tool links, latest-once API usage,
real-message-only Search and exact physical Raw bytes. Unsupported later source
still retains the existing parser-first Raw-backfill limitation.

Single Read, no-plan/more/other/error/async tools, changed or repeated file
reinjection, additional orders, children and broader manual/automatic composition
remain outside this increment. Active Path/fork/rewind replacement still requires
explicit legacy adoption. The controlled loopback counters are not billing;
inherited HOME was unrecorded. The [Claude guide](../../adapters/claude.md) owns
actual implementation, verification and remaining limits. Publication and Server
deployment are separate actions.
