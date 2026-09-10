# ADR-0056: Team and personal Raw capture policy

- Status: Accepted
- Date: 2026-09-09
- Amends ADR-0007, ADR-0009 and ADR-0022
- [ADR-0059](0059-opencode-publication-and-recovery.md) clarifies the planned OpenCode mutable-source backfill/reference boundary; policy precedence and existing Adapter behavior remain unchanged.

## Decision

Raw archival is explicitly configurable. Teams select `force`, `personal` or
`close`; each User has one Instance-wide `enable` / `disable` preference.
`force` enables upload regardless of preference, `close` disables it, and
`personal` delegates to the User. Existing and new Teams default to `personal`;
existing and new Users default to `disable`, as explicitly selected by the user.
Only Team owners may change Team policy; Users change only their own preference.
Changing policy neither deletes nor hides already captured Raw.

The Team Module owns settings persistence and authenticated settings operations.
The Raw Archive Module owns the pure effective-policy rule. Its PostgreSQL
Adapter checks current policy both before writing bytes and in the manifest
transaction, alongside existing authorization. The latter locks policy rows so
a completed policy update cannot be bypassed by a later append commit. An
in-flight byte write may leave an unreferenced blob, as with membership revocation.

The Collector obtains the authoritative effective policy at the remote Seam for
each job and passes it through the Adapter Interface. Disabled Raw must not be
read for archival, redacted, uploaded, counted as backlog, or recorded as
acknowledged. Canonical processing and genuine Raw receipts remain intact. A
policy denial during upload is explicit and causes collection to continue with
Raw disabled; a subsequent cycle refreshes policy. Policy lookup failures remain
retryable failures, never an invented allow decision. An old server cannot
silently grant a policy it does not implement.

Explicit development fixtures without a Team database report a static `force`
policy; production requires the persisted Team Module.

Official Codex and Claude Adapters implement the policy capability. Turning Raw
back on resumes from genuine receipts, including data whose Canonical projection
completed while Raw was disabled, provided the original source still exists.
Unsupported older Adapters report an upgrade requirement rather than inventing
receipts or looping over disabled Raw work. Event source references remain
stable, so a policy toggle does not rewrite Canonical identities or content.

Settings are presented in Team and account settings. Presentation translates
input and displays the authoritative effective result; it owns neither policy
precedence nor retry/persistence behavior.

## Alternatives

A local-only switch has a smaller Interface but cannot enforce Team `force` or
`close`, and diverges across devices. A server-only rejection enforces policy but
wastes local work/network and repeatedly fails collection. The selected design
puts enforcement at the storage boundary and avoids work in the Collector and
Adapters. This preserves Depth and Locality in the existing Modules and gives
callers Leverage through a small policy Interface rather than new orchestration.

## Scope

This increment implements configuration and automatic archival under policy.
On-demand remote upload requests, retention/deletion and compression remain
separate increments. Deployment and migration require their own authorization.
