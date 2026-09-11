# ADR-0079: Collector and CLI Module boundaries

Status: Accepted

## Context

Three production Adapters exercise two capture protocols. The Collector scheduler
imports the source workflow, which imports contracts back from the scheduler; the
legacy workflow also owns preparation shared by source publication. CLI commands
and the interactive experience independently resolve Project setup decisions.
Node composition files contain several unrelated implementations, and interactive
screens permit invalid field combinations.

## Alternatives

1. Introduce a configurable pipeline registry, a new collection job Effect Service,
   and a general CLI workflow engine. This hides wiring, but adds Seams and ordering
   conventions without a varying production implementation for those abstractions.
2. Keep the existing caller Interface and real external Seams. Separate shared
   contracts, protocol implementations, and scheduling; declare source collection
   as an explicit Effect requirement. Extend Project Setup with a typed decision
   Interface used by both presentations. Keep Node implementation files cohesive
   and assemble them at the existing Composition Root.

We choose alternative 2. It improves Depth and Locality without another registry
or application runtime. An internal function can own one job's scoped runtime and
protocol dispatch without becoming a replaceable Service.

## Decision

- Collector contracts have no dependency on scheduling or either protocol workflow.
  Scheduling owns concurrency, continuation and result aggregation. A scoped job
  opens the runtime and dispatches to legacy or source collection. Legacy retries,
  Raw progress and checkpoint rules stay together. Shared validation and redaction
  are in a preparation Module; Canonical and Raw publication remain independent.
- SourceCaptureCollector is a required Effect dependency, assembled with validated
  admission at the Node Composition Root. Missing admission is a composition error,
  not an optional dependency discovered halfway through a collection job.
- Project Setup resolves an intent into needs-team, needs-creation-confirmation,
  ready or invalid states. Resolution is pure and performs no I/O. Applying a ready
  selection still revalidates local and remote state through the existing Effect
  Interface. CLI flags and TUI prompts express intent; they do not choose matching
  or creation policy. Existing directory reuse and explicit creation semantics are
  preserved. This Interface adds Leverage for both presentations.
- Global tool management and Project account checks live in coherent application
  Modules. CLI experience remains the binding for onboarding and console use cases.
- Node configuration storage, package installation, project location, Adapter Host,
  Collector state and transport implement the existing Seams in their own files.
  Composition files assemble Layers. There is no new platform package or per-file
  Service merely to support this organization.
- Interactive screens use a discriminated union. Recovery classification has one
  typed mapping; presentation owns rendering, navigation and cancellation.

## Verification and limits

Verify collection through runCollectionCycle/runCollector and the real Node Host,
including both protocols, persisted progress, account binding and cancellation.
Verify setup decision outcomes and both presentation paths, preserving explicit
creation consent and revalidation after remote or local changes. Existing Node and
packaged CLI tests remain caller-facing checks of the relocated implementations.

This increment does not migrate legacy capture history, combine Canonical and Raw,
or change package publication and deployment. Installer slot reclamation still
requires a separately designed runtime lease policy (ADR-0078).
