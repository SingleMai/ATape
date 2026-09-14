# Grok Build native fixtures

Generated on 2026-09-13 with the installed official `grok 1.0.3 (1a29d5bc12d4)`
on macOS arm64. Only dedicated temporary workspaces were used; personal history
was not imported. Native IDs, timestamps, counters and update order are retained.
Absolute temporary CWDs, Grok home and an encoded terminal-output locator were
replaced with `/fixture/...` equivalents. No credentials, system prompts,
model-input histories or referenced terminal files are included.

`native-1.0.3/initial` is a new headless conversation asking the model to read
`marker.txt` and repeat `ATAPE_GROK_NATIVE_20260913`. `resumed` adds a separate
process invocation from a different requested CWD, asking it to read a deliberately
missing file and reply `ATAPE_GROK_RESUMED_20260913`. Grok kept the original CWD and
source directory. Both processes used `--no-memory --no-subagents
--disable-web-search --no-plan --max-turns 3 --output-format json`; continuation
used `--resume <native-id>`. The earlier six updates were byte-equivalent after
JSON parsing. Event IDs restarted, while `prompt_id` changed.

`shell` adds another native resume asking for exactly `printf
ATAPE_GROK_SHELL_20260913` and a final marker, with `--always-approve` for that
controlled command. The native tool name is `run_terminal_command`, and a local
pre-tool hook emitted `hook_execution` telemetry. That telemetry belongs only in
Raw. These stages contain 6/12/19 update records, 5/10/15 conversation Events and
1/2/3 turn/model usage rows. There are no persisted thoughts, although usage
includes reasoning output. The final totals are 82,054 input, 1,169 output and
68,096 cached-input tokens. Persisted input already includes cached input.

`fork` is a native `--resume <id> --fork-session` of the two-turn conversation
with one additional marker reply. It now verifies the explicit fork profile:
copied successful/failed tools retain their history, while the fork has independent
Event/tool/usage identities. It is not an ordinary linear-root fixture.

`worktree` is a new native one-turn conversation created inside an actual Git
worktree of a temporary committed repository with the fixture remote
`https://github.com/atape-fixtures/grok-native.git`. It has its own native Session
ID, original CWD and three updates (two conversation Events, one usage row).
Its Git path, commit and remote metadata are preserved with the CWD sanitized.
The installed HTTP contract recreates a real repository/worktree at controlled
paths and uses Host Git attribution; the remote identifies a fixture and is never
fetched. This sample is separate from the three-turn usage totals above.

Runtime tests make explicit synthetic corruptions for missing Origin, unsupported
mutation flags, duplicate IDs, invalid UTF-8/JSONL, unfinished turns, budgets and
cancellation. The HTTP contract relocates these controlled paths to isolated
Projects and adds synthetic secret/search markers and complete-record edits for
policy and recovery assertions. It injects lost activation/Raw responses after
Server commit, then deletes all three source files. Neither those edits nor the
fault injection are claims about Grok's native edit/rewind behavior.

`edit` is a separate native Session with a grep match, required read_file and
successful search_replace changing marker.txt from version=before to version=after.
It has 12 updates, 11 Events and one usage row (57,670 input, 1,417 output,
43,072 cached input). Original numeric stdout/stderr bytes are retained after
path sanitization; the Adapter decodes them before Host redaction. Native diff
content has old/new text and line context; bounded Canonical tool input/output
retains the edits while the original ACP diff and location fields remain Raw.

`empty-search` is a separate native Session with no grep matches: six updates,
five Events and one usage row. Native status is completed even though exit_code
is 1. Both used the same no-memory/no-subagents/no-web/no-plan headless workflow
as above; the edit run allowed its controlled file modification. Two intervening
restricted-tool probes produced assistant refusals without tool calls and are not
committed as tool evidence. A synthetic HTTP marker is appended only to grep's
encoded stdout to verify masking before Reader exposure with Raw disabled. The
shared Search Interface searches conversation text and tool labels, not tool
input/output payloads; tests retain that distinction.

## Native fork continuation corpus

The `fork-*` corpus was generated on 2026-09-14 UTC (2026-09-15 Asia/Singapore
when implementation checks completed) using the same official 1.0.3 binary on
macOS arm64. New temporary `project` and `foreign` directories contained distinct
controlled marker files. No personal history was imported. Commands used
`--no-memory --no-subagents --disable-web-search --no-plan --tools read_file
--output-format json`, explicit UUIDs for new roots/forks and bounded `--max-turns`.
Only temporary path prefixes and Grok home were replaced with `/fixture/...`;
native IDs, timestamps, token counters and record order are retained.

| Fixture | Native action | Records / Events / usage rows |
| --- | --- | --- |
| `fork-parent` | New root reads marker.txt and replies | 6 / 5 / 1 |
| `fork-created` | Resume root with `--fork-session --session-id`, then read/reply | 12 / 10 / 2 |
| `fork-resumed` | Resume the new fork in a separate process | 15 / 12 / 3 |
| `fork-nested` | Fork the resumed fork with another explicit UUID | 18 / 14 / 4 |
| `fork-nested-resumed` | Resume the nested fork in a separate process | 21 / 16 / 5 |
| `fork-parent-grown` | Continue the original parent after both forks | 9 / 7 / 2 |

Every invocation after the first requested `foreign` as CWD. Grok retained
`project` in native metadata, source location and actual file reads. Every resume
kept the earlier JSON records byte-equivalent after parsing. Each fork copied its
parent's entire prefix, rewriting only `params.sessionId` and outer `timestamp`;
native Event/prompt IDs and `agentTimestampMs` remained unchanged. The nested
prefix therefore contains Event IDs from both earlier Sessions. Parent growth
did not update either fork file. The fixtures contain persisted usage for
`grok-4.5` and `grok-4.6`; this is not a model-selection compatibility claim.

Runtime tests intentionally corrupt metadata, owner transitions, event times and
completeness. Installed HTTP tests relocate the metadata paths and add synthetic
masking/Search markers, malformed lineage and committed-response loss. Those
mutations are fault injection, not native edit/rewind evidence. Personal-environment
and browser acceptance of this extension are deferred at the user's request.
