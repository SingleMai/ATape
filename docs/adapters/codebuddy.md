# CodeBuddy Code CLI Adapter

The CodeBuddy Adapter reads local primary CLI JSONL Sessions through the existing
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
`projects/*/*.jsonl` without following symlinks or recursing into child histories.
Directory names are locators, not proof of Project membership. The original first
user record supplies `sessionId`, `id` and absolute `cwd`; the native Session ID
must match the file basename. Duplicate IDs are diagnosed instead of merged.

Directory Projects use Host path attribution; Git Projects use its existing
original-source attribution across worktrees/clones. Later CWD changes or source
relocation do not reassign the Session. Missing original attribution remains
unknown, never inferred from the configured Project locator.

## Source mapping and supported scope

Official references: [local directory structure](https://www.codebuddy.ai/docs/cli/codebuddy-dir), [CLI resume/fork options](https://www.codebuddy.ai/docs/cli/cli-reference) and [SDK Session management](https://www.codebuddy.ai/docs/cli/sdk-sessions). The installed 2.124.0 implementation and controlled samples establish the narrower scope below.

The evidence-bound profile is `codebuddy.cli.jsonl.linear.1`, tested with native
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
are not interpreted as money. Per-response usage is scoped to the root Thread.
Tools are bounded through the shared value contract; oversized details are omitted
with partial fidelity. Spill placeholders remain placeholders, mark partial and
do not cause arbitrary referenced file reads. Search uses the existing bounded
Canonical projection, never full Raw/tool-value indexing.

Ordinary resume is a linear append. Every projected record must extend the
previous record through `parentId`; first identity and CWD establish Origin.
Identical repeated records are deduplicated; conflicting repeated IDs are
unsupported. A complete rewritten file with the same proven Origin can produce a
replacement target and Host-assigned revisions. This does not establish support
for native rewind/compaction semantics.

Nonempty sidecar metadata, child-agent calls/Sessions, logical parents, branching, compaction and unknown
parent-linked records are rejected. Nested subagent histories are not collected.
These cases do not flatten child messages or replace the old target with a
partial prefix. Wider native history support is the next increment and needs
controlled samples proving membership, usage ownership and Original Project.

## Consistency, bounds and recovery

Source-capture was selected over the legacy paged observation runtime because
source interpretation may require a complete target; filenames alone do not
prove immutable message history. The existing Host Interface hides replacement,
comparison and recovery. The Adapter adds only provider reading/projection.

An open reads at most 16 MiB from one regular JSONL file, validates complete UTF-8
records, then checks inode/size/modification/change stamps and sidecar metadata
before exposing a view. Concurrent source changes or an unfinished final line
produce a retryable-source situation with diagnostics; no partial target is
published. The source handle is closed before the first projection page.
All pages then come from that frozen bounded snapshot, including after source
changes or deletion. Close/cancellation releases it.

Discovery admits 10,000 entries. Projection snapshot bytes are capped at 64 MiB.
The Host independently bounds record size/count, Events/usage, pages, duration,
journal capacity and remote admission. See the [current default limits](../architecture/adr/0076-source-collection-release-admission.md).
This implementation rescans directories and reads a bounded full Session on
comparison. It does not promise efficient processing of unbounded archives.
Oversized or unsupported sources retain previously captured content and progress.

With Raw off, projected frames retain no full source JSON. Re-enabling can archive
a fresh source observation without altering unchanged Canonical provenance.
Activation and Raw response loss recover independently from frozen journal data,
including after source deletion. Preserve the entire ATAPE_HOME; reinstalling or
resetting progress is not a repair for unsupported source semantics. Inspect
`atape collect --once --json` and `atape status` for source health.

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
21 runtime tests, independent tarball installation, the installed CLI/HTTP/PostgreSQL
contract, and the shared PostgreSQL/OpenCode contract suite. Release packaging,
CLI terminal behavior, Tools selection and relevant application/CLI regressions
were also checked. The actual Web reader was opened against the controlled
HTTP test Server: three native turns, two thoughts, both tool outcomes and final
marker matched the fixture. This is local acceptance, not hosted CI or staging.

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
for up to three minutes after initial collection; it writes the ephemeral test
Server origin, reader identifiers and test Web cookie there. Point the Web dev
server proxy at that origin, use its HTTP-development cookie name
`atape_session_dev`, inspect the reader, then create `<file>.done` to continue.
The test removes this scratch credential file on exit. Do not commit it.
