# ADR-0070: Source Collector recovery and scheduling

- Status: Accepted implementation detail of ADR-0059
- Date: 2026-09-11

The source runtime, comparison and publication Modules need one Host workflow to
recover frozen obligations and advance fresh discovery. Calling them from package
code would expose authorization, persistence and retries to every provider.
Placing orchestration in CLI commands would put business rules in Presentation.

## Interface and composition

`SourceCaptureCollector.collect` accepts the configured Project, Adapter, opened
Host runtime and existing Collector snapshot. Its Implementation owns account
journal lifetime, recovery, attribution, comparison, preparation, publication,
independent Raw delivery, bounded diagnostics and CAS progress. The Module adds
Depth at the existing external package and remote Server Seams: callers select
one cycle without learning those protocols. Tests use its Interface and the
actual Node runtime, journal and Collector configuration Adapters.

`runCollectionCycle` selects this workflow only for the explicit source capability.
Legacy Adapters retain their collection and Raw-policy path. Node composition
requires `ATAPE_SOURCE_COLLECTION_LIMITS`, a JSON object capped at 16 KiB; absence
leaves source collection unavailable. Schema validation requires explicit source,
projection, journal, Raw, comparison, recovery and cycle admission. No release
defaults are selected. OpenCode remains private and unregistered.

Host attribution uses original creation Origin. Git Projects use the shared Git
attribution Interface; directory Projects require the actual resolved source path
inside the freshly located directory Project. Directory validation happens after
frozen recovery for source runtimes, so a deleted Project directory cannot block
already authorized obligations. Legacy directory validation remains before its
package factory opens. Unknown/excluded discovery never opens a source view.

## Durable progress and lifetime

The versioned `atape.source-collector.v1` cursor stores bounded discovery position,
an offset within a repeated page, and independent recovery source/capture positions.
Existing legacy checkpoints fail explicitly; they are not implicitly migrated.
Canonical progress remains the journal's actual activation checkpoint. Installation
and Project creation bindings must match, and each cursor commit uses Collector CAS.

Recovery enumerates journal metadata before source discovery. It can deliver after
source or Project deletion, without reopening a source or recomputing bytes. Fresh
collection recovers an unactivated attempt first, obtains current Raw policy, and
compares a disposable view against actual coverage. Changed Canonical starts Begin
before a new source view. Raw-only work gets its independent observation. Source
Scope closure precedes seal and content HTTP in both paths.

Journal format 5 adds a unique partial index for each source's preparing/sealed
attempt. `unactivated(owner)` returns that one attempt directly, even when a bounded
pending page contains older activated Raw obligations. It is owner-fenced. Verified
format 1–4 bindings upgrade transactionally without changing bytes or receipts;
wrong bindings cannot perform the migration. Existing reserve semantics already
enforce the indexed uniqueness invariant.

Confirmed Canonical payloads are reclaimed before independent Raw requests. Raw
failure, delay or later policy cancellation cannot retain already reclaimable
Canonical indefinitely. Raw remains until actual ACK or authorized cancellation.
Each completed recovery capture persists its scan position; finishing a recovery
sweep persists the reset before discovery can fail. Local journal/CAS failures and
authentication failures remain fatal, while per-source failures are isolated into
bounded diagnostics with no source payload or remote error text.

## Bounded scheduling

One recovery attempt has an explicit `recovery.sourceMs` deadline, and fresh work
has `sourceWorkMs`. The cycle deadline must be at least three recovery deadlines
and twice a fresh-source deadline, leaving room to advance after a slow source.
Operation/page/count limits remain independent. Deadlines interrupt asynchronous
work and close Scope; they do not preempt synchronous provider code or establish a
measured physical memory limit.

Only discovery continuation sets a source job's `hasMore`. Independent recovery
continues at the next normal interval even if its metadata sweep has more pages.
Foreground and managed Collector loops also pause after at most 16 consecutive
cycles, retaining every checkpoint. This finite catch-up bound handles multiple
Projects whose completed scans never coincide. A per-job completion flag alone
was rejected because the global OR would allow a permanent busy loop. Smaller
backlogs still drain immediately; failures and idle cycles pause earlier.

## Verification and remaining work

Real native SQLite and Node Collector tests cover unchanged scans, Canonical edits,
Raw-only changes, policy off/on, lost activation and Raw receipts, deleted source
and Project directories, legacy-cursor rejection, source attribution, slow requests,
payload reclamation and independent recovery/discovery cursor progress. Journal
tests cover format-4 binding-before-upgrade, old Raw plus new Canonical, and stale
owners. Both background loop Interfaces test two permanently out-of-phase source
jobs, interval pause and continuation.

Native source-to-production HTTP/PostgreSQL Collector acceptance, bounded archive
browsing, physical capacity/deadline defaults and supported-platform acceptance
remain required before registration or enablement. This increment publishes no
package and deploys no instance.
