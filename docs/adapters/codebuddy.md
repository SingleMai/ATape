# CodeBuddy Code CLI Adapter

The CodeBuddy Adapter reads local primary and forked CLI JSONL Sessions and completed foreground Agent families through the existing
[source-capture runtime](package-manifest.md#bounded-source-capture-capability).
The Host owns Project attribution, redaction, stable revisions, frozen delivery,
atomic publication, independent Raw receipts and crash recovery. No Server schema
change or alternate uploader is required. The receiving Server must advertise
`atape.publication.v1`.

## Install and sources

Build/install instructions are in the [package README](../../adapters/codebuddy/README.md).
Add **CodeBuddy Code CLI** through Tools and updates, preserving the existing tool
selection. Package installation alone does not enable capture; tool selection
applies to connected Projects. See [CLI setup](../cli/setup-and-adapters.md).

`ATAPE_CODEBUDDY_HOME` overrides `CODEBUDDY_CONFIG_DIR`, otherwise the source home
is `~/.codebuddy`. Both overrides must be absolute. Discovery enumerates
`projects/*/*.jsonl` without following symlinks. Opening a root then reads only
child histories proved by its native Agent receipts; unrelated nested files are ignored.
Directory names are locators, not proof of Project membership. For an ordinary Session, the first user record supplies `sessionId`, `id` and
absolute `cwd`; the native Session ID must match the file basename. A fork also
requires native sidecar evidence and its first fork-owned user record, as described
below. Duplicate storage IDs are diagnosed instead of merged.

Directory Projects use Host path attribution; Git Projects use its existing
original-source attribution across worktrees/clones. Later CWD changes or source
relocation do not reassign the Session. Missing original attribution remains
unknown, never inferred from the configured Project locator.

## Source mapping and supported scope

Official references: [local directory structure](https://www.codebuddy.ai/docs/cli/codebuddy-dir), [CLI resume/fork options](https://www.codebuddy.ai/docs/cli/cli-reference) and [SDK Session management](https://www.codebuddy.ai/docs/cli/sdk-sessions). The installed 2.124.0 implementation and controlled samples establish the narrower scope below.

The evidence-bound profiles are `codebuddy.cli.jsonl.linear.1` and
`codebuddy.cli.jsonl.fork.1`, extended by `codebuddy.cli.jsonl.compaction.1` and
`codebuddy.cli.jsonl.fork.compaction.1` when supported compaction is present. `codebuddy.cli.jsonl.family.1` covers the
completed foreground Agent family described below, including root compaction. All are tested with native
CodeBuddy Code CLI 2.124.0 samples on macOS arm64. It is not a promise for IDE,
VS Code extension, all CLI versions, or other platforms.

| Native record | Canonical and reader | Raw |
| --- | --- | --- |
| First `message`, role `user` | Session/root Thread from native Session ID; Origin key from Session ID + first record ID | Original JSON line in an observation envelope |
| `message.content` input/output text | ACP user/agent text; Event identity from Session + record ID + physical block slot | Same record, unknown fields retained |
| `reasoning.rawContent` (fallback `content`) | ACP thought text | Same record |
| `function_call` | ACP tool call; scoped `callId`; bounded parsed arguments | Original arguments retained |
| `function_call_result` | Correlated tool result; native error fields override misleading `completed` status | Original output and provider details |
| `message.usage` + `providerData.messageId/model` | One usage item per model response; repeated identical usage deduplicated | All original usage fields |
| File-history snapshots | No fabricated conversation message | Same record |
| Unknown blocks / external images | Omitted from Canonical, partial capture | Stored only if Raw enabled; referenced blobs are not read |

Input counters already include cached input; output includes reasoning. They are
not added a second time. Missing counters remain unknown. Currency/credit values
are not interpreted as money. Per-response usage belongs to the Thread containing that native model response.
Parent tool results do not add the child response counters again.
Tools are bounded through the shared value contract; oversized details are omitted
with partial fidelity. Spill placeholders remain placeholders, mark partial and
do not cause arbitrary referenced file reads. Search uses the existing bounded
Canonical projection, never full Raw/tool-value indexing.

## Native CLI forks

`--resume <id> --fork-session` copies history into an independent JSONL file and
writes a sidecar containing `forkedFrom`. Copied records retain their previous
Session IDs and message IDs; the first newly submitted user record carries the
new fork ID. That ID must match the file basename. This first fork-owned record’s
ID and CWD anchor the fork’s Origin; copied CWDs never authorize the fork for a
Project. A prefix-only fork has unknown attribution until that record exists.

In CLI 2.124.0, deserialization can restore the original root `sessionId` while
retaining the fork filename as `storeId`. Native nested forks still record that
root in `forkedFrom`, and ordinary fork resume appends records under the root ID.
The Adapter therefore validates the complete linear parent chain and identity
changes at user turns. After the first fork-owned turn, only the fork ID and its
recorded root ID are accepted. Compaction follows the profile below; unknown sidecar fields remain unsupported. Native fork resume can set
`isSubAgent` even for an ordinary root; that flag alone does not establish child membership. `/branch`, which rewrites IDs and stores `forkedAt`,
is a different shape and is not covered by these samples.

Forks are independent Sessions containing their copied prefix. Event, tool and
usage identities are scoped to the fork storage ID, so its updates cannot replace
the original Session. `forkedFrom` is retained in the first Raw record’s `sidecar`
envelope; it is not fabricated into an immediate-parent Thread relation. Parent
files need not remain present. Nested fork and resume samples include eight usage
records: 55,032 input, 417 output and 22,144 cached-input tokens. These are the
usage of the captured history, including copied responses; they are not proof of
newly incurred spend. Cache is already part of input and is not added twice.

Ordinary resume is a linear append. Every projected record must extend the
previous record through `parentId`; first identity and CWD establish Origin.
Identical repeated records are deduplicated; conflicting repeated IDs are
unsupported. A complete rewritten file with the same proven Origin can produce a
replacement target and Host-assigned revisions. This does not establish support
for native rewind/compaction semantics.

Sidecar fields other than `forkedFrom`, in-file branching and unknown parent-linked
records are rejected without replacing previously published history.

## Completed foreground Agent families

Native `Agent` call/result pairs establish membership through structured
`providerData.toolResult.subAgent` receipts. A child is stored at
`<parent-native-session-id>/subagents/<agent-storage-id>.jsonl` within the root's
Project bucket. Its internal Session UUID differs from the `agent-*` storage ID;
nested children use their parent's internal UUID for the directory. Neither the
child CWD nor that directory independently establishes Project ownership. The
root's original CWD and Origin own the entire family.

The Adapter validates the delegated prompt, agent type, completed assistant turn,
receipt `lastId`, and resumed `afterId` chain before exposing any member. Native
`lastId` can point to reasoning before the terminal response, so it is checked
inside the turn rather than used as a visibility cutoff. Repeated calls that
resume the same storage ID append to one Thread. Event, tool and usage identities
are scoped by the root storage ID plus child storage ID; parent and child updates
cannot overwrite one another. Each delegated turn follows its parent call and precedes the result; the complete
family receives the global event order required by the Host.

Each parent Agent tool call links to its child Thread. Nested calls preserve the
Thread parent path, and Reader/Search can open and anchor the actual child Events.
Raw envelopes retain both the owning root Session ID and child's storage Thread
ID, alongside the unchanged native JSONL containing its internal UUID. Usage is
attributed to the response's Thread, without copying parent tool-result counters.

The native corpus covers a custom foreground Agent, its ordinary resume, a custom
Agent calling another child, parent `/compact`, and a built-in `general-purpose`
Agent afterward. It yields five Threads, 37 Events and 15 usage records: 108,859
input, 2,886 output and 57,664 cached-input tokens. Cached input is included in
input. Orphan files are not discovered as independent Sessions. A pending Agent
call, missing/truncated child, mismatched receipt or unproven extra child turn
rejects the complete new target; all previously published family members remain.

Background, named/team and fork subagents, child compaction and forks containing
child histories remain unsupported. Copied parent receipts alone do not prove a
fork's child visibility frontier when the original children can keep appending.
These shapes require additional native evidence before extending membership.

## Compaction with retained history

Native manual `/compact` and the tested engineering `pre-message-auto` path append
to the source file; they do not remove its original transcript. The Adapter keeps
that transcript and its Event identities, follows validated compaction links, and
continues in the same Session and Project. A fork can copy this compacted history
without requiring the original file.

| Native compaction record | Canonical | Raw |
| --- | --- | --- |
| `agent: compact` user command | Original `/compact` input from the text block’s `providerData.content` | Full expanded internal prompt and original command |
| Compact reasoning and completed assistant summary | Native thought and assistant text in the explicit compact turn | Full records, flags and normalized model usage |
| `pre-message-auto` user context with `isCompacted: true`, `isCompactInternal: true`, `isSummary: false` | No fabricated user turn; its `logicalParentId` must point to the preceding record | Complete `<cb_summary>` context and link |
| Ordinary messages after either boundary | Existing user/assistant mapping, retaining the full earlier transcript | Same source records |

The manual command must have its original input and a completed summary before
an open view can escape. An interrupted or unfinished compact run preserves the
previous publication and emits a source diagnostic. The automatic context record
must have the tested native flags and complete wrapper; arbitrary logical parents,
missing original prefixes and foreign identities remain unsupported. When Raw is
off, internal context is omitted completely while conversation updates continue.

The controlled sequence has four actual model responses, including the manual
summary: 20,757 input, 1,079 output and 6,656 cached-input tokens. Engineering
pre-message compaction itself has no model-response usage record, so the Adapter
does not invent one. Copied fork usage retains the historical meaning described
above. Context-only changes update Raw independently; response-loss recovery uses
the frozen journal even after source deletion.

This evidence does not establish automatic LLM summaries (`isSummary: true`),
`emergency-auto`, content pruning, rewind, `/clear`, `/branch`, or compaction inside
child Sessions. Those shapes remain unsupported rather than guessing their
membership or original attribution.

## Consistency, bounds and recovery

Source-capture was selected over the legacy paged observation runtime because
source interpretation may require a complete target; filenames alone do not
prove immutable message history. The existing Host Interface hides replacement,
comparison and recovery. The Adapter adds only provider reading/projection.

An open reads at most 16 MiB across the root, referenced children and sidecar
metadata. It validates complete UTF-8 records and rechecks every member’s
inode/size/modification/change stamps and metadata after the final member read
before exposing a view. Record, Thread and duration budgets cover the complete family. Concurrent source changes or an unfinished final line
produce a retryable-source situation with diagnostics; no partial target is
published. The source handle is closed before the first projection page.
All pages then come from that frozen bounded snapshot, including after source
changes or deletion. Close/cancellation releases it.

Discovery admits 10,000 entries. Projection snapshot bytes are capped at 64 MiB.
The Host independently bounds record size/count, Events/usage, pages, duration,
journal capacity and remote admission. See the [current default limits](../architecture/adr/0076-source-collection-release-admission.md).
This implementation rescans directories and reads a bounded full Session on
comparison. Fork discovery also reads the bounded snapshot to find the original
fork-owned record. It does not promise efficient processing of unbounded archives.
Oversized or unsupported sources retain previously captured content and progress.

With Raw off, projected frames retain no full source JSON. Re-enabling can archive
a fresh source observation without altering unchanged Canonical provenance.
Activation and Raw response loss recover independently from frozen journal data,
including after source deletion. Preserve the entire ATAPE_HOME; reinstalling or
resetting progress is not a repair for unsupported source semantics. Inspect
**Project → Sync details** in the `atape` console for source health.

## Verification and delivery status

The [fixture record](../../adapters/codebuddy/src/fixtures/README.md) states exact
native provenance and synthetic coverage. Relevant verification commands:

- `pnpm --filter @atape/adapter-codebuddy typecheck`
- `pnpm --filter @atape/adapter-codebuddy test`
- `pnpm --filter @atape/adapter-codebuddy verify:package`
- `pnpm test:codebuddy-contract` for installed CLI/Adapter, authenticated HTTP,
  PostgreSQL, reader/Search, Raw policy and recovery.
- `pnpm test:release` includes the exact CodeBuddy release artifact and Tools.

Local verification on 2026-09-13 (macOS arm64) passed Adapter typechecks and
55 runtime tests, independent tarball installation, the installed CLI/HTTP/PostgreSQL
contract, and the shared PostgreSQL/OpenCode contract suite. Following the single-entry CLI change,
installation and selection use the console’s application Modules; initial collection
and replacement collection run in the actual installed background executable.
Fault injection and bounded recovery cycles use the source Node Host. Release packaging,
CLI terminal behavior, Tools selection and relevant application/CLI regressions
were also checked. The actual Web reader was opened against the controlled
HTTP test Server: three native turns, two thoughts, both tool outcomes and final
marker matched the fixture. The fork contract additionally verifies cross-directory
attribution, installed background collection and resume, independent reader/Search
results, exact historical usage, sidecar Raw provenance and recovery after both
history and metadata deletion. Browser acceptance of the recovered fork verified
all six turns, including the copied tools, nested fork and continued reply, in
its independent Project. The compaction contract verifies manual command recovery,
retained prefix identity, automatic-context exclusion from Reader/Search, exact
usage, Raw off/on and context-only Raw recovery after source deletion. Browser
acceptance verified its four real user turns, the recovered `/compact` command,
native summary and continued reply, with no extra automatic-context turn. This
is local acceptance, not a staging attestation.

The family contract additionally checks actual installed background collection
through initial delegation, resume, nesting, parent compaction and a built-in
Agent. It checks original Project ownership despite foreign child CWD, stable
child prefixes and links, per-Thread reader pagination and Search anchors, exact
usage ownership and child Raw provenance. Incomplete/missing children retain the
whole old target; Raw off/on preserves Canonical progress, and lost activation
recovers every frozen member after all five source files are deleted. Browser
acceptance opened the resumed child with its recovered content and followed
root → intermediate child → leaf, confirming the three-level path and native
leaf user/assistant messages in the existing side panel.

Package replacement may perform one Raw admission observation when the version
length changes. The installed contract verifies no Canonical/Raw content uploads,
unchanged head/checkpoint/Event provenance and the selected replacement version.
Replacement uses a re-versioned current bundle, not an old published binary.

The package belongs to the official tool/build/release set; CI must run its own
contract explicitly. Code implementation, successful local checks, merged code,
package publication and deployed Server are separate states. This guide does not
assert that the new package is already published or deployed.

For local Web acceptance, `ATAPE_CODEBUDDY_REVIEW_FILE` can name an owner-only
scratch JSON file when running `pnpm test:codebuddy-contract`. The test pauses
for up to three minutes after child-family recovery; it writes the ephemeral test
Server origin, family reader identifiers and test Web cookie there. Point the Web dev
server proxy at that origin, use its HTTP-development cookie name
`atape_session_dev`, inspect the reader, then create `<file>.done` to continue.
The test removes this scratch credential file on exit. Do not commit it.
