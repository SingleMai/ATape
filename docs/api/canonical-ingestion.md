# Canonical ingestion API

`POST /api/v1/ingestion/canonical/batches` synchronously validates and applies
one bounded Canonical observation batch. A successful response means the batch
is visible to Canonical readers; it does not mean Raw has been stored or Search
has been projected.

```http
POST /api/v1/ingestion/canonical/batches
Authorization: Bearer atc_v1_...
Content-Type: application/json
```

The request is authenticated with a CLI Credential. Its server-established
Principal supplies the capture User. The payload cannot declare a User, Team,
Membership, or Project ownership. `projectId` is only the target Resource
locator; the server resolves its Team and current Membership before accepting
the batch.

The `atape.canonical.v1` transport accepts `atape.acp-centered.v1`,
`atape.acp-centered.v2`, explicit-unknown-time `atape.acp-centered.v3`, and
normalized-tool-identity `atape.acp-centered.v4` profiles. It accepts the shared
event kinds `message`, `thought`, `tool_call`, `tool_result`, `artifact`,
`spawn`, and `lifecycle`. Extension kinds remain closed until the protocol
carries an explicit extension schema and version.

## Read-only Canonical profile admission

`GET /api/v1/ingestion/canonical/capabilities` requires a CLI Credential and
returns `Cache-Control: no-store`. Its `atape.canonical-capabilities.v1`
representation includes a nonempty, unique `canonicalProfiles` list of modern
v2/v3/v4 profiles. This describes direct ingestion independently of Publication;
legacy v1 remains a historical write-compatibility path, not a discovery target.
Query parameters are invalid.

A legacy v3 Collector requires affirmative support before reading the source or
writing checkpoint/pending progress. On an older Server only an explicit
404/405/501 permits fallback to the existing negotiated publication-target-v3
capability as proof. An authoritative negative or malformed capability, failed
authentication or transient error cannot trigger that fallback. SourceCapture
still requires its own declared Publication targets and adoption capabilities.
The [OpenAPI schema](openapi-v1.yaml) specifies this Interface.

## Batch and publication write modes

Legacy Adapter collection uses this batch endpoint. Source-capture capabilities
instead prepare complete targets through the separate
[publication Interface](../architecture/publication-candidates.md). The Server
reserves one write mode per source: batch ingestion cannot mutate a reserved
publication source. Publication can adopt an existing legacy Session only through
its explicit, ownership-checked adoption operation. An Adapter upgrade is not an
implicit write-mode migration.

## Legacy-compatible example

```json
{
  "protocolVersion": "atape.canonical.v1",
  "canonicalProfileVersion": "atape.acp-centered.v1",
  "batchId": "codex-session-42-observation-7",
  "observedAt": "2026-09-04T20:55:30+08:00",
  "source": {
    "adapterId": "atape-adapter-codex",
    "adapterVersion": "0.1.0",
    "installationId": "liying-macbook"
  },
  "projectId": "payments-api",
  "session": {
    "sourceSessionId": "native-session-42",
    "revision": 1,
    "title": "Verify canonical ingestion",
    "summary": "Exercise the server write path from an Adapter-shaped batch.",
    "insight": "Stable source identity keeps replay and append updates safe.",
    "actor": { "name": "Liying", "harness": "Codex CLI" },
    "branch": "main",
    "status": "active",
    "captureStatus": "healthy",
    "updatedAt": "2026-09-04T20:55:12+08:00",
    "reportedEventCount": 2
  },
  "threads": [
    {
      "sourceThreadId": "native-root",
      "revision": 1,
      "label": "Root thread",
      "summary": "",
      "captureStatus": "healthy"
    }
  ],
  "events": [
    {
      "sourceEventId": "message-user-1",
      "sourceThreadId": "native-root",
      "revision": 1,
      "projectionRevision": 1,
      "sourceOrder": 1,
      "eventIndex": 0,
      "orderFidelity": "native",
      "fidelity": "native",
      "rawRef": {
        "type": "object",
        "sourceObjectId": "native-session-42-jsonl",
        "fragment": "#byte=0"
      },
      "kind": "message",
      "author": "Liying",
      "occurredAt": "2026-09-04T20:54:50+08:00",
      "text": "Can the team see this captured session?"
    },
    {
      "sourceEventId": "message-agent-1",
      "sourceThreadId": "native-root",
      "revision": 1,
      "projectionRevision": 1,
      "sourceOrder": 2,
      "eventIndex": 0,
      "orderFidelity": "native",
      "fidelity": "native",
      "rawRef": {
        "type": "unavailable",
        "reason": "The source did not retain this event"
      },
      "kind": "message",
      "author": "Codex",
      "occurredAt": "2026-09-04T20:55:12+08:00",
      "text": "Yes. The committed Canonical snapshot is now readable from Project Memory."
    }
  ]
}
```

