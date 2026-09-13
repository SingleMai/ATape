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

## Evidence and supported profiles

`kimi.code.wire.linear.1` and `kimi.code.wire.context.1` support Kimi Code CLI **0.42.0**, metadata v2 and
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
| Turn `usage.record`, token estimates, system prompt/tool schemas | No duplicate usage or conversation Event | Original line |
| Completed manual/automatic `full_compaction` envelope | Retains previous conversation; internal summary creates no human/assistant Event | Complete envelope and summary |
| Compaction session `usage.record` | Separate usage from the matching request; identity from Session + native begin-line position | Original counters |
| `context.undo` | Removes the last N user turns and their replies/tools after the most recent compaction; retains all expenditure | Undo and original removed records |
| CLI `/clear` (alias `/new`) | New independent Session; old captured history remains | Separate state/Wire |
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

Source-capture handles Wire migration/rewrites and undo replacing visible members. The paged observation alternative would
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

## Compaction, undo and clear

The context profile follows native 0.42.0 transcript replay. A completed manual
`/compact` or automatic compaction preserves earlier reading history and stable
message IDs. Its summary is model context, not an additional conversation turn.
Automatic compaction may follow a new user prompt before that prompt’s model step.
That user stays visible but belongs to the compaction boundary for later undo.

`/undo N` removes the last N user turns and their assistant/tool Events, and
replaces visible membership atomically. It cannot cross the latest compaction.
The original lines remain in Raw. Native usage is not undoable: previously spent
response tokens and compaction tokens remain in statistics. Compaction has no
native response UUID, so its usage identity uses the append-only begin-line
position within the Session; target replacement handles a rewritten source.
Actual model names come from matching requests, not configured aliases.
`tokensBefore`, `tokensAfter` and `summaryOutputTokens` are context estimates and
never become usage. Missing response counters remain unknown.

A compaction envelope must contain one matching request, its modern context
boundary and completion. Multiple requests/retries, overlapping operations,
invalid undo ranges and unfinished/cancelled compactions produce diagnostics and
preserve the previous target. CLI `/clear` creates a new native Session rather
than emitting low-level `context.clear`; an empty new Session is not captured
until its first prompt reaches context. Native saved titles remain authoritative,
even if they contain text from an undone turn; undo removes Event content from
reader/Search, not the separately saved title.

Controlled native manual history has 6 retained Events and 7 usage items
(728 input, 98 output, 140 cached input), including both undone responses and both
compactions. Automatic compaction has 4 Events and 3 usage items (190205 input,
36 output, 60 cached input); the high input counter was deliberately supplied by
the local endpoint to trigger native automatic compaction. `/clear` has a new
Session with 2 Events and 1 usage item (108 input, 18 output, 20 cached input).

## Unsupported scope and next increment

Only the new Node-based Kimi Code CLI is in scope. Legacy Python kimi-cli is
intentionally excluded and is not a compatibility backlog. Both profiles require
metadata v2/Wire 1.5; other versions, Kimi IDE formats and other platforms remain
unverified.

Forks, child/independent agents, `Agent`/`AgentSwarm` calls, steering,
cancellation, interrupted/failed/retried steps, low-level `context.clear`, unknown
context operations and mixed/tree storage remain unsupported. Previously
captured content remains selected. The next increment needs native fork ownership
and copied-prefix usage evidence, or child membership and response usage
ownership, before claiming those behaviors.

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

Context-history verification on 2026-09-14 passed 60 Adapter behavior tests,
Adapter/CLI typechecks, independent tarball installation and the installed
HTTP/PostgreSQL contract. Native undo activation recovered after a lost response
and source deletion; compaction Raw receipt recovery preserved the selected head.
Raw-off/on preserved Canonical provenance, incomplete compaction preserved the
last target, and Search excluded undone replies and internal summaries. Local
Web acceptance displayed the three retained manual turns, two automatic-compaction
turns and independent new `/clear` Session, all with healthy capture status.

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
