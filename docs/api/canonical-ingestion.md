# Canonical ingestion alpha

`POST /api/v1/ingestion/canonical/batches` synchronously validates and applies one bounded Canonical observation batch. A successful response means the batch is visible to Canonical readers; it does not mean Raw has been stored or Search has been projected.

This is an internal `v1alpha1` transport used to exercise the ingestion semantics. It is not yet the public Adapter SDK protocol. Canonical semantic payloads will reuse the pinned ACP-centered profile rather than extending the current reader-oriented text fields.

This version accepts the shared event kinds `message`, `thought`, `tool_call`, `tool_result`, `artifact`, `spawn`, and `lifecycle`. Extension kinds are intentionally rejected until the protocol carries an explicit extension schema and version.

## Example

```json
{
  "protocolVersion": "atape.canonical.v1alpha1",
  "canonicalProfileVersion": "atape.acp-centered.v1alpha1",
  "batchId": "codex-session-42-observation-7",
  "observedAt": "2026-09-04T20:55:30+08:00",
  "source": {
    "adapterId": "atape-adapter-codex",
    "adapterVersion": "0.1.0",
    "userId": "user-liying",
    "installationId": "liying-macbook"
  },
  "project": {
    "id": "payments-api",
    "teamId": "acme-engineering",
    "teamName": "Acme Engineering",
    "name": "payments-api",
    "type": "git"
  },
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
      "rawRef": "raw-object-42#line:1",
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
      "rawRef": "raw-object-42#line:2",
      "kind": "message",
      "author": "Codex",
      "occurredAt": "2026-09-04T20:55:12+08:00",
      "text": "Yes. The committed Canonical snapshot is now readable from Project Memory."
    }
  ]
}
```

The first successful observation returns `201 Created`. Replaying the exact batch returns `200 OK` with `replayed: true`. Reusing a batch or entity revision with different content returns `409 Conflict`.

`session.status` records provider lifecycle. `ended` is explicit and terminal for that revision; `idle` is explicitly inactive; `active` means the source remains open. Readers apply ATape's shared presence rule to an open Session: an update within the last five minutes is shown as `active`, while an older open Session is shown as `idle`. This read-time aging keeps Workspace counts, Project Memory, and Session Reader consistent without manufacturing ingestion revisions.

`project.type` is either `git` or `directory`. A Git repository is preferred when client setup detects one; a user may explicitly configure an ordinary directory instead. Team identity and Project ID, Team, name, and type become immutable after the first accepted observation. Local filesystem paths remain client-side configuration and are not uploaded in this envelope.

An Event update keeps the same `sourceEventId` and `sourceThreadId`, increments `revision`, and uses a new `batchId`. A new normalization pass increments `projectionRevision`; it does not create a duplicate active Event.

When `ATAPE_DATABASE_URL` is configured, active Canonical rows, Event projection versions, and the batch receipt commit in one PostgreSQL transaction. A successful response therefore remains replay-safe after a server restart. Without database configuration, the seeded development Adapter remains process-local.
