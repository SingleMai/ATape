# Controlled foreground subagent source evidence

Captured on 2026-10-08 from the installed Claude Code **2.1.263** executable,
whose SHA-256 was
`ef5d2909c8af49f31ab6d5487e90316777bc2fac170adfe8160716caa8aaf4f9`.
These files were written by Claude Code itself, with an isolated
`CLAUDE_CONFIG_DIR` and a fresh temporary working directory. No personal
conversation was read, resumed, or modified.

Model responses came from a deterministic Anthropic Messages SSE mock bound to
`127.0.0.1`, using a fake API key. There was no real model invocation or provider
charge. Prompts, tool IDs, model message IDs, token counts, and assistant text
were supplied by that mock; record UUIDs, graph links, sidechain metadata, agent
IDs, the Agent result wrapper, and the actual Read result were produced by the
installed Claude Code. This verifies source persistence and tool execution for
this narrow scenario, not model-generated reasoning or provider billing.

The successful invocation used `--restricted --safe-mode`, `--tools Agent,Read`,
`--allowedTools Agent Read`, `--permission-mode manual`,
`--permission-prompts none`, `--strict-mcp-config`, an empty MCP configuration,
`--disable-slash-commands`, `--no-chrome`, `--model claude-sonnet-4-6`,
`--effort low`, an explicit synthetic system prompt, a fresh `--session-id`,
and `--print --output-format json`. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`
and `CLAUDE_CODE_FORK_SUBAGENT=0` kept the ordinary subagent in the foreground.
The child process received only a minimal environment with the isolated config,
loopback endpoint, fake key, and traffic/update suppression settings.

Two earlier calibration runs using `--bare` exposed only Read in the request
tool pool and did not spawn a subagent; they are excluded from this corpus.
The successful run exposed Agent and Read, issued two root and two child model
requests, executed exactly one child Read, and reported one completed subagent,
no background start, depth one, and no permission denials. The original isolated
source and disposable mock probe remain under
`/tmp/atape-claude-child-native.QIiSss`; neither is needed to replay this corpus.

## Observed identities and relationships

- Root Session ID: `d33bd4a6-a5ce-47d3-b4d3-91e62386940f`.
- Child Agent ID: `a5b93406db8c7fefd`.
- The root transcript sits beside
  `<sessionId>/subagents/agent-<agentId>.jsonl` and a small `.meta.json` sidecar.
- Every child record has the root `sessionId`, its own `agentId`, and
  `isSidechain:true`. The child's first record has `parentUuid:null`; its record
  parent graph is local to the child file. A record-parent pointer alone does
  not establish its relationship to the root.
- The root Agent call's native tool ID is `call_atape_parent_agent`. Its result
  carries that ID in `message.content[].tool_use_id`, the call record UUID in
  `sourceToolAssistantUUID`, and the child ID in `toolUseResult.agentId`.
  `toolUseResult.status` is `completed`, and `agentType` is `general-purpose`.
- The child Read has ID `call_atape_child_read`; the actual Read result points
  to the child call through both `tool_use_id` and `sourceToolAssistantUUID`.
- Root and child each have two distinct assistant model message IDs. Each
  message has mock usage of 17 input and 9 output tokens, for a family total of
  68 input and 36 output tokens. The root Agent result helper's usage represents
  only the child's last response (17/9), not all child usage. Sum the child
  assistant messages when verifying aggregate usage.

The child file retains its delegated prompt, Read call, actual line-numbered
Read output, structural attachments, and final text. Its record UUIDs and
agent ID are unchanged. The root retains the Agent call/result and final reply.
The `.meta.json` sidecar is preserved as source evidence; this fixture does not
establish a Canonical projection for sidecar fields.

## Content and sanitization

The only tool input was `fixture.txt`, containing
`ATAPE_CHILD_READ_CONTENT: cobalt heron 482.` plus a newline. Searchable final
text markers are `ATAPE_CHILD_FINAL` and `ATAPE_ROOT_FINAL`.

The original temporary working directory, both its `/tmp` and `/private/tmp`
spellings, was replaced with `/fixture/native-foreground-child`. All other
decoded values were preserved, including the native record graph and generated
agent identity. These sanitized files are therefore not byte-identical Raw.
Original and sanitized byte counts and SHA-256 digests are recorded in
[provenance.json](provenance.json).

## Scope and remaining evidence

This corpus establishes an ordinary, completed, foreground Agent invocation
with one direct child and a built-in Read. It does not establish nested or
asynchronous subagents, subagent resume, inherited-context fork subagents,
workflow journals, compaction, continuation, rewind, spill files, missing child
files, interrupted runs, or other Claude versions. Fault-injection mutations in
tests must be labeled synthetic and must not be presented as native behavior.

The documented on-disk layout is also described in the official
[subagent documentation](https://code.claude.com/docs/en/sub-agents#resume-subagents).
The official [SubagentStop hook contract](https://code.claude.com/docs/en/hooks#subagentstop)
distinguishes the main `transcript_path` from `agent_transcript_path` and notes
that transcript writes can lag hooks. This Adapter fixture uses persisted source
records; it does not require installing hooks.
