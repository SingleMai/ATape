# Kimi Code CLI Adapter

The Kimi Adapter reads local main-agent Sessions through the existing
[source-capture runtime](package-manifest.md#bounded-source-capture-capability).
The Host owns Project attribution, masking, revisions, frozen delivery, atomic
publication, Raw receipts and recovery. No Server schema change is required;
the receiving Server must advertise `atape.publication.v1`.

## Install and discovery

Follow the [package README](../../adapters/kimi/README.md) to build/install a local
tarball. Select **Kimi Code CLI** in **Tools and updates**, preserving existing
Tools. Installation alone does not enable capture. See
[CLI setup](../cli/setup-and-adapters.md#tools-and-adapter-packages).

`ATAPE_KIMI_HOME` overrides `KIMI_CODE_HOME`, otherwise the home is `~/.kimi-code`.
Overrides must be absolute. Discovery enumerates `sessions/*/*/state.json` without
following symlinks; opening reads `agents/main/wire.jsonl` inside that Session.
The global `session_index.jsonl`, diagnostic logs, Kimi credentials and referenced
blob files are not read. No native executable is required for collection.

Native metadata version 2 supplies the Session `id`, `createdAt` and original
`cwd`; ID must match the containing Session directory. The Origin key hashes the
Session ID and creation timestamp. Upstream creates this metadata with its initial
CWD and reloads it on resume. Directory bucket names, agent `homedir`, runtime
bindings and the configured Project path are locators, never ownership evidence.
Duplicate storage IDs are diagnosed. Missing original CWD is an attribution
diagnostic; no configured-path fallback is used.

Directory and Git membership use the shared Host Interface. Git lookup, matching
across clones/worktrees and saved original attribution follow
[ADR-0037](../architecture/adr/0037-shared-git-source-attribution.md). Foreign
Projects are excluded before opening. Relocation and title changes preserve
native identities. Source deletion does not delete captured history.

## Evidence and first supported profile

`kimi.code.wire.linear.1` supports Kimi Code CLI **0.42.0**, metadata v2 and
Wire **1.5**, as verified on macOS arm64 with Node 24.18.0. The official npm CLI
created a controlled three-turn Session, including two native `--continue` runs,
thought/text streaming and successful/failed `Read` tools. A local deterministic
OpenAI-compatible endpoint supplied responses; cloud model behavior and billing
were not tested. The [fixture record](../../adapters/kimi/src/fixtures/README.md)
contains provenance, substitutions and exact counts.

Source evidence is pinned to release commit
`6954d2c8bf94a5c7fc29cc6ae35b15d042cc4dcb`:

- [Session storage and resume](https://github.com/MoonshotAI/kimi-code/blob/6954d2c8bf94a5c7fc29cc6ae35b15d042cc4dcb/docs/en/guides/sessions.md).
- [Metadata creation/reload](https://github.com/MoonshotAI/kimi-code/blob/6954d2c8bf94a5c7fc29cc6ae35b15d042cc4dcb/packages/agent-core-v2/src/session/sessionMetadata/sessionMetadataService.ts).
- [Wire version and migration](https://github.com/MoonshotAI/kimi-code/blob/6954d2c8bf94a5c7fc29cc6ae35b15d042cc4dcb/packages/agent-core-v2/src/wire/migration/migration.ts).
- [Completed content, step and tool serialization](https://github.com/MoonshotAI/kimi-code/blob/6954d2c8bf94a5c7fc29cc6ae35b15d042cc4dcb/packages/agent-core-v2/src/agent/loop/loopService.ts).
- [Normalized usage](https://github.com/MoonshotAI/kimi-code/blob/6954d2c8bf94a5c7fc29cc6ae35b15d042cc4dcb/packages/agent-core-v2/src/human/llm/usage.ts).

## Mapping

| Native record | Canonical identity and reader | Raw |
| --- | --- | --- |
| `state.json` | One Session/root Thread from native Session ID; bounded title | Complete metadata envelope |
| `turn.prompt` | Validates matching original user message; no duplicate Event | Original line |
| `context.append_message` with user origin | ACP user text; Event ID from Session + native message ID + block slot | Original line |
| Injected date/permission messages | No fabricated human turn | Original line |
| Loop `content.part` text/think | ACP assistant/thought; Event ID from Session + native part UUID | Original line |
| Loop `tool.call` | ACP call; identity scoped by Session + step UUID + tool ID | Original line and arguments |
| Loop `tool.result` | Correlated result; `isError` determines failed/completed | Original output and note |
| Loop `step.end.usage` | One usage item per native step UUID, with actual model from matching `llm.request` | Original counters |
| `usage.record`, token estimates, system prompt/tool schemas | No duplicate usage or conversation Event | Original line |
| Unknown non-context records/content or external images | Raw-only; capture marked partial | Original line; no referenced file reads |

Input tokens equal `inputOther + inputCacheRead + inputCacheCreation`; cache is
not added again to that total. Output is the normalized output counter. Missing
components stay unknown; negative, fractional or unsafe counters are rejected.
The fixture yields 13 Events and five usage items: 540 input, 54 output and 100
cached-input tokens. These counters describe the controlled provider responses.
All usage belongs to the root Thread. No costs or currency are inferred.

Native content parts are emitted after response completion. This profile further
requires a matching completed step and all its tool outcomes before exposing a
view, so unfinished or interrupted attempts cannot publish partial content. The
Adapter does not forward network deltas. Large tool values are omitted under the
shared bounded-value contract and marked partial. Search reads the existing
Canonical text projection, never full Raw or system context.

## Consistency, limits and recovery

Source-capture was selected because Wire can be migrated/rewritten and future
profiles may replace visible members. The paged observation alternative would
move comparison, replay and Raw progress policy into this provider. The existing
source-capture Interface keeps those responsibilities in the Host; this increment
introduces no new Seam or protocol.

Opening reads at most 16 MiB of metadata and Wire, with metadata independently
capped at 64 KiB. It validates UTF-8, complete lines, IDs and step boundaries, then
rechecks file identity/size/modification/change stamps and source directories
before returning. Concurrent edits and incomplete records produce diagnostics;
they do not expose a partial target. Handles close before the first projected
page. Pages read from the bounded frozen view even if the source changes or is
deleted. View cancellation/close releases retained frames.

Discovery admits at most 10,000 directory entries and 32 sources/diagnostics per
page, within the Host's requested limits. Projection snapshot bytes are capped
at 64 MiB. The Host independently bounds records, Events, usage, frame sizes,
duration and journal/remote admission; see the
[default limits](../architecture/adr/0076-source-collection-release-admission.md).
Each scan inventories directories again and each comparison reads one bounded
full Session; efficient unbounded archive processing is not promised.

With Raw off, returned frames contain no full source records. Canonical capture
continues. Re-enable archives current source observations using real receipts,
without rewriting unchanged Event provenance. Frozen delivery and independent Raw
recovery follow the [capture/publication contract](../architecture/opencode-capture-publication.md)
and [Raw policy](../cli/raw-capture.md). Preserve the whole `ATAPE_HOME`; resetting
progress does not repair unsupported source semantics. Inspect **Project → Sync
details** for source health.

## Unsupported scope and next increment

This profile rejects forks, child/independent agents, `Agent`/`AgentSwarm` calls,
compaction, undo, clear, steering, cancellation, interrupted/failed/retried steps,
unknown context operations and mixed/tree storage. Previously captured content
remains selected. Only metadata v2/Wire 1.5 are admitted; legacy Python kimi-cli,
other Wire versions, Kimi IDE formats and other platforms are unverified.

The next increment needs controlled native evidence for the selected behavior:
compaction/undo visible membership and preserved IDs; fork creation ownership and
copied-prefix usage meaning; or child membership and response-level usage
ownership. Those can use the existing replacement-target contract when their
native identity and visibility semantics are proven. They are not included in
this first support claim.

## Verification and delivery

- `pnpm --filter @atape/adapter-kimi typecheck`
- `pnpm --filter @atape/adapter-kimi test`
- `pnpm --filter @atape/adapter-kimi verify:package`
- `pnpm test:kimi-contract` for installed CLI/Adapter, authenticated HTTP,
  PostgreSQL, reader/Search, Raw policy and response-loss recovery.
- `pnpm test:go:integration` requires the named Kimi contract along with the
  existing Providers; a skipped/missing Kimi subtest fails the gate.
- `pnpm test:release` verifies the exact Kimi release tarball and Tools selection.

Local verification on 2026-09-13 passed 36 Adapter behavior tests, Adapter/CLI
TypeScript checks, independent tarball installation, the installed HTTP/PostgreSQL
contract, the shared PostgreSQL/OpenCode/CodeBuddy/Kimi suite, production builds,
release tarball/terminal checks and relevant Tools/application tests. Actual Kimi
discovery also passed shared attribution checks with real Git worktrees, clones,
foreign nested repositories and saved evidence after source/locator deletion.
Browser acceptance opened the existing Web reader against the local test Server:
three native turns, their thoughts and both tool outcomes matched the fixture;
the synthetic recovered fourth turn retained its masked input and final reply.
Search and exact usage were checked through the authenticated HTTP contract.
This is local acceptance, not hosted CI or manual staging evidence.

The package is included in official Tools detection/selection, build, packing,
release verification and artifact upload sets. Local implementation, CI, merge,
npm publication and Server deployment are separate states. No package publication
or Server deployment is implied by these changes.

For local browser acceptance, `ATAPE_KIMI_REVIEW_FILE` may name a scratch file
while running the HTTP contract. It pauses for up to three minutes with a local
test Server, writing its origin, reader IDs and test cookie to that owner-only
file. Configure the Web development proxy with `ATAPE_SERVER_URL`, set the local
`atape_session_dev` cookie, inspect the reader and create `<file>.done` to resume.
The contract removes the credential file on exit. Do not commit it.
