# @atape/adapter-cursor

ATape Adapter for controlled Cursor CLI sessions and native JSONL transcripts.
It provides `atape.new-session.v1`, `atape.source-capture.v2` and Git attribution.
Node.js 24 or later is required. The installed bundle has no runtime dependencies.

The first profile is pinned to Cursor CLI `2026.10.01-e373342`. Set
`ATAPE_CURSOR_EXECUTABLE` to its absolute executable path before starting a new
Session through ATape. Cursor's configured data and configuration roots must be
absolute and resolve to the same real directory. `CURSOR_DATA_DIR` defaults to
`~/.cursor`; `CURSOR_CONFIG_DIR` defaults to `$XDG_CONFIG_HOME/cursor` when set,
otherwise `~/.cursor`. Only controlled start may initialize a missing root;
capture and discovery never create native directories.

Controlled start requests a fresh native UUID without resume or workspace
redirect options. ATape stores immutable local creation evidence and confirms a
complete stable transcript prefix. Historical conversations without that proof
remain unattributed and are skipped. Mutable metadata and workspace slugs never
establish Project ownership. A new Host with creation receipts and canonical
profile v3 is required.

Text and tool inputs retain their source values. Missing event times remain
`null`; IDs and order derive from physical row and content-part positions. Tool
results, native IDs, model metadata and child graphs are not invented.
`turn_ended` remains a structured Raw fact and does not end the Session.
Raw capture contains complete parsed rows, including unknown fields, through
ATape's standard upload-time redaction. It is not a byte-identical file archive.
The title uses the complete first user text only when it fits the short title
bound; otherwise it is `Cursor conversation`.

Continuation validates both the creation prefix and the last acknowledged byte
prefix in one stable read. Identical rewrites and repeated appends preserve IDs.
Truncation, compaction or changes to any acknowledged bytes stop that source
without replacing its published head. The profile does not assume a complete LF
row is immutable during real native activity; such native rewrites may therefore
stop capture. Incomplete live tails are retried during controlled start.

Discovery isolates bad sources and reports bounded diagnostics. Reads admit at
most 100,000 inventory entries and records, 1 MiB per row, 64 MiB combined
transcript/metadata bytes, 1,000 child candidates and 120 seconds per operation.
Caller limits may be smaller. Child transcripts are reported as unsupported;
other healthy root Sessions can continue.

Interactive chat has no total proof deadline. The Adapter owns the immediate
native child until exit or cancellation, with bounded proof attempts and retry
backoff. Permanent proof failures stop confirmation while the chat continues;
they are reported after native exit. Cancellation terminates and joins the
immediate child. Arbitrary native tool grandchildren are not guaranteed to be
cleaned up by parent-only cancellation. The CLI Host restores terminal state.

Fixtures and external-process acceptance are synthetic, derived from pinned
Confab shapes and official static Cursor code. Authenticated native CLI/IDE
acceptance, native row rewrite behavior and tool descendant cleanup remain
unverified. No Cursor account was available for this increment.

Build and verify with `pnpm --filter @atape/adapter-cursor build`,
`pnpm --filter @atape/adapter-cursor test`,
`pnpm --filter @atape/adapter-cursor typecheck` and
`pnpm --filter @atape/adapter-cursor verify:package`. Package verification installs the exact tarball offline
outside the workspace and imports only its self-contained bundle.
