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
with one additional marker reply. It is a negative fixture: native parent/fork
metadata must prevent accidental publication as a new ordinary root. It does not
establish supported fork semantics.

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
