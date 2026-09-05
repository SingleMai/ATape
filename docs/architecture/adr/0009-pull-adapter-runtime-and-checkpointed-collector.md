# ADR-0009: Pull Adapter Runtime and Checkpointed Collector

- Status: Accepted
- Date: 2026-09-05

## Context

The CLI management plane installs Adapter packages and enables them per local Project, but it deliberately does not execute provider code. The Collector Host now needs a stable executable Interface that can represent root and subagent Threads, preserve Raw source separately, redact secrets before either upload, and run every 10–30 seconds without reading unbounded local files into memory.

Delivery crosses three independently failing boundaries: provider files, Canonical ingestion, and Raw archive ingestion. Canonical must be committed before its server Session ID can be used by Raw. A client may stop after either remote commit but before persisting local progress, so the Interface must make replay deterministic and checkpoint advancement explicit.

## Considered Designs

### Adapter-owned push stream

Each Adapter watches provider files and pushes observations through callbacks. This can minimize latency, but it gives every Adapter responsibility for scheduling, backpressure, retry, cancellation, and process lifetime. A faulty Adapter can accumulate memory or advance provider state before ATape has durably accepted the observation.

### Host-owned bounded pull pages

The Host opens only enabled Adapters and calls `collect` with an opaque committed cursor plus explicit size limits. An Adapter returns a bounded page and a next cursor. The Host validates and redacts the page, commits Canonical followed by Raw, persists acknowledged Raw offsets while retaining the old cursor, and only then atomically advances the cursor.

### Persistent sidecar protocol

Each Adapter runs as a supervised process and exchanges pages over IPC. This gives stronger crash and dependency isolation, but adds process management, an IPC transport, and idle memory before ATape has evidence that installed Adapters require that boundary.

## Decision

ATape v0.1 uses a Host-owned, in-process, bounded pull Interface.

- An installed package exports `createAtapeAdapter(context)`. The Host validates the package manifest again, dynamically imports only an Adapter enabled for the selected Project, scopes its lifetime to that collection job, and calls its optional `close` method on release.
- `collect(request)` receives the last durably committed opaque cursor and Host limits. It returns `atape.adapter.v1alpha1`, zero or more Session observations, a replacement cursor, and whether more pages are immediately available. Every page that emits observations must return a non-empty cursor different from the requested cursor, including Raw-only changes whose filesystem watermark did not move.
- One observation contains one Session snapshot, its complete Thread topology for that revision, bounded Canonical Events, and bounded append-only Raw text segments. Parent Thread and child Thread references represent subagent conversations without flattening them into the root flow.
- Adapter Events embed an accepted subset of stable ACP protocol v1 `SessionUpdate` and `ContentBlock`, type-checked against `@agentclientprotocol/sdk` 1.4.0. ATape adds capture identity, revision, ordering, Raw reference, timestamp, and Thread relation fields around ACP; it does not define another Message or ContentBlock model. The client HTTP Adapter alone derives the current server's reader-oriented flat text projection.
- Raw references are structured in the Adapter output. The HTTP Adapter maps them to the same scoped Raw object identity used for Raw uploads; provider packages do not invent globally unique server IDs.
- Adapter Raw segments carry a provider generation and source byte offset. Non-final segments end at a complete newline-delimited record boundary so the Host can redact a whole provider record without splitting a secret. After redaction, the Host divides one Adapter segment into UTF-8-safe Raw transport chunks of at most 256 KiB. It separately tracks source offsets and post-redaction server offsets, maps provider rewrites to the next server generation, and rejects gaps, duplicate offsets, or appends after finalization. A replay receipt may report that the server object is already farther ahead, but the local transaction advances only after every transport chunk for that Adapter segment succeeds.
- The Host applies secret redaction to Canonical free text and Raw text before network I/O. Identity fields are never rewritten; Adapter authors must not place secrets in IDs.
- Canonical and Raw remain separate transport methods and server requests. For each observation, Canonical commits first and returns the server Session ID; Raw chunks then commit against that ID.
- Each fully acknowledged Adapter Raw segment advances its local source/server offset while the opaque Adapter cursor remains unchanged. The cursor advances only after every Canonical batch and Raw transport chunk in the page succeeds. A failure inside a split Adapter segment leaves its source checkpoint unchanged; deterministic transport chunk identities turn already accepted pieces into no-op replays. On recovery, fully checkpointed source ranges are skipped. Checkpoint writes use a compare-and-set revision so concurrent collectors cannot overwrite newer progress.
- Remote network and `408`, `429`, or `5xx` failures receive a small bounded retry. Adapter contract failures and server rejections do not retry in the same cycle.
- The Host runs at most four Project/Adapter jobs concurrently by default, never more than eight, drains at most twenty pages per job per cycle, and owns cancellation and interval scheduling.
- Client identity contains an explicit stable Team user ID plus a locally generated installation ID. Local paths, cursors, and Raw progress are never uploaded as Project fields.
- A continuous collector defaults to a 30-second interval. Ten seconds is the minimum supported interval; `--once` performs one bounded cycle for automation and diagnosis.
- One CLI-managed detached Host may own those cycles as specified by ADR-0011. Project/Adapter run status is persisted separately from checkpoints and contains no conversation content.

## Consequences

- Adapter authors implement provider discovery and normalization, while one deep Collector Module owns scheduling, validation, redaction, ordering, retry, checkpointing, and failure isolation.
- An interrupted page may be uploaded again, but deterministic Canonical batch and Raw chunk identities turn the replay into one server effect. Already acknowledged Raw ranges are skipped without storing their bodies. Provider deletion never produces a delete observation.
- Raw source is not retained in a local queue. Only opaque cursors and small per-object append metadata persist, so local disk use does not scale with conversation content.
- In-process packages share the Host trust boundary. Explicit installation, disabled lifecycle scripts, bounded outputs, scoped release, and typed failures reduce accidental damage but are not a security sandbox.
- The pull contract favors seconds-level collaboration visibility rather than sub-second streaming, matching the product requirement while preserving a future sidecar implementation behind the same Host Seam.

## Rejected Alternatives

- **Presentation-owned polling**: would place scheduling, cancellation, and retries in CLI argument/rendering code.
- **Advance cursor after Canonical only**: could permanently omit Raw after a Raw outage.
- **Store Canonical and Raw in one client payload**: would couple independent server concerns and prevent Canonical success from remaining explicit.
- **Persist Raw upload bodies locally**: adds a durable queue and disk-capacity policy that v0.1 does not need; deterministic re-reading through the unadvanced Adapter cursor already provides replay.
