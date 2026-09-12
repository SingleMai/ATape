# Project memory and conversation reads

These `WebOnly` endpoints return Canonical data through the conversation Module.
They require a Web Session Cookie, reauthorize access and use `Cache-Control:
no-store`. They never include Raw archive bodies. The named `ProjectMemory`
and `Conversation` schemas in [OpenAPI](openapi-v1.yaml) define response fields;
the ingestion envelope is a separate Interface.

## Project memory

`GET /api/v1/projects/{projectId}/memory` returns `project`, `capturedThrough`,
`active` and `trail`. Each Session summary includes its identity, title, summary,
insight, actor, branch, effective status, update time, Event count and child-Thread
count. `trail` contains all returned Sessions in update-time order; `active` is
the active subset, not another set to concatenate without deduplication.

The compact reader `project` contains `id`, `teamId`, `name` and `type` (`git` or
`directory`). This reader type differs from the Team control-plane
[Workspace](workspace.md) representation, which uses `folder` for ordinary folders.
`capturedThrough` is a Canonical watermark, not evidence of Raw or Search completion.
The current Project memory response is not paginated.

## Open a Thread

```http
GET /api/v1/sessions/{sessionId}?thread=root&limit=100
Accept: application/json
```

The result includes `session`, selected `thread`, root-to-current `threadPath`,
and ordered `events`. `session.capturedBy`, when available, identifies the capture
User; it is separate from the source `actor`. Events expose reader identities,
kind, author, occurrence time and text, with optional `toolLabel`, decoded `tool`
details and `childThread`. They do not expose the full ingestion envelope or Raw
reference metadata. Follow a child reference's ID using the `thread` parameter.

| Parameter | Meaning |
| --- | --- |
| `thread` | Selected Thread; defaults to `root` |
| `limit` | 1–100; opts into bounded publication paging |
| `head` | Selected head returned by the preceding publication page |
| `after` | Previous `nextEventId`, exclusive; requires `head`, excludes `at` |
| `at` | Inclusive Event anchor, for example a Search result; excludes `after` |

`head`, `after` and `at` require `limit`. Unknown, duplicate and empty query values
are rejected. Publication responses include `head`; while `nextEventId` is present,
request another page with the same Thread/head and `after=nextEventId`. Pages may
contain fewer Events than requested because the complete JSON representation is
also bounded to 8 MiB. Absence of `nextEventId` ends that traversal.

If the selected head changes, `409 refresh_required` means reopen from the new
head; do not concatenate Events from different heads. Without `limit`, a large
publication can return `409 pagination_required`. Legacy batch-mode Sessions
retain full reads even when `limit` is supplied, so this is not a universal
pagination guarantee for all stored histories.

An unknown or concealed Session/Thread returns `404 not_found`. Read paging and
refresh behavior follows the [publication contract](../architecture/publication-candidates.md).
[Search](project-search.md) supplies exact Session/Thread/Event anchors. Raw is
opened separately through the [archive API](raw-archive.md).
