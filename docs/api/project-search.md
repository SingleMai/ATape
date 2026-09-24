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

Search matches a case-insensitive literal substring of user and agent message
bodies (`kind=message`), including child Threads. Tool calls/results, reasoning,
session titles, author names and tool labels are not match sources. Internal
punctuation and whitespace are literal; `%`, `_`, `#`, emoji and Chinese characters
are supported, including single-character queries. Leading/trailing whitespace is
trimmed. This is not token, fuzzy or semantic search; `#707` does not match `707`
without the `#`. Unicode normalization/accent folding is not performed.

Results are newest first, with descending Event ID as the tie-breaker. `text` is a
match-centered excerpt of at most 640 Unicode characters; open the Event anchor to
read the full body. `toolLabel` remains optional for wire compatibility but is not
populated by message-body Search. A page is bounded to 50 results without a full
match count. PostgreSQL uses an independent character-gram index and exact body
verification; canonical bodies are never truncated for matching.

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
      "text": "The provider request ID arrives too late..."
    }
  ]
}
```

`sessionId`, `threadId`, and `eventId` form the replay anchor. A client opens that Thread and positions the reader at the exact Event. `indexedThrough` is the Canonical observation watermark reached by Search; a successful ingestion response does not imply immediate search visibility.

`indexedThrough` is optional: absence means the index has no confirmed watermark,
including while publication heads have unmatched Search documents. Follow optional
`nextCursor` with the same trimmed query and Project; absence means no further page.
The cursor is versioned and scoped to both values. Old offset cursors and cursors
from another query/Project return `422 validation_failed`; restart at the first
page. Keyset pagination avoids offset rescans. Concurrent changes are visible on
subsequent requests; pagination is not a frozen snapshot.
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
