# ADR-0120: Normalized tool identity for Session Analytics

- Status: Accepted
- Date: 2026-10-11

## Context

Session Analytics can count structured calls and explicit outcomes, but display
labels do not establish an MCP server or Skill identity. Claude retains an MCP
tool namespace and explicit `Skill` input; the current Canonical projection does
not preserve those as typed facts. Reading tool input, transcript text or Raw in
the Server would move Provider knowledge across its Adapter boundary.

The admitted tool profile is closed. Existing Servers reject unknown fields,
and existing Hosts can strip fields unknown to their ACP Schema. Adding an
optional field without negotiation would either break uploads or silently lose
the new facts. Installed Adapters, Host runtimes and Servers upgrade separately.

## Decision

Provider Adapters own extraction of bounded, explicit tool identities. Carry
them in the official ACP extension location, `_meta`, using the reserved key
`atape.dev/tool-identity`. Its value is one of:

```json
{"type":"mcp","server":"server-name","name":"tool-name"}
{"type":"skill","name":"skill-name"}
null
```

Each name and server is a nonempty, trimmed, well-formed Unicode string of at
most 500 UTF-8 bytes. Unpaired surrogate escapes are rejected rather than
normalized into the replacement character.
The identity and envelope are closed objects. The envelope requires exactly
this key; a null value explicitly clears identity, while an absent `_meta`
preserves the preceding fact for the same Thread and call ID. `_meta: null` and
empty envelopes are invalid. Arbitrary Provider metadata is not admitted.

| Interface design | Depth, Leverage and Locality | Decision |
| --- | --- | --- |
| Typed identity within ACP `_meta`, admitted by an explicit Canonical profile | The existing tool update Interface carries identity and state together. Adapter extraction stays local; Session Analytics hides folding, aggregation and evidence selection. Existing publication hashing, snapshots and tool call IDs provide Leverage without another persistence Seam. | Selected. Canonical v4 and publication target v4 make compatibility explicit. |
| Independent identity capability that conditionally strips metadata from otherwise identical v2/v3 payloads | Adds a second projection dimension to preparation, comparison, Raw reuse, journal recovery and batch retry. The public Interface looks smaller, but callers must understand hidden changes in semantic identity. | Rejected. Silent field loss is not a usable compatibility strategy. |

Introduce `atape.acp-centered.v4` and `atape.publication-target.v4`. V4 retains
v3's explicit unknown source-clock semantics and admits the normalized identity
extension. Earlier profiles continue rejecting it. Publication capabilities
advertise v4 only after explicit opt-in. The Host freezes the negotiated fact
outside the older closed durable capabilities representation, as for v3, and
binds preparation, comparison and every target part to the selected profile.
The Adapter declares a static v4 Server minimum and a v4 source header; old Host
decoders reject the unsupported declaration/header instead of dropping metadata.
Missing Server support fails explicitly before content delivery. There is no
silent downgrade and no database migration.

Upload preparation applies the same redaction detectors and field/path rules to
identity strings as to other Canonical content. If a rule changes any identity
key or value, removes its shape, or exceeds the bound, preparation emits an
explicit null identity. This also prevents distinct secret identities from
being combined under the same replacement label. If a tool input/output field
rule hides the original string copied into identity, preparation also clears
the copied fact; moving a value into a differently named field must not bypass
an existing privacy rule. Unrelated masked arguments do not hide a public
identity. Preparation must not preserve
or reconstruct the original value. Frozen,
already accepted bytes are not rewritten by an upgrade.

The Adapter must retain an admitted original content field when it copies that
field into identity, so field-redaction policy can still inspect the source.
Claude omits Skill identity together with an unadmitted input instead of
creating a new copy outside that privacy boundary.

Session Analytics keeps its one `Open` Interface and narrow authorized Canonical
snapshot Seam. It retains the normalized extension while removing tool input,
output and message bodies. Analytics version 2 adds MCP and Skill aggregates,
explicit outcomes and evidence filters. Every filter joins the cursor binding;
authorization, capacity limits and conditional original-Event navigation remain
the same. Counts cover the complete Session; filters select only evidence.

The first supported source is Claude's explicit MCP tool namespace and `Skill`
tool invocation. A completed Skill tool means the recorded tool completed; it
does not prove that the requested task succeeded. Ordinary tools, old records
and unsupported source signals are disclosed as calls without normalized
identity. Zero identified calls does not establish that no MCP or Skill was
used. Codex Skill message markers and Claude command expansion need a distinct
non-tool fact model and are deferred rather than fabricated as tool calls.

The Web accepts existing analytics version 1 and shows its missing report as
unavailable. Version 2 requires its complete capability report. Presentation
renders those facts and emits filters; it does not classify Providers or infer
outcomes. This increases the Module's Leverage without adding a new Gateway,
analysis queue or persisted result.

## Consequences and validation

Tests exercise the same Adapter, preparation, ingestion, publication and
analytics Interfaces used by callers. Required coverage includes profile and
capability negotiation, old Host/Server refusal, frozen recovery, source replay,
identity redaction, explicit null versus absent updates, same-ID deduplication,
unknown outcomes, snapshot changes, access revocation and original-Event links.
Current support and remaining work live in [Session Analytics](../../session-analytics.md).

This extends [ADR-0118](0118-session-analytics-current-snapshot.md), the tool
details contract in [ADR-0030](0030-bounded-tool-details-implementation.md), and
profile negotiation in [ADR-0114](0114-explicit-unknown-conversation-time.md).

[ADR-0121](0121-tool-identity-release-transition.md) amends the release/recovery
boundary with a compatible source metadata envelope and an explicit stopped
transition for immutable 0.5.8 active-Claude upgrade parents.

[ADR-0124](0124-stable-native-tool-identity.md) extends this identity union with
explicit ordinary native tool names under Canonical/publication v5 and adds
opt-in stable tool grouping in Analytics v4. V4 admission and earlier analytics
representations retain their recorded scope.
