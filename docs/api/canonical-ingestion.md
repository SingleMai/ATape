# Canonical ingestion API

`POST /api/v1/ingestion/canonical/batches` synchronously validates and applies
one bounded Canonical observation batch. A successful response means the batch
is visible to Canonical readers; it does not mean Raw has been stored or Search
has been projected.

The request is authenticated with a CLI Credential. Its server-established
Principal supplies the capture User. The payload cannot declare a User, Team,
Membership, or Project ownership. `projectId` is only the target Resource
locator; the server resolves its Team and current Membership before accepting
the batch.

The v1 transport uses the pinned ACP-centered profile. It accepts the shared
event kinds `message`, `thought`, `tool_call`, `tool_result`, `artifact`,
`spawn`, and `lifecycle`. Extension kinds remain closed until the protocol
carries an explicit extension schema and version.

## Example

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

The first successful observation returns `201 Created`. Replaying the exact
batch returns `200 OK` with `replayed: true`. Reusing a batch or entity revision
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

Local filesystem paths, Team metadata, Memberships, and display names remain
outside this envelope. Git or Folder Project creation and local-directory
matching use the Team Module before collection begins.

The request body is limited to 4 MiB, 100 Threads, and 500 Events. When
PostgreSQL is configured, the Session, Threads, Events, projection changes, and
batch receipt commit in one transaction, so a successful response remains
replay-safe after a server restart.
