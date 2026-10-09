# Claude 2.1.263 persisted thinking fixture

An isolated installed Claude Code 2.1.263 CLI produced these files on
2026-10-09. Its Anthropic Messages endpoint was a deterministic loopback SSE
server with a synthetic API key. No real model was invoked. The server supplied
the thinking body, signature, tool requests, reply text, API response IDs and
usage; the CLI produced the JSONL UUIDs, parent graph, foreground child identity,
tool receipts, split assistant records and persistence layout. This establishes
native persistence, not real provider reasoning, token accounting or billing.

The root delegates one foreground Agent, the child reads `fixture.txt`, and both
return a final reply. Each of the four mock responses sends a nonempty thinking
block followed by a tool or text block. The CLI persists each block as its own
assistant record, with distinct UUIDs and a shared API response ID. There are
four thought bodies and eight previously visible message/tool Events across the
two Threads. Each API response reports 17 input and 9 output tokens, so the
latest-per-response total is 68 input and 36 output tokens. The signature is
source metadata and must never become a Canonical thought body.

The child environment used an isolated HOME, CLAUDE_CONFIG_DIR and TMPDIR,
disabled background tasks, child forking, updates and nonessential traffic, and
used a strict empty MCP configuration. Tools were restricted to Agent and Read;
the permission mode was manual with no permission prompts. Full argv,
allowlisted environment, CLI binary SHA-256, source file hashes, byte counts and
thought UUID/block/record-end coordinates are in `provenance.json`. The CLI
exited successfully with empty stderr and one completed foreground child.

Sanitization replaces isolated temporary path bytes with `/fixture/native-thinking`
or `/fixture/native-thinking-runtime`; it does not parse and reserialize source
records. The macOS `/private`-prefixed and unprefixed aliases map to the same
fixture path, with the longest original paths replaced first. UUIDs, parent
edges, timestamps, body text, signatures and correlation
metadata remain unchanged. Original and sanitized hashes are recorded separately.
Prefix/partial-LF, large-body, mixed-block and compaction mutations used by tests
are generated cases, not additional native captures. Disposable mock scripts,
runtime configuration and outputs remain outside implementation commits.
