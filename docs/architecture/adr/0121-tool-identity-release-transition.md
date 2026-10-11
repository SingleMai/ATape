# ADR-0121: Tool identity release transition and frozen source recovery

- Status: Accepted
- Date: 2026-10-11

## Context

[ADR-0120](0120-normalized-tool-identity.md) adds Canonical/publication v4 and
keeps negotiated capability facts outside older closed Intent fields. Release
review found a second recovery boundary: the genuine 0.5.8 SourceCollector
decodes frozen source metadata before opaque delivery, and its existing
`canonicalProfileVersion` enum admits only v2/v3. Writing v4 to that field makes
the resulting local state unreadable despite an unchanged journal format.

The published 0.5.8 updater also decodes candidate Adapter manifests in its own
parent process. An active official Claude candidate declaring target v4 is
rejected before the new CLI's preflight can run. Updating new code cannot repair
that immutable parent. Rejection preserves the old runtime and capture intent;
it is not evidence of a successful automatic upgrade.

## Decision

Keep the SourceCollector's small Interface and actual journal format unchanged.
For newly frozen v4 source metadata, persist the older closed field as v3 and
store a separate bounded `canonicalProfileV4` fact. The new decoder validates
the paired representation and normalizes the operation's effective profile to
v4. The old decoder can ignore the independent fact and recover frozen units
without parsing or rewriting their v4 content. Actual source headers, target
parts, comparison profiles and authorization continue to bind v4; this metadata
envelope does not downgrade their semantics. Continue reading the earlier
unpublished direct-v4 representation in new code, without rewriting frozen
records during receipt recovery.

| Interface design | Depth, Leverage and Locality | Decision |
| --- | --- | --- |
| Compatible recovery metadata envelope with one decoder normalization | The source metadata Module hides wire compatibility; callers still receive the effective Canonical profile. Existing opaque delivery provides Leverage, while profile admission and recovery stay local. | Selected, contingent on genuine old SourceCollector recovery evidence. |
| New stateContract, reader floor and separately compiled migration route | A real format boundary would justify this workflow, but it would add migration/catalog coordination for an otherwise unchanged SQLite format. It would also require a genuine bridge for immutable old clients. | Defer; do not relabel compatibility merely to pass publication. |

The first release containing the v4 Claude manifest requires a stopped external
CLI refresh for active 0.5.8 official-Claude installations, followed by complete
bundle selection through the new CLI. Verify the supported path with genuine
published/historical 0.5.8 code or bytes. The old automatic/UI rejection must
remain before pause or state mutation and be disclosed in release notes. Other
supported installations may continue through their existing managed path; do
not claim universal unattended delivery or substitute a current version-labelled
test package for historical evidence.

After an external refresh, a current CLI and command entry can still have older
eligible official integrations. The existing ToolUpdates Module offers the
complete matching bundle in this state, and presentation names the integration
update explicitly. It uses the existing `upgradeCLI` Interface; pinned/local,
custom and ahead packages do not create this action. No second updater or new
Seam is introduced to expose a function unavailable to ordinary users.

This release does not fabricate a placeholder bridge version. A future seamless
transition needs its own implemented and verified routing/bridge behavior.
Existing reader floors and forward recovery continue enforcing their actual
authority independently of the metadata decoder's ability to read older state.

Deploy a v4-capable Server before publishing the new capture packages. Existing
Canonicals and older profiles remain readable. Once v4 facts are accepted,
rolling back to a pre-v4 Server image cannot promise Reader compatibility.
Preserve the actual current image and a fresh PostgreSQL/Raw paired recovery
point before rollout; a restore to that point withdraws subsequent writes.
There is no new database migration in this increment.

## Validation and remaining work

Exercise fresh v4 preparation, strict effective-profile decoding, unchanged
comparison/Raw identity, and source-free pending recovery through a genuine old
SourceCollector Interface. Verify old active-Claude upgrade rejection and the
stopped external-refresh path separately. Version-bound package/CI/security and
operational evidence belongs in release records; manual staging remains pending
unless actually completed. Current behavior belongs in
[Session Analytics](../../session-analytics.md), [CLI upgrades](../../cli/setup-and-adapters.md)
and [release guidance](../../releasing.md).
