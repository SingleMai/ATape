# ADR-0124: Stable native tool identity

- Status: Accepted
- Date: 2026-10-12

## Context

Tool titles are presentation facts. A Codex command title can contain an entire
command, while Claude titles often contain native tool names. Grouping titles
therefore does not establish a stable tool identity. The existing MCP and Skill
extension already separates an explicit identity from the display title.

Session Analytics must preserve explicit outcomes, unknown facts, one current
authorized snapshot and conditional original-Event links. Raw and tool payloads
are not analytics inputs. Provider knowledge remains inside client Adapters.

## Interface alternatives

| Design | Depth, Leverage and Locality | Decision |
| --- | --- | --- |
| Extend the closed identity union with a native tool identity, under an explicitly admitted profile | One tool update Interface carries identity, display and outcome. Existing identity folding, redaction, publication and snapshot binding provide Leverage. Provider extraction stays local to Adapters and aggregation stays local to Session Analytics. | Selected. |
| Add a separate top-level tool-name field and independent identity report | Callers must reconcile two identity authorities, privacy rules and update semantics. The extra surface decreases Depth without introducing a real external Seam. | Rejected. |
| Classify titles or payloads in Server/Web | Creates Provider-specific behavior outside the Adapter and invents facts when command text is ambiguous. Moving payloads into analytics increases its input and privacy surface. | Rejected. |

## Decision

Canonical v5 and publication target v5 admit the existing closed ACP `_meta`
namespace with an additional identity: `{"type":"tool","name":"native-name"}`.
Names retain the existing trimmed, nonempty, well-formed Unicode and 500 UTF-8
byte bound. V4 still admits only MCP/Skill identities; older contracts continue
rejecting the extension. Host and Server support must be affirmative before
source reading or progress writes. There is no silent downgrade or SQL migration.
Canonical capability discovery retains v2-v4 by default so released closed
decoders remain usable. The v5 Host explicitly opts in with
`ATape-Accept-Canonical-Profile: atape.acp-centered.v5`; publication discovery
likewise requires an explicit v5 target opt-in. Authoritative negative responses
cannot trigger fallback. A missing Canonical capability route may use affirmative
publication-target-v5 support as the existing compatibility proof.

Adapters extract explicit native names or map a closed native item type to its
stable name. They retain the original display title. They do not classify shell
commands into hypothetical tools. Missing or invalid identity remains absent.
Updates with absent identity preserve its preceding value; an explicit null
clears it. Ordinary native identity does not become a recorded MCP/Skill call.

Upload preparation applies the existing identity and copied-fact redaction rules.
Original admitted content is retained when an identity copies it. Masked identity
or a masked copied source becomes explicit null; secret values cannot be combined
under a replacement identity. Frozen accepted bytes are never rewritten.

Analytics v4 retains the deep Module's `Open` Interface, snapshot Seam and evidence
navigation. The standard Accept vendor range opts in; v1-v3 retain their existing
label aggregation and filter semantics, and the default remains v2. V4 groups
calls by explicit identity and recorded kind; unidentified calls group by kind
and remain disclosed as unidentified. It returns a stable opaque group key,
the nullable identity, counts and explicit outcomes. The `tool` evidence filter
selects that returned group key in v4. Source token, version, group filter, Thread
and range bind pagination. Last folded updates remain the original-Event anchors
and keep display titles in evidence. Identified/unidentified call counts describe
coverage rather than absence of tool usage.

The first capture increment covers Claude and Codex. Available source history
can replay once with stable Event identities and higher projection revisions;
Raw acknowledgements and retained progress remain authoritative. Missing source
history stays unclassified. New projection cursors are not rollback-compatible
with older Adapters; recovery proceeds forward with a compatible runtime.

File activity, costs, response timing, new non-tool Skill signals and a derived
analytics cache are outside this increment. Current support, compatibility and
remaining work belong to [Session Analytics](../../session-analytics.md).

## Verification

Tests use the Adapter, preparation, admission/publication and `Open` Interfaces.
They cover old-profile refusal, genuine source projection/replay, redaction,
absent/null updates, distinct titles sharing one identity, unidentified facts,
explicit outcomes, evidence filters, stale snapshots, authorization and older
Server fallback. Publication and deployment require their separate authorization.

This extends [ADR-0120](0120-normalized-tool-identity.md) and
[ADR-0123](0123-recorded-activity-ranges.md).
