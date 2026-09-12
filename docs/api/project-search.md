# Project Search API

ATape Search retrieves current Canonical conversation Events from an independent, eventually consistent read model. Raw source payloads are never queried or returned by this API.

## Search a project

```http
GET /api/v1/projects/{projectId}/search?q=idempotency%20key&cursor=&limit=20
Cookie: __Secure-atape_session=...
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

`indexedThrough` is optional: absence means the index has no confirmed watermark,
including while publication heads have unmatched Search documents. Follow optional
`nextCursor` with the same query and Project; absence means no further page.
The complete response is the `SearchPage` schema in [OpenAPI](openapi-v1.yaml).

Publication results are qualified by current head membership. Withdrawn or stale
members stop matching at activation; newly selected content can remain absent
until asynchronous indexing catches up. Open the exact Event with the
[conversation paging Interface](conversation.md), using `limit` and `at`.
The Web's global Search coordinates these per-Project queries; this endpoint
does not promise global ranking or a cross-Project snapshot.

The route is `WebOnly`; Search loads current Project and Membership authority
instead of trusting indexed ACL data. Invalid queries return RFC 9457 `422`
Problems with `code: "validation_failed"`. Concealed Projects return the same
`404 not_found` shape as missing Projects. Dependency failures use the fixed
`500 internal_error` Problem and are correlated only by `X-Request-ID`.
