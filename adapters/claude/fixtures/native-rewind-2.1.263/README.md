# Native Claude rewind evidence (2.1.263)

Acquired on 2026-10-09 with the installed native binary pinned in `provenance.json`.
The CLI ran with an isolated HOME/config/workspace, synthetic API key, disabled
nonessential traffic and only a loopback streaming API. Thinking, replies and
usage were supplied by that endpoint; this is persistence/topology evidence,
not a claim about provider reasoning, billing or live-provider integration.

`resume-01` through `resume-04` capture a first turn, an abandoned second turn,
`--resume-session-at` the first turn's final assistant, and ordinary subsequent
`--resume`. All stages exited 0. The abandoned branch remains physically present.

`control-01` through `control-05` capture a live stream-json session: first turn,
second turn, successful `rewind_conversation` to before that second user, a new
turn before process shutdown, and successful rewind before the first user.
Stage 03 appends an explicit nonnull leaf selector. Stage 04 has subsequent new
chain entries while that older selector is still present. Stage 05 appends an
explicit null selector. The process exits 0, with no stderr.

Acquisition JSON records exact arguments, the environment allowlist, binary and
script hashes and successful control responses. `provenance.json` records
original and retained hashes, byte sizes and path sanitization. Source JSONL is
preserved byte-for-byte apart from those literal path replacements. Generated
malformation, partial-LF, tool, compaction and ownership mutations in tests must
be described separately from these native acquisitions.
