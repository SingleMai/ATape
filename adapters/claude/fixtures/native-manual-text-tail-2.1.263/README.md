# Controlled manual split-text compaction source evidence

Captured on 2026-10-08 from the installed Claude Code **2.1.263** executable
in a fresh isolated workspace and config directory. No personal history was
read or resumed. These four files are successive snapshots of one source Session.

The native executable SHA-256 is
`ef5d2909c8af49f31ab6d5487e90316777bc2fac170adfe8160716caa8aaf4f9`.
Each invocation used a fresh process and the same isolated temporary workspace
and configuration for this Session, independent of personal/global history.
It used restricted/safe mode, an empty MCP configuration, manual permissions without
prompts, and a deterministic loopback Anthropic SSE mock. Automatic compaction
was disabled. No personal history or real model was used. Full argv and recorded controls are in
`provenance.json`; credentials and request captures are not copied.

UUIDs, persistence, parent links, block indices, boundaries, summary wrappers,
command controls, synthetic bridge and resumes came from the native executable.
Model text, API response IDs and token counters came from the controlled mock.
`Read` was allowed, but this text-only case executed no tools. The mock summary's
mention of files must not be treated as evidence of file reads.

## Snapshot sequence

The single Session is `48656330-5cf7-4f7c-97d4-674c41750762`. Each file includes all
previous bytes plus new native records. Original and sanitized files both have
strict byte prefixes, complete newline records and no repeated UUIDs.

| Snapshot | Native source | Records | Added Events | Added distinct usage | Cumulative input/output |
| --- | --- | ---: | ---: | ---: | ---: |
| `before.jsonl` | `multitext.jsonl` (seed + warmup + split-text reply) | 21 | 7 | 3 | 93 / 47 |
| `compacted.jsonl` | `compact.jsonl` | 31 | 0 | 0 | 93 / 47 |
| `continued.jsonl` | `continue.jsonl` | 38 | 2 | 1 | 122 / 60 |
| `continued-again.jsonl` | `secondcontinue.jsonl` | 44 | 2 | 1 | 151 / 73 |

These are expected Canonical Event/usage counts calculated from the controlled
source. Automated checks through the caller Interface establish capture behavior.
Usage is distinct by real assistant API ID: the two split records share one API ID
and one 41/23 usage observation. Final history has 11 Events and 5 usage IDs.
Per-page repeated usage upserts are not extra distinct usage.

Compaction stdout reports mock model usage 51/19, but JSONL contains no matching
assistant record. Preserve the source and disclose this gap; do not derive actual
usage from compactMetadata or invent summary usage. The native `<synthetic>`
`No response requested.` bridge has zero usage and is Raw-only. The summary is
loaded by the next model request; its Raw-only Canonical treatment avoids
presenting internal summary text as a new user message.

## Exact profile witnessed

The retained tail is exactly two physically consecutive assistant records:

- Head `efa512f0-1a00-47b4-8311-8a804635a4df`, API block index 0.
- Tail `f7e8db2a-f843-4a96-a9d0-07fbadb3df1a`, API block index 1, parent=head.
- Both use API ID `msg_atape_manual_text_mock_10`, model `claude-sonnet-4-6`,
  assistant role, and one nonempty text block per record.
- Manual boundary `9b025818-181f-4866-bc33-d503aff7780f` has parent=null and
  logicalParent=tail, the prior source leaf. `preservedSegment` head/tail and
  `preservedMessages.uuids` / `allUuids` describe that exact ordered pair.
- Both metadata anchors equal summary `fdece27e-a749-4fae-be46-8b8ce630a878`;
  the summary is the next record and has parent=boundary plus both summary flags.
- The existing summary → caveat → /compact command → stdout → synthetic bridge
  control sequence follows. Later ordinary user/assistant records remain linear.

This corpus establishes one manual root compaction retaining exactly two
consecutive text records from the same API response, with same-file continuation.
It provides no acceptance for automatic compaction, retained tool blocks, parallel
tool parents, arbitrary-length tails, repeated UUIDs, cross-file continuation,
child compaction, nested/background children, rewind or fork. It adds no public
Interface, Host migration, uploader, projection change or source-capture claim.

## Sanitization and integrity

Only the isolated workspace CWD aliases, isolated config-directory aliases and
encoded workspace directory are replaced. Literal UTF-8 replacements preserve
all remaining original bytes; JSON is not reserialized. The precise substitutions
and occurrence counts are in `provenance.json`. UUIDs, API IDs, block indices,
model, timestamps, parents, compaction metadata and all other source fields stay
unchanged. Original and sanitized decoded data were compared with only those
path substitutions applied.

| Snapshot | Original bytes | Original SHA-256 | Sanitized bytes | Sanitized SHA-256 |
| --- | ---: | --- | ---: | --- |
| before.jsonl | 9278 | `998e9a1ec819d9b287ce6ef97e5bc363fcf4c026201a72277b40157beafb170b` | 8988 | `41075b5a2e7bfe408ed143b0a7b97e72b8f048b90dfd2a2cf7c53022bc1d5e1c` |
| compacted.jsonl | 14663 | `fa8e237a09f6aff5782f2f186767a096bf76d5343c0c1865e701a3314596603d` | 14178 | `dce91564d09a50aef58ce2cf9bbad91926a2f5fb517a8a7c1a636b09d46e060c` |
| continued.jsonl | 18622 | `71637db2d762ec3b2064de9cf4c499d02ad96e29f253d93a53fb35e11820ca11` | 18021 | `f4a49c1085271931215439e7b4f31e99d13b12fa096a7736913d6d2b7a19fb67` |
| continued-again.jsonl | 21450 | `e4263d5f5eeb92bf0693e3e2be6b3138ec7bebca0b44899cea1c3cc0eec26d0c` | 20762 | `9db7bc96fefd869693a2c896690b3e7fe547f3418ee86ce9cb2d4fe25a7b08f9` |

The usage observations are upserts: records sharing one API response ID have the
same `sourceUsageId`. Across paginated collect calls, retain the latest revision
per ID before summing counters. The before source may return four usage rows under
one-Event pagination while still representing three distinct responses and 93/47.
The installed Collector contract also cuts the original complete-LF prefix after
line 19, then appends the rest of `before.jsonl` across a daemon restart; this is
a test append cut, not another native snapshot, and proves the same API usage ID
stays singular through separate acknowledged HTTP/PostgreSQL upserts.

Installed Collector contract phases preserve the original foreground-child and
single-tail manual Sessions and exercise this third Session independently. The
third Session grows from seven Events/three usage records through zero compact
Events/usage, then two Events/one usage per continuation, ending at eleven Events,
five distinct responses and 151/73. Control messages remain complete Raw without
becoming Canonical/Search text or model usage. These expectations do not claim a
published-binary upgrade, browser acceptance or support for wider source profiles.