Creating a Session with a new batch returns `201 Created`; another batch for an
existing Session returns `200 OK`. Replaying the exact batch returns `200 OK`
with `replayed: true`. Reusing a batch or entity revision
with different content returns `409 Conflict`. An archived Project remains
readable but rejects new Canonical ingestion; a deleted or inaccessible Project
is concealed as nonexistent at the authorization boundary.

`session.status` records provider lifecycle. `ended` is explicit and terminal
for that revision; `idle` is explicitly inactive; `active` means the source
remains open. Readers apply ATape's shared presence rule to an open Session: an
update within the last five minutes is shown as `active`, while an older open
Session is shown as `idle`.

An Event update keeps the same `sourceEventId` and `sourceThreadId`, increments
`revision`, and uses a new `batchId`. A new normalization pass increments
`projectionRevision`; it does not create a duplicate active Event.

The server derives Canonical identities from `projectId`, the authenticated
User, `installationId`, Adapter ID, and source-local identifiers. It also maps
an object Raw reference to the corresponding server-owned Raw object ID. A
client cannot select another User's capture namespace.

An explicit captured-Session deletion leaves a durable tombstone. Replaying or
re-uploading the same derived Session identity then returns
`409 resource_state_conflict`; an Adapter cannot accidentally resurrect data
the User deliberately removed.

Local filesystem paths, Team metadata, Memberships, and display names remain
outside this envelope. Git or Folder Project creation and local-directory
matching use the Team Module before collection begins.

The request body is limited to 4 MiB, 100 Threads, and 500 Events. When
PostgreSQL is configured, the Session, Threads, Events, projection changes, and
batch receipt commit in one transaction, so a successful response remains
replay-safe after a server restart.

The complete HTTP contract, route classes, body ceilings, and shared RFC 9457
Problem registry are machine-readable in [OpenAPI v1](openapi-v1.yaml).

## v2 tool details

Keep `protocolVersion: "atape.canonical.v1"` and set
`canonicalProfileVersion: "atape.acp-centered.v2"` to include `toolUpdateJson` on
an Event. This field is a JSON-encoded string containing the admitted ACP
`tool_call` or `tool_call_update`, with `toolCallId` and optional `title`, `kind`,
`status`, `rawInput` and `rawOutput`. A `tool_call` requires a nonempty title.
For example, the Event may include:

```json
{
  "toolUpdateJson": "{\"sessionUpdate\":\"tool_call_update\",\"toolCallId\":\"read-1\",\"status\":\"completed\",\"rawOutput\":{\"ok\":true}}"
}
```

The complete encoded update is limited to 140,000 UTF-8 bytes. Each input/output
value is limited to 65,536 bytes, depth 32 and 10,000 nodes; duplicate JSON keys,
unknown update fields and invalid enum values are rejected. Absence, JSON null,
false, zero and empty values remain distinct. v1 rejects tool details.

The Host redacts before encoding. The Server validates `kind` against the admitted
tool update (with the child-Thread `spawn` exception) and derives `text` and
`toolLabel` from it; readers expose decoded `tool` data.
Search indexes summaries rather than complete input/output. See
[conversation reads](conversation.md) and [ADR-0030](../architecture/adr/0030-bounded-tool-details-implementation.md).

## v3 unknown source clocks

The v3 profile permits explicit `null` for `session.updatedAt` and an Event's
`occurredAt`. Known values remain RFC 3339 timestamps. Missing fields, empty
strings, invalid timestamps and values that truncate to Go's zero instant at
PostgreSQL's microsecond storage precision are rejected; v1/v2
continue rejecting unknown source clocks. Upload `observedAt` remains required
and independent. Filesystem mtime, sidecar clocks and upload time must not replace
an unknown occurrence time.

