# ADR-0048: Release requests authorize manual acceptance waivers

Status: Accepted (2026-09-09)

## Decision

The user explicitly directed that future publication requests authorize the manual
staging waiver without repeating a version confirmation. An explicit request to
publish is therefore sufficient authorization for the requested release's manual
staging waiver. Coding and merge requests alone remain insufficient.

The release gate accepts a version-specific evidence path without a hardcoded version
allowlist. Evidence still identifies the exact candidate commit, authorization date,
request, manual-only scope, and every unverified check. Only that release's evidence
file may change after the candidate. Historical evidence keeps its original date
validation. Staging remains pending and release notes disclose that it was waived,
never passed. Automated tests and security scans remain mandatory.

This reduces repeated approval prompts while retaining a reviewable release record.
It grants no Server deployment or database migration authority. Existing historical
ADRs and evidence remain unchanged as records of their original decisions.
