# ADR-0027: Bounded shared tool details in the production pipeline

- Status: Accepted implementation scope
- Date: 2026-09-07

Implement the next vertical slice of ADR-0025, without reopening its prototype
program. ACP tool updates admit bounded JSON `rawInput` and `rawOutput`. The Host
validates and redacts them before encoding. Calls and results stay separate Events;
their toolCallId is scoped by the containing Session and Thread, never global.

The new `atape.acp-centered.v2` profile adds `toolUpdateJson`: a serialized admitted
ACP tool update. JSON is deliberately carried as a UTF-8 string inside the outer
wire envelope and persisted unchanged in Canonical current/version rows. This
preserves null versus absence and avoids a second floating-point serialization
when Go computes the outer canonical digest. JSON values are limited to 64 KiB,
depth 32 and 10,000 nodes; the enclosing update is limited to 140,000 bytes. Invalid
or unbounded Adapter values fail Host validation; the Claude Adapter can omit
unsupported values explicitly with partial fidelity and retain them in Raw.

The alternative was adding loosely typed JSON directly to the existing v1 profile;
it would silently change v1 and introduce numeric digest ambiguity. A separate
tool store would split ownership and duplicate the Canonical workflow. One encoded
field keeps the Interface narrow and all provider interpretation in the Adapter.

The server accepts v1 without tool details and v2 with validated details. It derives
the existing title/status display and Search summary from admitted tools, so the
summary cannot conflict with tool facts. Detailed arguments/results are deliberately
not added to Search in this slice. Conversation reads expose decoded tool data;
the common view renders escaped, collapsible plain text/JSON without executing or
fetching content. No provider-specific endpoint or page is introduced.

Deploy the server/migration before the updated CLI. Unchanged legacy tool Events
are reprojected by Claude with a higher projection revision, preserving source
revision, Session metadata and IDs. Snapshot Raw references and existing v1
publication/recovery restrictions remain as documented in ADR-0026; this does not
claim the remaining generation-token, full ACP content or atomic-publication work.
