# Controlled native direct background child evidence

These files were written by the real Claude Code **2.1.263** executable while a
local loopback Anthropic Messages mock supplied deterministic SSE. They record
one direct background `Agent`, parent work during its execution, child file
append, one completion notification and later parent continuation. This is source
evidence; the [owning Claude guide](../../../../docs/adapters/claude.md) records
implementation and acceptance scope.

The successful acquisition used a fresh isolated HOME, configuration directory,
workspace and Session in one `--print --input-format stream-json` process. Stdin
stayed open for three exact external prompts. The harness withheld the child
final response until the parent had performed its own Read. Native exit was 0;
eight fake-authenticated POST model requests and one unauthenticated
`HEAD /api/hello` bootstrap (404) were recorded. The native binary SHA-256 before
and after was `ef5d2909c8af49f31ab6d5487e90316777bc2fac170adfe8160716caa8aaf4f9`.
The harness, actual argv/environment, complete requests/SSE, stream output and
original snapshots remain in the external evidence directory recorded by the
acquisition ledger. No original JSONL was hand-written or reserialized.

Only declared literal paths were substituted. The fixture workspace is
`/fixture/native-background-child/workspace`; configuration, HOME, temporary
capture paths, encoded workspace directory and the task output path have matching
fixture replacements. UUIDs, timestamps, API IDs, Agent ID, tool IDs, flags,
metadata and content outside those paths remain unchanged. Original and fixture
hashes, replacement rules and complete-LF byte counts are in `provenance.json`.

## Source files and replay cuts

| Files | Source observation |
| --- | --- |
| `root.jsonl`, `child.jsonl`, `child.meta.json` | Final native files: root 28 LF records, child 6 LF records. |
| `observed-running-root.jsonl`, `observed-running-child.jsonl` | Simultaneously read while the child final SSE was withheld: root 11 LF records, child 5 LF records. The parent Read-result model request already existed; native root source writes had not yet flushed its later records. |
| `observed-completed-root.jsonl`, `child.jsonl` | Child completion persisted: root 19 LF records including a queued notification; child 6 LF records. The UUID notification user record had not yet flushed. |

Each observed file is an exact prefix of the final file. Earlier acquisition
snapshots contained only `child.meta.json`, because native transcript writes were
buffered. Those missing-file observations are retained in the external snapshot
ledger; they are not represented as invented transcript files here.

`derivedStages` describes complete-LF prefixes of these immutable native files:
root/child line pairs **8/1, 10/3, 18/5, 18/6, 21/6, 23/6, 28/6**. In particular,
18/5 → 18/6 holds root bytes fixed while the child appends. These are replay cuts
for caller tests, **not additional native invocations or claims of simultaneous
filesystem observations**. Additional append/partial cuts must retain that label.

## Native ownership and completion facts

Root line 7 calls `Agent` with `run_in_background: true`. Line 8 is the actual
result for that tool-use ID and has an exact `sourceToolAssistantUUID` binding.
Its `toolUseResult` contains `isAsync: true`, `status: "async_launched"`, an Agent
ID and `outputFile`. The child first UUID has the same Session/CWD, that Agent ID,
`isSidechain: true` and null parent. `.meta.json` independently records
`toolUseId` and `spawnDepth: 1`; it is evidence, not required Adapter input.

`outputFile` was observed as a **symlink** to the authenticated child JSONL, with
identical bytes. It is not a source discovery path and must not authorize reading
an arbitrary path. The ordinary child source remains
`<root-directory>/<sessionId>/subagents/agent-<agentId>.jsonl`.

The parent continues in lines 10 and 13–18 while the child Read has completed and
its final response is still withheld. The child Read receipt is an ordinary
`tool_result` with `sourceToolAssistantUUID`; this native child record does not
contain `toolUseResult`. Its numbered text contains the real isolated disk marker.
The parent Read does contain full file metadata with content equal to disk bytes.

Completion does **not** produce a second completed Agent tool result. Root line
19 queues XML notification content; line 20 dequeues it; line 21 persists a
`user` record with `origin: {"kind":"task-notification"}` and
`queueSkipAttachments: true`. It has no `isMeta` flag. Its parent is the current
parent answer at line 18, rather than the original launch call. XML `task-id`
equals the launch Agent ID, `tool-use-id` equals the launch call ID and `status`
is `completed`. The queue content equals the user message content exactly.
The parent acknowledges the notification at line 23, receives a genuine external
user prompt at line 25 and continues at line 27. Queue operations have no UUID.

The native notification says the same task-id can notify again after later
messages; this acquisition proves one completion only. Its text and aggregated
`subagent_tokens` are provider control metadata, not additional conversation or
assistant usage samples.

## Usage, safety and evidence limits

Eight distinct persisted real assistant API IDs contribute controlled counters:
root six and child two, each 31 input / 17 output, totaling **248 / 136**. No
summary API was requested. The source has twelve root user/assistant records,
including the internal notification, and four child user/assistant records;
these counts do not assert that notification text should appear in Canonical or
Search. `selected-source-requests.json` retains the relevant actual message
blocks and deterministic responses. SDK system prompts, full tool schemas,
unrelated reminders and other request fields are omitted; original full request
and response hashes remain in the provenance wire ledger.

The process used only a fake API key, an explicit loopback endpoint, strict empty
MCP configuration, restricted/safe flags, manual permission controls and no Chrome
or updater. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` was absent. Native termination
was bounded at 45 seconds, forced kill at 50 seconds and an overall 60-second
watchdog; allowed routes and request counts were bounded. This does not assert an
operating-system egress firewall or real provider billing.

One earlier isolated setup attempt rejected its first model request because the
harness compared combined user text rather than individual text blocks. It sent
no model response SSE and launched no Agent. Its files are retained externally;
none are included in this successful source fixture.

No native failed/cancelled Agent, deleted/unreadable child file, repeated completion,
multiple children, nested delegation or fork was acquired. Missing/changed source
and identity failures can be tested through explicit generated mutations; they
must not be described as additional native evidence. Package publication,
Server deployment and browser acceptance are separate from this fixture.
