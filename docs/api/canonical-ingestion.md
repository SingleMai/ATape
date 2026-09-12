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

The `atape.canonical.v1` transport accepts the legacy `atape.acp-centered.v1`
profile and the current `atape.acp-centered.v2` profile. It accepts the shared
event kinds `message`, `thought`, `tool_call`, `tool_result`, `artifact`,
`spawn`, and `lifecycle`. Extension kinds remain closed until the protocol
carries an explicit extension schema and version.

## Batch and publication write modes

Codex and Claude use this batch endpoint. OpenCode's `atape.source-capture.v1`
capability instead prepares complete targets through the separate
[publication Interface](../architecture/publication-candidates.md). The Server
reserves one write mode per source: batch ingestion cannot mutate a reserved
publication source, and publication cannot adopt an existing legacy Session.
An Adapter upgrade is not an implicit write-mode migration.

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

## Structured usage

Both accepted profiles may include up to 500 `usage` records per batch. Each
record identifies `sourceUsageId`, `sourceThreadId`, a positive safe-integer
`revision`, `occurredAt`, and `model`. Its Thread must appear in the batch.
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
