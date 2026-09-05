# Raw Archive API

Raw source is retained separately from Canonical conversation data and the
Search read model. Opening a Session never fetches Raw metadata or bytes. The
Web application calls these endpoints only after a member explicitly opens the
Raw source drawer.

## Append one bounded chunk

```http
POST /api/v1/ingestion/raw/chunks
Content-Type: application/json
```

```json
{
  "protocolVersion": "atape.raw.v1",
  "sourceChunkId": "native-session-42-g1-c7",
  "sourceObjectId": "native-session-42-jsonl",
  "sessionId": "s_7bbd144c5f7d57517e1bb03d",
  "installationId": "liying-macbook",
  "generation": 1,
  "offset": 131072,
  "sourceName": "session.jsonl",
  "mediaType": "application/x-ndjson",
  "adapterId": "atape-adapter-codex",
  "adapterVersion": "0.1.0",
  "capturedAt": "2026-09-04T20:55:30+08:00",
  "clientRedacted": true,
  "final": false,
  "contentBase64": "eyJ0eXBlIjoibWVzc2FnZSJ9Cg==",
  "sha256": "dbbea0267efbbfd3788874c41718404fe9f65200e62c9e7016fd6a5fbd734a26"
}
```

`sessionId` is the server-owned Canonical Session ID returned by Canonical
ingestion, not the provider's source Session ID. `sourceObjectId` and
`sourceChunkId` are stable only inside the Adapter's source namespace. The
server derives the persisted object and chunk IDs from the authenticated User,
Canonical Session, installation, Adapter, and these source-local IDs.

The client does not send `userId`, `teamId`, `projectId`, `objectId`, or
`chunkId`. The server resolves the Session's Project, Team, current Membership,
Project state, and capturing User. Only the same User who created the Canonical
Session may append its Raw source; current Team members may read it.

- Decoded content is limited to 256 KiB; the complete request body is limited
  to 512 KiB.
- Every request contains the exact lowercase SHA-256 of the decoded bytes.
- The client applies configured secret redaction before upload and declares
  `clientRedacted: true`.
- A new object starts at generation 1 and offset 0. Later chunks use the current
  generation size as their offset.
- Replaying the same source chunk and exact payload returns `200 OK` with
  `replayed: true`. Reusing its identity with different bytes or metadata is a
  conflict.
- A source rewrite or truncation starts exactly the next generation at offset
  0. Older generations remain retained and readable.
- `final: true` closes that generation. An empty final chunk is allowed when
  only finalization remains.
- Authorization is checked before writing bytes and again in the manifest
  transaction. A revocation between those checks can leave only an unreachable,
  content-addressed blob for later orphan collection; it cannot commit a Raw
  manifest.

## List a Session's Raw objects

```http
GET /api/v1/sessions/{sessionId}/raw
Accept: application/json
```

This returns manifests and generation summaries only. It never returns
`contentBase64`.

## Read one bounded content page

```http
GET /api/v1/raw-objects/{objectId}/content?generation=1&cursor=...&limit=4
Accept: application/json
```

`generation=0` or an omitted generation selects the current generation.
`limit` is a chunk count from 1 through 8 and defaults to 4. `nextCursor` is
opaque and binds the next request to the same Raw object and generation. A page
therefore contains at most 2 MiB of decoded source.

Raw v1 does not synchronize provider deletion and exposes no automatic Raw
delete operation. Database and blob capacity remain an operator concern;
per-request and per-page bounds protect application memory.
