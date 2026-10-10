# ADR-0116: Controlled Cursor creation and capture

Status: Accepted

Date: 2026-10-10

## Context

Cursor native JSONL contains no reliable conversation clocks or creation project. A directory slug, current working directory of a later resume, file mtime, and mutable metadata cannot prove origin. ADR-0111 supplies a bounded native reader; ADR-0114 preserves unknown source time. The user authorizes Confab-derived synthetic acceptance now and real Cursor acceptance later.

## Alternatives and decision

Compared a launch-only wrapper, generic Hooks, and a Host-owned new-session capability. A wrapper has no trustworthy attribution proof and Hooks cannot prove new versus resumed sessions or actual CLI cwd. Choose a small generic newSession Interface, a durable Host receipt Module and a Cursor Adapter which proves an exclusive new native session. Provider knowledge stays within the Adapter. Publication, redaction and recovery reuse existing Modules. No Cursor-only public binary, empty collection placeholder or fabricated project/time.

Amend ADR-0081 narrowly: public `atape start --tool cursor [--project …] [--prompt …]` hands an interactive supported macOS/Linux TTY to a controlled native session. This does not add public collect, arbitrary native argv, JSON management or operation aliases. Help/version remain non-TTY. An older bootstrap parses grammar before delegation, so users must install an updated bootstrap to use start.

## Generic Interface and ownership

- Manifest optional `newSession: "atape.new-session.v1"`, exact runtime match `.newSession.start`; reuse AdapterRuntimes.open, installed-package leases and Scope closure. HostedAdapter exposes optional Effect operation; no parallel runtime.
- Application `startAgentSession({toolId,cwd,projectId?,initialPrompt?})` owns current account, active Team, permission, registered Project selection and fresh workspace/Git matching. `LocatedProject.requestedCwd` is required canonical caller cwd, separate from Git root. Do not use GitSourceAttribution.resolve because that writes unrelated bindings.
- Reject multiple registered folders covering actual cwd across any Instance. Explicit --project cannot bypass ambiguity. Git start rejects any covering registered folder; Git selection otherwise uses active Instance and existing remote matching, without a new global Git attribution policy.
- Freeze actual cwd, repository root/remote and selected Project/tool. Host recordAttempt revalidates cwd/root/remote/config/selection immediately before writing. Changes fail rather than silently select another Project. After valid creation, config disable or upgrade cannot erase the proof; confirm checks the immutable attempt, not current selection. Collector always performs fresh normal permission checks.

Provider start request:

```ts
{ origin: { cwd, repositoryRemote? }, initialPrompt?, signal,
  creation: { recordAttempt, confirm, abandon } }
```

`recordAttempt({sourceId,stateDirectory,profile,sourcePath},signal)` returns immutable Host attempt `{protocolVersion:"atape.creation-receipt.v1",attemptId:HostUUIDv4,adapterId,sourceId,stateDirectory,profile,sourcePath,origin:{sourceId,originKey:HostMinted,cwd,repositoryRemote?},recordedAt}`. `confirm({prefix:{bytes,rows,sha256}},signal)` adds confirmedAt/prefix. `abandon(signal)` cannot remove confirmed proof. Observation times never become source conversation clocks.

New Hosts always provide read-only context `creationReceipts.readConfirmed({stateDirectory,sourceId},signal)` returning confirmed receipt or undefined. The Domain context field remains optional to express older Hosts/direct callers; Cursor requires it and rejects absence. Store namespace is Adapter + canonical state root + source ID, never Project. Scope-bound writes exist only during active controlled start and reject late callbacks. Result `{sourceId,creation:"confirmed"|"unconfirmed",exitCode:0..255}` must match Host facts. Signals/null child statuses are typed cancellation/failure, never invented numeric exits. An optional initialPrompt is bounded to 64KiB UTF8 and excludes NUL; Application validates it before dependencies or mutation.

