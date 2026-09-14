# Grok Build Adapter

The Grok Adapter reads completed local root and fork conversations through the existing
[source-capture runtime](package-manifest.md#bounded-source-capture-capability).
The Host owns Project attribution, redaction, revisions, frozen delivery, atomic
publication and independent Raw recovery. It requires a Server advertising
`atape.publication.v1`; this increment adds no Server schema or alternate uploader.

## Install and sources

See the [package README](../../adapters/grok/README.md) for local builds and tarball
installation. Select **Grok Build** in Tools and updates, preserving other enabled
tools. Installing a package does not enable capture by itself. See
[CLI setup](../cli/setup-and-adapters.md).

`ATAPE_GROK_HOME` overrides `GROK_HOME`, otherwise the source home is `~/.grok`.
Overrides must be absolute. Discovery enumerates `sessions/*/*/summary.json`
without following symlinks. An open reads `summary.json`, `updates.jsonl` and
`signals.json`. It never executes Grok or reads credentials, model-input history,
terminal spill files, arbitrary referenced paths or the native search database.

Directory names are locators, including URL-encoded names and native slug/hash
names for long paths. Native `summary.info.id` must match the Session directory;
`summary.info.cwd` supplies original CWD, and Session ID plus `created_at` anchors
Origin. The configured ATape path cannot substitute for this evidence. Missing
CWD is an attribution diagnostic; duplicate storage IDs are diagnosed, not merged.
Native cross-directory resume retained the original CWD and storage location.
The Host applies directory/Git attribution using this original-source evidence.
A separate native worktree sample verifies this metadata on a real Git checkout.
The installed contract recreates that topology, excludes another repository and
continues from durable attribution after both checkout and worktree disappear.
Mutable `git_remotes` and `head_branch` metadata remain in Raw; they do not
reassign a Session or substitute for original CWD.

## Supported native profile

The evidence-bound profiles are `grok.build.updates.linear.1` and
`grok.build.updates.fork.1`, tested with **Grok
Build 1.0.3 (1a29d5bc12d4)** on **macOS arm64**. It supports completed root text
conversations, ordinary headless resume, successful/failed `read_file` calls,
foreground `run_terminal_command` calls, `grep` searches (including no matches),
`search_replace` edits, headless forks/nested forks and their continuation,
and persisted per-turn/model token usage.
This is not a general claim for every Grok tool, version, TUI behavior, ACP client
or platform. Native `agent_thought_chunk` text uses the same projection; the
controlled native corpus contains reasoning counters but no persisted thoughts.

Official references: [overview](https://docs.x.ai/build/overview),
[CLI reference](https://docs.x.ai/build/cli/reference) and
[Sessions](https://docs.x.ai/build/features/sessions), reviewed 2026-09-13.
The installed CLI documentation describes `updates.jsonl` as the conversation
log. Native sampling confirms it; the adjacent `events.jsonl` is operational
telemetry, not the transcript. Official documentation describes broader fork,
rewind and compaction features and does not prove this Adapter supports them.

| Native record | Canonical identity and reader | Raw |
| --- | --- | --- |
| `summary.info`, `created_at` | Native Session/root Thread and original Project evidence | Separate metadata observation |
| `user_message_chunk` and `agent_message_chunk` | ACP text, ordered by persisted position | Original JSON lines |
| Adjacent text fragments | One complete content unit before Host redaction | All contributing original lines in order |
| `tool_call` and `tool_call_update` | Correlated call, update and completed/failed result; bounded input/output | Original provider fields and content |
| `grep` output | Strict UTF-8 decoded stdout/stderr and native exit/match counters; no-match exit 1 retains native completed status | Original byte arrays and match details |
| `search_replace` input/result | Edit kind, old/new strings, applied edit context and native status in bounded tool details | Original diff content, locations and provider metadata |
| Foreground command output | Textual `output_for_prompt`; referenced terminal files are not opened | Original inline output and spill locator |
| `_x.ai/session/update: turn_completed` | One usage item per native prompt/model; no fabricated message | Complete native usage including unknown counters/cost fields |
| `hook_execution` | No conversation Event | Native hook telemetry |
| `summary.json`, `signals.json` | Consistency and supported-profile checks | Complete observed metadata when enabled |

`eventId` restarts when a new Grok process resumes the same Session. Identities
therefore include native Session ID, the completed turn's `prompt_id`, and its
Event ID. The initial user record lacks `promptId`; its complete enclosing turn
provides that namespace. A turn must start with the expected `promptIndex`, have
one user content unit, matching prompt references, unique Event IDs within that
turn, closed tools, an assistant response and `end_turn` completion. Native resume
preserved all earlier records exactly. Host-assigned revisions can represent a
changed complete target without deriving revision numbers from clocks or hashes.

Persisted `turn_completed.usage.modelUsage` already includes cached input in
`inputTokens` and reasoning output in `outputTokens`. They are not added twice.
The headless terminal's `usage.input_tokens` instead reports uncached input in
the sampled version. The Adapter validates per-model totals against the persisted
turn total. It does not turn cost ticks into money or cumulative CLI telemetry
into per-response usage. Missing optional cache counters remain unknown; missing
per-model usage marks the capture partial. Usage belongs to the root Thread.

## Native headless forks

`--resume <id> --fork-session` creates an independent Session with a copied
completed prefix. `summary.json` must declare `session_kind: "fork"`, a distinct
`parent_session_id` and a valid `forked_at` creation boundary. The native fork's
own `info.id`, `created_at` and original `info.cwd` establish its identity and
Project attribution. Controlled cross-directory fork and resume requests retained
the original CWD and storage location. The requested CWD does not reassign history.

Grok rewrites copied `params.sessionId` to the fork ID and the outer record
`timestamp` to the copy time. It retains original Event IDs, prompt IDs and
`agentTimestampMs`. The Adapter uses the retained native event time, namespaces
Event/message/tool/usage identities by the fork's Session ID, and titles the fork
from its first own prompt. Parent/fork metadata and copied provider fields remain
in Raw; the fork is a peer root, not a fabricated child Thread.

Each complete turn has one Event-ID owner. A copied prefix may contain successive
ancestor owners for a nested fork, ending with the immediate parent. An ancestor
cannot reappear after ownership moves forward. Copied events must predate the
fork boundary; subsequent turns must belong to the fork and occur at or after
that boundary. At least one completed fork-owned turn is required. Foreign Session
IDs, mixed owners, inconsistent metadata or a prefix-only/incomplete fork reject
the new target and retain its previously selected history.

Parents do not need to remain on disk: capture uses only the fork's frozen files.
Later parent growth cannot add Events, usage or Raw to an existing fork. Ordinary
fork and nested-fork resume preserve their completed prefixes, Origin, Event
identities and provenance. Copied usage belongs to the captured history and is
not evidence of additional spend; it must not be summed across forks as new
provider charges. The continued nested fixture has five turn/model usage rows:
44,309 input, 835 output and 25,664 cached-input tokens, with cache included in input.

Native evidence covers headless forks of completed linear conversations using
the supported tools, nested forks and ordinary continuation on Grok Build 1.0.3
macOS arm64. TUI/worktree forks, `--restore-code`, compacted/rewound histories,
child families and forks of interrupted turns are outside this evidence.

## Bounds, unsupported behavior and recovery

A snapshot admits at most 16 MiB across its three files; each metadata file is at
most 64 KiB and also respects the requested row limit. Reads validate UTF-8,
complete JSONL and summary record counts, then recheck every file and directory
stamp before exposing frames. Pages come from that frozen bounded view even if
sources change or disappear afterward. Projection is bounded by 64 MiB plus the
Host's record, Event, usage, page and duration limits. Discovery admits 10,000
entries. This is a bounded full rescan, not an unbounded-history indexing promise.

Incomplete turns, invalid JSON, concurrent changes and mismatched counts cannot
replace the selected target. Source deletion preserves captured history. Parent
metadata must satisfy the fork profile above; other non-primary Session kinds
and unknown parent relationships reject child Sessions.
Rewind, compaction, regeneration and edit/retry signals are unsupported. Unknown
updates, other tools, background commands, truncated/spilled command output and
non-text messages also reject the new target with a diagnostic. A rejected new
turn retains the previously captured conversation; it does not fabricate success
or partially activate the new turn.

Search continues to index Canonical conversation text and tool labels. Tool
input/output details, including decoded grep results and edit payloads, are
available in Reader but are not searched by the current shared Search contract.
The Adapter does not fabricate assistant messages from tool output. Native edit
diff content and locations remain in Raw; the existing Canonical tool Interface
retains bounded input and result details. Native failed search_replace output
has not been sampled; the requested invalid-operation probe produced only an
assistant refusal, which is not evidence of a failed tool execution.

Unknown fields on supported records remain in Raw. Bounded tool-value omissions
are explicitly partial. With Raw off, returned frames contain no full native JSON;
Canonical continues. Re-enabling archives a fresh source observation without
changing unchanged Event provenance. Already frozen Raw and activation work can
recover independently after source deletion. See [Raw policy](../cli/raw-capture.md)
and [capture/publication](../architecture/opencode-capture-publication.md).
Preserve ATAPE_HOME and inspect Project → Sync details for source diagnostics;
resetting progress is not a repair for unsupported native semantics.

## Verification and delivery

The [fixture record](../../adapters/grok/src/fixtures/README.md) distinguishes native
samples from synthetic mutations. Verification entry points:

- `pnpm --filter @atape/adapter-grok typecheck`
- `pnpm --filter @atape/adapter-grok test`
- `pnpm --filter @atape/adapter-grok verify:package`
- `pnpm test:grok-contract` for installed CLI/Adapter and authenticated HTTP,
  PostgreSQL, Reader/Search, usage, Raw policy and response-loss recovery.
- `pnpm test:release` includes the Grok tarball and Tools selection.
- `pnpm test:go:integration` explicitly requires the Grok subtest to pass.

Local acceptance on 2026-09-13 passed 32 runtime behavior tests, standalone tarball
installation without lifecycle scripts, and the installed CLI/HTTP/PostgreSQL
contract. Three controlled turns reached the Web reader with successful/failed
file reads, foreground command output, a masked test secret and the recovered
final marker. Search located Canonical content and excluded a Raw-only marker.
The three native turn/model usage rows total 82,054 input, 1,169 output and 68,096
cached-input tokens; cache is included in input. Package replacement retained
checkpoint, head, Event identity and provenance, using a re-versioned current
bundle rather than a historical published binary.

For repeatable Web acceptance, set `ATAPE_GROK_REVIEW_FILE` to an owner-only scratch
JSON file when running the contract. It exposes the temporary Server origin and
test Web cookie locally, pauses for at most three minutes, and continues when
`<file>.done` exists. Use the development cookie name `atape_session_dev`, then
remove the local Web dev server. The test removes the scratch credential file.
Do not commit it. This is local acceptance, not staging or deployment evidence.

The local release tarball/Tools gate and shared PostgreSQL/OpenCode/CodeBuddy/Grok
contracts also passed. The official catalog, build/release set and CI contract include Grok. Implementation,
local verification, merging, npm publication and Server deployment are separate
states; this guide does not assert publication or deployment. The next increment
needs native evidence for additional tools, failed edits and interrupted/cancelled
turns, then rewind/compaction and child membership before extending those
claims. Search/edit acceptance additionally verifies decoded byte-output masking
with Raw off, unchanged polling and Raw re-enable without changing provenance.
Two additional native samples cover a successful grep/read/edit turn and a
no-match grep turn; they do not widen the tested version or platform.

The fork increment passed 46 runtime behavior tests, standalone installed-package
verification and the installed CLI/HTTP/PostgreSQL contract on 2026-09-15.
Direct and nested fork cases cover original directory attribution, copied native
times, stable identities through continuation and package replacement, exact
historical usage, Reader/Search, masking, Raw off/on, unsupported-lineage
retention and activation/Raw response-loss recovery after deleting the source.
Native parent-growth fixtures verify that later parent history does not enter
the fork. The user's personal-environment and browser acceptance are deferred
until the planned capability extensions are ready; these automated checks do
not claim that acceptance, package publication or Server deployment occurred.
