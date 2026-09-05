# ADR-0011: Managed Local Collector and Session Presence

- Status: Accepted
- Date: 2026-09-05

## Context

ATape can collect continuously in a foreground terminal, but a teammate should not have to keep that terminal open for shared history to remain current. The CLI needs to start, stop, and inspect one local Collector process while preserving the existing rule that Harness Adapters are loaded only for configured Project jobs and released after each job.

The Project Memory view also needs trustworthy presence semantics. A source file remaining in a Harness's active directory does not prove that a teammate is still working. Conversely, only the Adapter can reliably know that a provider explicitly archived or ended a Session. ATape therefore needs a shared distinction between provider lifecycle and recent activity.

## Considered Designs

### Require an external process supervisor

Users could run `atape collect` under launchd, systemd, Docker, or another supervisor. This is operationally robust, but makes first use platform-specific and leaves `atape status` unable to present one coherent Project/Adapter view without additional conventions.

### Install an operating-system service from the CLI

Native launchd and systemd units can restart after login or reboot. They also require separate privileged or platform-specific installation, upgrade, and removal behavior before ATape has evidence that reboot persistence is necessary for v0.1.

### Manage one detached Collector process

The CLI can own one detached Node process, retain only small process and Project/Adapter status files, and expose the same lifecycle Interface on supported development platforms. The child still runs the existing bounded Collector Module; it does not turn Adapters into sidecars.

## Decision

ATape v0.1 adds `atape start`, `atape stop`, and `atape status` around one CLI-managed detached Collector process on macOS and Linux. Windows users retain `atape collect`; background process control will not fall back to unsafe PID-only ownership checks.

- The application Module owns lifecycle intent, option validation, configured-job discovery, cycle scheduling, and status projection.
- A Node process Adapter owns spawning, process identity verification, graceful termination, log redirection, and atomic process metadata.
- The detached process runs the same bounded collection cycle used by `atape collect --once`. It records one small status entry per configured Project/Adapter after each cycle.
- Status records retain timestamps, bounded collection counters, and the current failure reason. They never contain Canonical messages, Raw source, Adapter cursors, or local transcript bodies.
- `atape start` is idempotent while the managed process is alive. `atape stop` targets only a process whose recorded random token is still present in its command line, avoiding termination of a reused PID. A stale metadata file is removed without signaling an unrelated process. Platforms where ATape cannot verify that token fail explicitly.
- The default interval remains 30 seconds and the accepted range remains 10 seconds through one hour. Collection concurrency remains bounded from one through eight.
- Detached collection survives terminal closure but is not promised to survive logout or reboot. Native service installation may later implement the same lifecycle Interface.

Session presence is interpreted centrally by the Go read Modules:

- `ended` means the Adapter observed an explicit provider end or archive and remains ended.
- `idle` means the Adapter explicitly reported inactivity and remains idle until a newer revision changes it.
- `active` means the source is open and the Session was updated within the last five minutes. An older open Session is presented as `idle` without mutating Canonical history.

Workspace active counts, Project Memory, and Session Reader use the same effective-status rule. Adapters continue to report source lifecycle; read-time presence aging does not require a synthetic ingestion event.

The Codex Adapter derives a stable title from the first root-thread `UserMessage`, using a bounded scan and a short normalized projection. If no user message is available, it emits `Untitled Codex conversation`; it never exposes the opaque provider Session ID as the title.

## Consequences

- Team history can stay current after the starting terminal closes, while disabled Adapters consume no runtime memory.
- `atape status` exposes the last successful cycle or current failure for every configured Project/Adapter without querying Canonical or Raw storage.
- Process control remains user-local and portable enough for v0.1, but does not provide crash restart or boot persistence.
- Presence naturally ages from active to idle even when a Harness leaves old files in its active directory.
- Canonical status remains the durable provider fact; effective presence is a read projection and may change with time without a database write.
- Titles remain deterministic across Adapter pagination and at-least-once replay.

## Rejected Alternatives

- **Persistent process per Adapter**: recreates the idle memory, supervision, and upgrade costs rejected by ADR-0008 and ADR-0009.
- **Store runtime status in Canonical Sessions**: mixes local Collector health with shared conversation facts and would create synthetic conversation revisions.
- **Treat every unarchived file as active forever**: produces false team presence for abandoned or old Sessions.
- **Have the Web infer idle independently**: duplicates lifecycle rules in every reader and makes Workspace counts disagree with Project Memory.
