# Project Search API

ATape Search retrieves current Canonical conversation Events from an independent, eventually consistent read model. Raw source payloads are never queried or returned by this API.

## Search a project

```http
GET /api/v1/projects/{projectId}/search?q=idempotency%20key&cursor=&limit=20
Accept: application/json
```

| Parameter | Required | Meaning |
| --- | --- | --- |
| `q` | yes | Non-empty keyword or phrase, at most 200 UTF-8 bytes |
| `cursor` | no | Opaque continuation cursor returned by a prior response |
| `limit` | no | Result count from 1–50; defaults to 20 |

The initial PostgreSQL Adapter combines literal substring retrieval with the built-in `simple` full-text configuration. Ranking and cursor representation are private implementation details.

```json
{
  "projectId": "payments-api",
  "query": "idempotency key",
  "indexedThrough": "2026-09-04T02:46:00Z",
  "results": [
    {
      "eventId": "c6",
      "sessionId": "checkout",
      "sessionTitle": "Fix duplicate checkout charge on retry",
      "threadId": "schema-review",
      "threadPath": [
        { "id": "root", "label": "Root thread" },
        { "id": "schema-review", "label": "schema-review" }
      ],
      "author": "schema-review · subagent",
      "harness": "Codex CLI",
      "occurredAt": "2026-09-04T02:43:24Z",
      "text": "The provider request ID arrives too late...",
      "toolLabel": "Inspected migration"
    }
  ]
}
```

`sessionId`, `threadId`, and `eventId` form the replay anchor. A client opens that Thread and positions the reader at the exact Event. `indexedThrough` is the Canonical observation watermark reached by Search; a successful ingestion response does not imply immediate search visibility.

Invalid queries return `400` with `code: "invalid_search"`. Dependency failures return the generic `500` presentation error and are logged by the server.