The schema migration normalizes existing exact Go-zero source clocks to SQL
NULL, including Search and Overview facts, so pagination treats them consistently
as unknown. Other historical sentinels, such as the epoch, remain unchanged.
Frozen publication bodies, manifests and digests are not rewritten.

Reader responses preserve null and display an unknown time. Event order follows
source ordering rather than a manufactured clock; Search puts unknown clocks
after known clocks, and Overview excludes them from dated activity. An unknown
Session update time does not establish recent active presence. V3 retains the v2
tool-detail contract. Publication requires the explicitly advertised v3 target
profile for an entire candidate. Hosts request that advertisement with
`ATape-Accept-Publication-Target: atape.publication-target.v3`; a capabilities
request without opt-in retains the older v1/v2 response. Unknown header tokens
are ignored, including in comma-separated or repeated header fields. See
[ADR-0114](../architecture/adr/0114-explicit-unknown-conversation-time.md).

## v4 normalized tool identity

V4 retains v3's unknown source-clock semantics and adds the normalized identity
extension to the admitted ACP tool profile. V1/v2/v3 reject `_meta`. V4 permits
one closed object with the required key `atape.dev/tool-identity`; arbitrary
Provider metadata, extra fields and `_meta: null` are invalid.

```json
{
  "sessionUpdate": "tool_call",
  "toolCallId": "read-page-1",
  "title": "mcp__docs__read_page",
  "_meta": {"atape.dev/tool-identity": {"type": "mcp", "server": "docs", "name": "read_page"}}
}
```

A Skill identity is `{"type":"skill","name":"plugin:review"}`. Names and
MCP servers must already be trimmed, nonempty, well-formed Unicode strings of
at most 500 UTF-8 bytes. Unpaired surrogate escapes are rejected.
The Server validates rather than normalizes their values. An absent `_meta`
preserves the previous call identity; a null namespace value explicitly clears
it. A successful tool result does not establish successful completion of the
Skill's requested task.

Provider knowledge stays in the Adapter. The Host applies upload redaction to
the extension. Any masked identity key or value clears identity, preventing
leaks and accidental grouping of different secrets under one replacement.
The Host also clears a copied identity string when its original tool
input/output field is masked or hidden; a field rule cannot be bypassed by
copying the same value into metadata. Unrelated masked arguments do not clear
public identities.
The full tool update retains its existing byte/depth/node limits. Identity
travels with tool details in Canonical storage and publication hashes; there is
no separate identity table, Raw read or database migration.

Source-capture targets require `atape.publication-target.v4`, advertised only
for requests opting in with `ATape-Accept-Publication-Target`. The Host requests
v3 and v4 together; the old v3-only opt-in still receives its original profiles.
Every part's Canonical profile must agree with the frozen target profile.
The new Claude Adapter declares a static v4 minimum and checks the Host's
`projection.canonicalProfiles` before opening source bytes. Unsupported Hosts
and Servers refuse the path explicitly. See [Session Analytics](../session-analytics.md)
and [ADR-0120](../architecture/adr/0120-normalized-tool-identity.md).

## Structured usage

All accepted profiles may include up to 500 `usage` records per batch. Each
record identifies `sourceUsageId`, `sourceThreadId`, a positive safe-integer
`revision`, known `occurredAt`, and `model`. Usage occurrence time is not nullable
in v3. Its Thread must appear in the batch.
Include at least one of `inputTokens`, `outputTokens`, `cacheReadTokens` or
`cacheWriteTokens`. Omit unknown counters; zero is a known measurement.

```json
{
  "sourceUsageId": "native-message-42",
  "sourceThreadId": "native-root",
  "revision": 1,
  "occurredAt": "2026-09-04T20:55:12+08:00",
  "model": "example-model",
  "inputTokens": 120,
  "outputTokens": 30,
  "cacheReadTokens": 80,
  "cacheWriteTokens": 10
}
```

Counters are nonnegative integers no larger than 9,007,199,254,740,991. Input
includes cache subdivisions; when input is supplied, cache read plus cache write
cannot exceed it. Repeated identities within a batch are rejected. Stable source
identity and revision semantics prevent replay from double-counting usage.
Usage is Canonical data and is collected independently of Raw policy; see
[Team Overview](../team-overview.md) for aggregation and interpretation limits.
