# ADR-0125: Recorded file activity and conditional evidence

- Status: Accepted
- Date: 2026-10-12

## Context and Interface alternatives

Session Analytics needs recorded read, edit and search paths without acquiring
Provider knowledge or tool payloads. A tool title is presentation, a search path
is a scope rather than a result, and one native command can record more than one
operation. The current snapshot Seam deliberately excludes tool input/output.

| Interface | Depth, Leverage and Locality | Decision |
| --- | --- | --- |
| A bounded typed file-activity extension in the existing ACP tool update | Adapters normalize explicit native facts once. Upload preparation owns copied-fact privacy, and the existing Analytics Module hides folding, grouping, filtering and conditional evidence. No additional persistence or transport Seam is needed. | Selected. |
| ACP locations combined with the call's kind | Location alone does not identify an operation, and a single call can record both read and search. Callers would need another rule to recover the lost semantics. | Rejected for this report. |
| Parse titles, shell commands or tool payloads in Server/Web | Spreads Provider knowledge, increases the snapshot input surface and invents facts for ambiguous commands. | Rejected. |

## Contract and compatibility

Complete the **unpublished** Canonical/publication v5 and Analytics v4 contracts
introduced in [ADR-0124](0124-stable-native-tool-identity.md). Published 0.5.10
supports Canonical v4 and Analytics v3; those representations remain unchanged.
No compatibility is claimed between intermediate development-checkout v5/v4
artifacts. Their coordinated first release must include this complete contract.
Adding another numbered capture/profile chain before that release would add
recovery and negotiation surface without supporting an additional published
client. Existing affirmative v5 discovery and old-Host refusal still apply.

The closed `_meta` envelope retains its required `atape.dev/tool-identity` key
and adds optional `atape.dev/file-activity`. The new value is null or an array of
closed `{operation: "read" | "edit" | "search", path: string}` entries. Absence
preserves an earlier fact for the same Thread/call ID. Null (explicit unknown, including invalid recognized input or redaction) or an empty array clears it. No nonempty fact can be derived when its original input was not
admitted. V4 and earlier Canonical profiles reject the new namespace.

Paths retain their exact source spelling: nonempty, well-formed Unicode, no
C0/C1 controls and at most 2,048 UTF-8 bytes. Do not trim, resolve a relative path,
collapse `..`, fold case or claim filesystem identity. Bound an array to 64
entries and 4,096 UTF-8 bytes of decoded `JSON.stringify` representation. An
Adapter omits an invalid or oversized fact rather than truncate a path or return
a partial collection as complete. Existing Event, metadata and response budgets
remain in force. Available source history replays with stable Event IDs and
higher projection revisions; old pending publications retain their original
projection and bytes. Cursor recovery proceeds forward with a compatible reader.

## Privacy and aggregation

The Adapter retains the bounded original field, including native path-map keys,
whenever it copies a path. Upload preparation applies existing detectors and
field rules to both the original and the typed fact. Any changed file-activity
fact or hidden copied source clears the complete call's path fact to null;
replacement strings cannot merge private paths into one row. When a path is hidden, the display title is cleared as well: it can contain escaped, abbreviated or basename-only copies that the shared Module must not reconstruct. Tool identity and file activity clear
independently, so masking an unrelated credential or a public tool's path does
not erase the other usable fact. Frozen accepted bytes are never rewritten.

Analytics v4 requires `fileActivity`, with Session-wide distinct-call coverage,
distinct calls per operation, exact recorded paths and distinct-call counts per
path/operation. Repeated updates and duplicate entries do not inflate counts.
One call can contribute to several path or operation columns. Calls with no
nonempty usable path fact count as `callsWithoutActivity`, including old,
unsupported, invalid and redacted records. This is coverage, not proof that no
files were accessed. Failed, pending and unknown calls remain recorded activity;
an edit invocation does not prove a successful filesystem change.

An opaque `file:<sha256>` key identifies the exact recorded path. `metric=files`
accepts optional `file` and `operation` filters, combined with AND and optional
Thread selection. A folded call yields at most one evidence item at its final
structured update, retaining the display title. All filters bind pagination,
source snapshot, Session and Analytics version. Conditional Reader opening,
stale-snapshot rejection and current authorization reuse the existing Interface.
The report bounds distinct paths to 2,000 and fails explicitly on capacity.

The standard v4/v3 Accept header remains below the CORS safelist value limit.
Older Analytics v1-v3 reports render file activity as unavailable. Web only
renders results and emits selection intents; it owns no path classification or
counting rule. Back retains the selected file/operation/page, while a full refresh
clears all filters and source tokens together.

## Scope and verification

The first increment extracts closed native fields in Claude and Codex. Search
paths describe recorded scopes, not matching files. Shell text, patch bodies,
MCP payloads, unavailable history, line counts and inferred successful changes
are outside this increment. Provider support and remaining limits belong to
[Session Analytics](../../session-analytics.md) and the Adapter guides.

Tests exercise Adapter projection/replay, upload preparation, ingestion and the
Analytics `Open` Interface, plus HTTP/PostgreSQL and Web navigation. They cover
copied path privacy, exact path spelling, Unicode/size bounds, absent/null/empty
updates, deduplication, combined filters, pagination binding, replacement,
authorization and conditional Reader evidence. Publication and deployment
require separate authorization.