The Node terminal boundary snapshots complete terminal state with bounded `stty -g` and restores the exact token after child/monitor finalizers, on success, failure and cancellation. Wrap the complete `Effect.scoped(startAgentSession(...))`, including factory and installed-package finalizers, rather than only the foreign Promise. Preserve inherited standard streams and the original controlling terminal. Do not use detached setsid or signal the shared foreground process group. The Cursor Implementation owns termination, bounded escalation and joining of its immediate native child. Keyboard SIGINT uses normal foreground delivery. Explicit parent-only cancellation of arbitrary native tool grandchildren is not a verified guarantee; real native acceptance must assess that boundary.

## Receipt lifetime and bounds

- Source ID/profile nonempty <=200; absolute no-NUL cwd/state/source path <=4096; remote <=4096 with no CR/LF/NUL. Root exists and is canonical. Source path is normalized lexical child of root but need not exist before launch.
- Positive complete JSONL prefix bytes <=64MiB, physical rows <=1M, lowercase SHA256. Receipt serialized UTF8 <=32KiB.
- Owner-only bounded no-follow Host storage under ATAPE_HOME; hashed Adapter directory and direct hashed root/ID lookup; validate all identity fields. Missing differs from corruption/IO. Atomic immutable compare-and-set proof and fsync.
- Each actual write enters guardRuntimeWrite; do not hold global writer lease for the child lifetime. Join in-flight atomic operations before abandonment/lock release on cancellation. Hold the existing installed package lease for Scope lifetime.
- Host never creates Cursor folders. Provider controlled start may safely initialize a missing root, never preclaim native chats UUID directories. Discovery is read-only; identical absolute configured roots which are still missing yield an empty inventory, not an initialization or failed waiting job.

## Cursor controlled native launch

