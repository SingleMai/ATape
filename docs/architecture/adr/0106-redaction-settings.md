# ADR-0106: Global redaction settings

- Status: Accepted
- Date: 2026-10-09
- Extends [ADR-0105](0105-client-redaction-policy.md)
- Current guide: [Client redaction](../../cli/redaction.md)

## Context and alternatives

Global custom rules already pass through the shared submission Redaction Module.
Users need to inspect and edit them from Settings without understanding the file
format or risking a silently invalid policy. Provider capture and full-session
preview are independent workflows; neither is required to accept standard
Canonical, Raw and diagnostic masking.

Two Interface shapes were considered. A file-oriented Interface would expose
load/write and leave normalization, compilation, repair eligibility and conflict
handling in presentation. An application-owned inspect/validate/save Interface
hides those decisions behind one Module and leaves a narrow filesystem Store
Seam for the Node Adapter. Select the latter for greater Depth and Locality.
The existing Redaction engine supplies Leverage; Settings introduces no alternate
matcher, provider-specific policy or generic configuration framework.

## Decision

- Application Settings owns normalized snapshots, effective rule validation,
  repair eligibility, typed safe failures and the save workflow. Its Interface
  exposes inspect, validate and save with an expected local configuration
  revision. The revision is a concurrency token, not a capture policy identity.
- The Node Store Adapter owns selected-file and environment resolution, bounded
  regular UTF-8 reads, the existing local file lock, private atomic replacement
  and revision comparison immediately before writing. It shares file selection
  and literal discovery with Collector policy loading. The default missing file
  is an empty additive configuration; an explicitly selected missing file fails.
- Validation uses the existing compiler and an ephemeral identity. Inspect and
  validate create no files. Save writes only the selected redaction configuration,
  never Collector keys, checkpoints, journals or process controls. Secret literal
  values do not cross the Settings snapshot Interface; only their count does.
- Schema-valid rules with invalid expressions remain inspectable and repairable.
  Malformed JSON, unsupported schema, invalid effective environment values and
  exhausted limits return typed safe errors. Save does not overwrite an existing
  malformed document. Candidate rules must pass the same compiler used by jobs.
- Settings presentation owns list/add/edit/delete interaction, safe terminal
  display and review. It preserves rule strings during editing, retains a draft
  after validation or save failure, and requires explicit reload to discard it.
  A default-Cancel confirmation explains the global effect and recovery limits.
  Once confirmed, saving waits for its result; presentation cannot imply that an
  uninterruptible filesystem commit was cancelled by returning to an old draft.
- A stale revision fails without replacing the observed file. Cooperating
  Settings saves share a lock; observable edits made outside Settings are also
  checked before replacement. This is not an exclusion guarantee for arbitrary
  non-cooperating editors writing after that check.
- Built-ins remain always enabled; custom rules remain global and additive.
  Jobs retain their existing immutable snapshots. A saved file applies to later
  jobs that select it; already accepted history and uncertain old delivery retain
  ADR-0105's semantics. Console and background-process inherited environments
  can differ, so the Interface displays the selected path and literal count and
  does not claim to change a running process's environment.

## Scope and validation

This increment adds interactive rule management and fills gaps in standard
content-contract assertions. It introduces no full-session preview, provider
capture change, project override, default-disable option, historical re-redaction,
publication or deployment.

Validate through the public application Interface with real temporary filesystem
Adapters, presenter interaction and the installed terminal executable. Cover
missing/default and explicit paths, invalid-rule repair, malformed-file
preservation, candidate rejection, stale saves, private replacement, escaped rule
fidelity, cancel behavior and unchanged Collector state. Existing submission and
recovery contracts remain the acceptance surface for Canonical, Raw and diagnostics.
