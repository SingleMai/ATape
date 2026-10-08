# Controlled native manual Read file reinjection evidence

This is controlled native Claude Code **2.1.263** source evidence for one root
Session. The [Claude guide](../../../../docs/adapters/claude.md) owns implemented
scope, actual caller acceptance and remaining limitations. This corpus alone
does not establish package publication, Server deployment, browser acceptance or
compatibility with other Claude histories. Preparation read the existing source
material and made no new native or live model invocation.

The six JSONL files are actual native snapshots of one Session: `seed`, `warmup`, `toolturn`, `compact`, `continue` and `secondcontinue`. Each file is the previous file's strict byte prefix plus appended records. Writes apply only the literal workspace, configuration and encoded-directory substitutions recorded in `provenance.json`; UUIDs, API IDs, indices, timestamps, flags, message bodies outside those path literals, key order and LF boundaries remain intact. Derived complete-record cuts are metadata in provenance, not extra native files or invocations.

| Snapshot | Logical real Events | Persisted API IDs | Latest input/output usage |
| --- | ---: | ---: | ---: |
| seed | 2 | 1 | 23 / 11 |
| warmup | 4 | 2 | 52 / 24 |
| toolturn | 12 | 4 | 130 / 64 |
| compact | 12 | 4 | 130 / 64 |
| continue | 14 | 5 | 159 / 77 |
| secondcontinue | 16 | 6 | 188 / 90 |

These are source-derived logical expectations excluding the internal compaction
stage, not a report of checks passing. The two ordinary successful Read calls
are A then B at lines 20/21, and each result at 22/23 points to its own call via
`parentUuid`, `tool_use_id` and `sourceToolAssistantUUID`. Disk bytes contain the
synthetic markers amber lynx 204 and violet crane 619. The final response is two
adjacent text records at 25/26 with one API ID and indices 0/1. Usage is
deduplicated by the persisted API ID at its latest source revision.

Manual boundary B32 points logically to text tail 26 and preserves exactly 25/26 with summary S33 as anchor. The summary, caveat34, command35 and stdout36 form the existing manual control shape. File attachments B37 then A38 follow stdout, with new UUIDs and consecutive physical parents. Each attachment's entire `content` object is both decoded-equal and byte-for-byte equal to the serialized `toolUseResult` object of the corresponding earlier Read receipt. Filename equals the earlier call input and receipt `filePath` literally. Attachment order reverses the earlier call order; this is one evidenced order, not proof for arbitrary file batches. No old conversation UUID is copied or Read tool re-executed by these injected attachments.

First resume is fileA38 → meta user42 → synthetic assistant43 → real user44 → token reminder45 → real assistant46. Meta42 and real user44 share the same new `promptId`; meta42 is `isMeta:true` with the exact one-text-block “Continue from where you left off.” bridge. Synthetic43 has model `<synthetic>`, no `apiBlockIndex`, `isApiErrorMessage:false`, exact text “No response requested.” and all recorded numeric token counters zero. The subsequent ordinary resume is user50 → reminder51 → assistant52. Filtering controls requires the admitted stage proof; this corpus does not justify globally ignoring similar user text, attachments or synthetic records.

`selected-source-requests.json` preserves relevant original model-message coordinates and content representation without complete SDK system prompts or tool schemas. After compact, both captured resume requests load S's exact full text, retained text25/26, Read input/result system reminders for B then A, local command controls, the meta continue and synthetic bridge. The summary accurately includes the known A/B markers and seed context. Internal source records being Raw-only Canonical candidates does not imply the model did not receive them. Result reinjection uses numbered textual reminders, distinct from the complete unnumbered file receipt object in JSONL.

Summary API `msg_atape_manual_mock_5` has no assistant JSONL record. Native compact stdout top-level usage is 0/0, while its `modelUsage` reports the controlled summary counters 51/19. Compact token metadata and stdout are not evidence for a recoverable JSONL SourceUsage record; the logical totals above include only the six persisted real APIs. Model counters and cost are controlled mock values, not real billing or tokenization measurements.

The recorded binary hash is unchanged before/after and matches every invocation result. Each invocation used a fresh process and the same temporary workspace/configuration. Seed creates the Session with `--session-id`; the remaining invocations use `--resume` for that same Session. Actual result-file argv, persisted records and captured model requests establish the operation. The saved reusable harness was edited later: its plan and compact command wording differs from the actual source/result evidence, so it is not an immutable exact reproducer. The actual compact request was `/compact Preserve synthetic read context and continue from the tool final.`

Recorded native argv restricts the tool set to Read, uses an empty strict MCP configuration, disables Chrome, requests manual permissions without prompts, print JSON and a low-effort Sonnet model. Invocation results record disabled automatic compaction. The saved harness records fake authentication against a loopback model server and separate temporary configuration/workspace, consistent with the captured requests and persisted source paths. It inherited `HOME` from its parent and did not record that value; fresh HOME and isolation from all global context are not established. One manual compact, unchanged synthetic files, B/A injection and two subsequent resumes are evidenced. Changed files, errors, a second manual compact, arbitrary tools, child sessions or other injection orders are outside this evidence.

Only literal isolated `/private/tmp`/`/tmp` workspace/config aliases and the
encoded project directory component were replaced with
`/fixture/native-manual-read-reinjection/{workspace,config}`. The workspace
substitution also replaces that path suffix inside the source's relative
`displayPath`, preserving its five `../` components. No machine-specific
relative-path resolution is claimed. JSONL was not reserialized; original/new
hashes and strict prefixes were checked. Research paths in provenance record
origins rather than required replay dependencies. No binary, research script,
derived-cut file or complete SDK request schema is supplied.