- Explicit `ATAPE_CURSOR_EXECUTABLE`; never infer `agent` (which is Grok on the user's machine). Pinned CLI profile `2026.10.01-e373342`; validate version and executable before launch.
- Generate crypto UUIDv4. Bounded preflight confirms ID absent from all native inventory and expected chats metadata/bucket; IO, duplicate or bounds fail closed. Native exclusive chats mkdir is authoritative; EEXIST never falls back to resume.
- Creation evidence assumes a cooperating native executable and local processes. It does not authenticate against another local process deliberately learning and claiming the fresh UUID between preflight and native creation, then writing a matching transcript before the native child reports its failed claim. The pinned native CLI supplies no public claim handshake; fixed delays cannot establish one.
- Fixed native `--disable-auto-update --new-session-id <uuid>` arguments and optional prompt after `--`; version verification also disables native auto-update. no resume, continue, worker, worktree, data-root or arbitrary args. Never pass --workspace: native saved workspace mapping can redirect even an absolute argument. Set spawn.cwd to canonical requested cwd. Strip NODE_OPTIONS, NODE_PATH, BASH_ENV, ENV while preserving auth environment.
- Pure catalog/node helpers: cursorConfigHome = nonblank CURSOR_CONFIG_DIR else nonblank XDG_CONFIG_HOME/cursor else home/.cursor; cursorDataHome = nonblank CURSOR_DATA_DIR else home/.cursor. Initial profile requires absolute configured paths and canonical config/data equal; relative or split roots unsupported. Child-private native environment explicitly freezes both CURSOR_CONFIG_DIR and CURSOR_DATA_DIR to the canonical root; do not mutate global environment. Fixtures use native variables, no invented ATape home override.
- slug(cwd) replaces non `[a-zA-Z0-9]` with `-`, collapses and trims hyphens. Empty slug unsupported before attempt/spawn. Exact source path is `<data>/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`; chat bucket `<config>/chats/<md5(resolve(cwd))>/<uuid>`. Same UUID at another source path cannot confirm.

Only a stable valid nonempty complete expected native transcript, observed while the owned child is alive or after a successful normal final exit, confirms proof. Spawn, printed UUID, metadata, exit 0 alone do not. Spawn/claim failures, cancellation or no evidence abandon. A crash-pending attempt never confirms later from a resumed session. Once confirmed, later nonzero exit does not revoke proof. A failed observed exit before proof forbids late confirmation; retry uses fresh UUID.

The monitor lives for the owned interactive child lifetime; no total first-proof deadline, since a human can idle. Each read is bounded <=120s or caller's smaller deadline; at most one in flight. Missing/changed/precisely incomplete tails retry with capped 250ms/500ms/1s/2s backoff. Confirmation stops monitoring but joins child. Permanent format/unsupported/limit/timeout stops monitor and abandons without killing chat; receipt IO/contract failures report after child exit. Only explicit cancellation/Host close terminates and joins child. Successful exit while pending joins/cancels current read then makes one final stable read.

## Source capture and continuity

- Implement real sourceCapture.v2 + newSession + close factory; no legacyMigration or Raw policy capability.
- Native inventory isolates per-source faults. Duplicate IDs diagnose and skip all claimants while unrelated healthy sources continue. Selected reads do not fail from unrelated bad files. Global limits/untrustworthy roots fail typed.
- Require receipt root, source ID, profile, exact path and originKey. Unattributed history is skipped with local diagnostics; path guesses never assign it to a Project.
- Canonical v3 root Thread only; Session idle/partial, Event occurredAt and Session updatedAt null, usage empty. Stable physical row+part identities/indexes; fidelity partial. No timestamps, mtime, inode or path identity guesses.
- Preserve text including user_query wrappers. Use the entire short first user text for title; if it exceeds the title bound use a fixed fallback. Do not take only its first line, trim or truncate it: splitting a multiline literal or pattern before Host masking can prevent a match. Mutable sidecars have no title authority. Tool name/rawInput and derived call ID only: omit invented state, results/output, thinking and model. turn_ended is Raw only, never Session ended. Child files explicitly unsupported diagnostics; no fake topology. Raw covers root only when enabled.
- Checkpoint <=2KiB `{v,sourceId,originKey,rows,bytes,sha256}`. First capture validates confirmed initial prefix; later capture validates acknowledged prefix. Arbitrary append cycles, touch and byte-identical rewrites preserve identities; nonprefix rewrite/truncation/compaction is changed with the published head preserved, never lossy replacement or numbered compression special cases.
- Constructed fixtures do not prove that a complete native LF row is immutable during streaming. If native updates an already confirmed assistant row, the conservative nonprefix check also refuses that update and preserves the published head. Do not treat turn_ended as a commit marker or claim native append-only behavior; real native acceptance must resolve this compatibility limit.
- Native reader requiredPrefixes max2 verifies both against the same already-verified bytes and returns full prefix; real physical row count, complete LF and SHA. No reread/reencoding/Buffer exposure. Same bytes recreated at the same path count as content continuity, not local tamper resistance.
- Defaults: 1MiB row, 64MiB aggregate source, 100k entries/records, page100, operation120s, diagnostics32, metadata64KiB, frame500 Events, tool input64KiB. Raw supplies complete parsed native row objects, retaining unknown fields for recursive Host masking. Do not duplicate JSON-escaped rawJson strings or claim byte-identical file archival; original-byte prefix continuity is a separate local proof. No plaintext provider draft persistence before Host redaction.

## Verification and limits

Adapter public Interface tests use constructed Confab fixtures and an explicitly synthetic native executable. Include delayed first line, incomplete-to-complete, proof limits without killing child, failed exit before file, cancellation joining, confirmed then failed exit, duplicate isolation, exact receipt path and unlimited append-prefix cycles.

Installed CLI `atape start` via PTY creates its own receipt; installed Cursor factory/Collector uploads through authenticated HTTP to real PostgreSQL. Verify nullable Reader/Search, shared redaction, skipped unattributed history, no invented Usage/children, append stability/no-op/nonprefix preservation and frozen recovery after response loss/source deletion. Required gate name is `controlled Cursor start and capture`. It is not real Cursor native acceptance. Pack real CLI+Cursor tarballs in a temporary install and clean all owned processes/roots.

Package producer/catalog/release verification include Cursor as eighth bundle package. Reader compatibility retains the original seven required packages, accepting additive bundles. No npm publication, Server deployment or production migration is implied. Current implementation and limits belong in the Cursor guide.
