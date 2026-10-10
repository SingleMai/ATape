# ADR-0109: Observed Collector redaction configuration

- Status: Accepted
- Date: 2026-10-10
- Extends [ADR-0011](0011-managed-local-collector-and-session-presence.md),
  [ADR-0105](0105-client-redaction-policy.md) and
  [ADR-0106](0106-redaction-settings.md)
- Current guide: [Client redaction](../../cli/redaction.md)

## Context and alternatives

Settings saves a configuration in the console's environment. A detached Collector
can select another file or inherit different literal values. Jobs pin their policy
independently, so a save neither changes an active job nor proves that a later job
has loaded that version.

Two Interface shapes were considered. A separate privacy status Module could own
another file and inspect operation, but would duplicate process ownership,
concurrent job lifecycle and stale-state handling. Extending the existing Collector
status Module keeps those decisions together and adds Depth to its small Interface.
Select that shape for Locality and Leverage. The existing process and filesystem
Adapters are real Seams; no provider-specific observer or remote privacy service is
needed.

## Decision

- Policy loading returns an immutable redactor and a content-free configuration
  descriptor from the same read used to compile it. The descriptor contains the
  selected absolute file, selection origin, file revision, existence and bounded
  custom-rule/literal counts. It contains no expressions, literals, keys or policy
  identity. A file revision proves file selection, not equality of environments.
- Each job records loading, loaded and finished events through the existing local
  run-status Interface. Every attempt has a distinct identity. Loaded records the
  exact pinned descriptor before the Adapter opens. Completion, collection failure,
  interruption and policy-load failure remain distinct; later collection errors
  never relabel successful policy loading as a load failure.
- The Node status Adapter records these events only when explicitly bound to the
  admitted daemon token. Foreground collection does not claim to describe the
  managed background process. Writes serialize and merge with cycle summaries;
  stale generations and late loaded/finished events for a previous attempt cannot
  overwrite the current attempt. The application awaits each scope's loading
  events in order; a distinct loading identity announces its next attempt.
  Wall-clock timestamps are informational and never order these transitions.
  Observation-write failure emits a fixed safe warning and does not change real
  collection behavior. Retained phase and timestamps are the last successful
  observation; they are not a liveness heartbeat or delivery authority.
- Runtime observations use an opaque generation derived from verified process
  ownership without exposing its authentication token. A pure observe operation
  does not repair process records, start or stop collection, access redaction keys,
  or create files. Inspection observes the process before and after reading status;
  disagreement or read failure produces unknown with no stale jobs.
- Only status from the observed live generation is current. A stopped Collector's
  retained records are explicitly historical. Missing legacy metadata is unknown,
  not evidence that protection is disabled. Concurrent jobs may show different
  snapshots. A current snapshot matching the saved file revision means that this
  job loaded that version; a different revision means later jobs re-read the selected file.
- Redaction metadata is optional in the existing version-1 run-status schema. It
  does not change checkpoints, immutable publication data or the CLI state contract.
  Older writers may omit the new fields, which new readers treat as unknown.
- Local file paths, revisions and generations never enter device reports,
  Canonical, Raw or Search. Presentation renders the application projection and
  does not infer freshness, path equality or process ownership itself.

## Validation and limits

Verify lifecycle events and snapshot pinning through the collection Interface,
including concurrent jobs, safe load failure, later failure and interruption.
Verify inspection across generation changes, stopped and legacy status, read
errors and file-version comparisons. Real temporary filesystem Adapter tests cover
serialized writes, generation fencing, version-1 compatibility and observation
without writes. Verify the installed Settings flow and the remote-report privacy
boundary. Provider-specific sessions and complete-session previews add no required
acceptance surface to this increment.

This is configuration observability. It does not prove upload completion, alter
active policies, change daemon environment, re-redact accepted history or introduce
publication or deployment.
