# ADR-0105: Shared client redaction and policy-bound capture

- Status: Accepted
- Date: 2026-10-09
- Amends the client masking boundary of ADR-0009, ADR-0059 and ADR-0066, and the
  local inspection command scope of ADR-0081
- Current guide: [Client redaction](../../cli/redaction.md)

## Context and alternatives

The shared `SecretRedactor` only accepts strings. Canonical field selection,
Raw JSON traversal and diagnostics consequently implement different masking
boundaries. Users cannot persist custom rules or test their effective policy.
Confab provides useful reference behavior: a built-in credential catalog, value
and field-name regular expressions, capture-group masking and local JSONL tests.

Two Interface shapes were considered. A text/JSON utility hides matching but
leaves field selection, failure semantics and reporting in each caller. A content
boundary Module additionally owns Canonical, Raw and diagnostic masking. The latter
has greater Depth and Locality: callers retain their workflow while all content
exits share the same policy and failure guarantees. Select it inside
`packages/application`; no remote service, separate package or per-detector Seam
is needed. Provider knowledge remains in each Adapter.

## Decision

- Redaction owns validated, immutable effective policies, the credential catalog,
  exact literals, value/field-name patterns, capture-group masking, bounded JSON
  and nested JSON TEXT handling, content-field selection and safe match reports.
  Configured expressions use an engine with bounded matching complexity, not
  arbitrary synchronous JavaScript backtracking. Invalid or excessive rules are
  typed failures rather than silently disabled protection.
- A scoped import-rule exception admits the pinned pure JavaScript `re2js`
  dependency only inside the private redaction Implementation. Core Effect has no
  non-backtracking expression engine; implementing one here would duplicate a
  substantial security-sensitive algorithm. The architecture checker continues
  to reject this dependency elsewhere in application. It adds no platform I/O,
  remote ownership or replaceable detector Seam.
- Canonical identity and correlation fields remain stable. Raw source fields are
  content and do not receive an exemption merely because they are named `id`.
  Ambiguous duplicate decoded JSON keys, masked-key collisions and exhausted
  budgets cannot return unmasked content. Canonical preparation fails, Raw
  preparation records an explicit gap and diagnostics use a safe placeholder.
- The Node Adapter reads global configuration and environment values. The Host
  pins an immutable effective policy for each job. Filesystem/configuration,
  cryptographic initialization and local test I/O use Effect; deterministic
  matching and traversal remain ordinary calculations.
- Effective identity includes engine/catalog semantics, normalized configuration
  and resolved literals. Persist and transmit only an opaque keyed policy identity,
  never source literals or an unkeyed digest of guessable secrets. Comparison,
  preparation, immutable capture intent and Raw reuse share that identity.
- The Host continues to own source lifetime, membership, versions, Raw packing,
  hashes, journal persistence, receipt reconciliation and upload. Changing policy
  never mutates sealed bytes or reuses a chunk identity with different content.
- Policy changes fence new content delivery under an earlier policy. Reconcile
  genuine remote results before rejecting unactivated Canonical candidates or
  cancelling unacknowledged Raw obligations and freshly preparing available
  sources. Unknown results remain explicit and paused. Legacy paged delivery must
  also bind policy to its checkpoint/Raw mapping; the publication cancellation
  protocol is not a substitute for legacy reconciliation. Unsupported safe
  transitions fail closed, preserve progress and explain the recovery limit.
- Already accepted history is not retroactively deleted or re-redacted. Retained
  source-missing history remains historical evidence. A changed policy prevents
  borrowing an old packed Raw object for a newly prepared record.
- Managed activation must commit its update journal before a newly ready Collector
  starts any job. Previously, clearing maintenance before deleting the pending
  journal allowed a crash to select the preceding runtime after new policy state
  had been written. A state-contract bump would reject the existing updater's
  compatibility admission and require a separate upgrade bridge. Instead, the new
  Collector writes readiness first, then waits for both maintenance and pending
  activation to finish and syncs the existing update directory before admission.
  This makes journal deletion durable even when the activating worker is an older
  binary. Existing updaters can complete or recover before the new
  policy writer runs. This fixes the automatic rollback window without promising
  that arbitrary manually selected old binaries enforce new privacy rules.
- A local file test uses the same compiled policy and JSON/text implementation as
  collection, emits only masked content and bounded rule statistics, and performs
  no authentication, upload, cursor advancement or publication reservation. It
  proves sample transformation, not complete session coverage or final wire bytes.

## Scope and validation

The first usable increment includes the independent Module, persistent global
configuration, Confab-style custom rules and built-in format coverage, Canonical/
Raw/diagnostic integration, local file testing and policy-bound recovery admission.
Default protection stays enabled and custom rules add to it. Disabling all
protection, project overrides, arbitrary replacement scripts, binary/OCR/audio
inspection, full session preview and historical deletion are separate product
contracts. Existing environment literal configuration remains compatible with
explicit validation rather than silent truncation or omission.

Verify through policy, Host and installed CLI Interfaces: credential format and
false-positive matrices, JSON escapes/duplicates/collisions, exact-value bounds,
rule failures and resource limits, identity preservation, local-only file output,
policy changes across restart and uncertain delivery, and old checkpoint/journal
admission. Run affected package checks, packaging and authenticated Collector
contracts. Integration, publication and deployment are distinct evidence.

## Reference

- Confab source: `ConfabulousDev/confab`, commit
  `8082a7ab8d3195ae8fb93545508be49bc4c8f5b7`, especially `REDACTION.md`,
  `pkg/config/upload.go`, `pkg/redactor` and `cmd/redaction.go`.
- Confab is MIT licensed, copyright 2025 Confab Contributors. Any adapted
  substantial source or pattern catalog retains the required notice in release
  artifacts. Capability alignment does not copy its provider or transport design.
