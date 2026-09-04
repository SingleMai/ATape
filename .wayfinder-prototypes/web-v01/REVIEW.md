# ATape v0.1 continuous-experience prototype

This is a disposable HITL prototype for “定义 v0.1 的共享、查询与 Web/API 最小体验”. It is not production implementation and intentionally uses no framework.

## Why v2 exists

The first prototype exposed Activity, Search, Replay, Raw and metadata as separate product surfaces. It demonstrated scope, but it felt like a dashboard assembled from features rather than one coherent experience.

v2 is organized around one user job:

> Understand what the team is doing, recover the exact conversation behind it, and follow the evidence without losing context.

## Proposed experience model

Only two persistent reading surfaces remain:

1. **Project Memory** — the project's shared entry point. “Happening now” gives awareness through live conversation previews; “Memory trail” preserves chronological team history. There are no analytics counters.
2. **Session Reader** — an immersive Canonical conversation. Metadata is progressively disclosed, child threads are entered in context, and no reply composer implies that ATape is a harness.

Two temporary layers support those surfaces:

- **Search overlay** — opens over the user's current context via the top bar or `Cmd/Ctrl + K`; searches Canonical messages, including child threads. A hit deep-links to and highlights the exact event. Browser Back returns to the same result set.
- **Raw drawer** — loads Raw only after an explicit action, then closes back to the exact conversation. Raw remains a separate API/storage path even though the UI is a drawer.

## Review path

1. On Project Memory, inspect “Happening now”: can you understand who is working on what without opening a session?
2. Open the checkout conversation and read it without using any metadata panel.
3. Follow `schema-review` into the child thread, then return through the thread breadcrumb or browser Back.
4. Open `Session context`; confirm that secondary metadata no longer competes with the conversation.
5. Open Raw; observe the explicit loading state and close back to the reader.
6. Press `Cmd/Ctrl + K`, search `idempotency key`, open the child-thread result, and use “Back to results”.
7. Search a missing term and inspect the recovery suggestions rather than a dead end.

## Interaction-state contract

| State | Persistent context | Primary action | Exit behavior |
|---|---|---|---|
| Project Memory | Team + Project | Open active/recent conversation | Remains project-scoped |
| Search overlay | Underlying Project or Session | Open exact matching event | Close/Back restores underlying state |
| Session Reader | Project + Session + Thread | Read/follow child thread | Back returns to Project or Search |
| Raw drawer | Underlying Session + Thread | Inspect source-native payload | Close/Back restores exact reader state |

Every view state is represented in the URL hash in the prototype. Production routes should use normal URLs with equivalent deep-link semantics.

## Proposed read API surface

```text
GET /v1/teams
GET /v1/teams/{team_id}/projects

GET /v1/projects/{project_id}/memory?cursor=
GET /v1/projects/{project_id}/search?q=&cursor=&member_id=&harness=&from=&to=

GET /v1/sessions/{session_id}
GET /v1/sessions/{session_id}/threads
GET /v1/threads/{thread_id}/events?cursor=&anchor_event_id=

GET /v1/sessions/{session_id}/raw
GET /v1/raw-objects/{raw_object_id}/content?cursor=
GET /v1/raw-objects/{raw_object_id}/download
```

`Project Memory` responses contain denormalized member, Harness, branch, state, latest-event excerpt, child count and update time so the UI does not fan out per card. Search returns an event anchor and thread breadcrumb. Canonical and Raw retrieval stay independent.

## Visual direction

The accepted visual language remains **ATape Cozy Island Workshop**. The source of truth is [`design-system/atape/MASTER.md`](../../design-system/atape/MASTER.md).

The direction references [Animal-Island-UI](https://github.com/guokaigdg/animal-island-ui) as mood only and imports none of its runtime code, icons, illustrations or assets. Its CC BY-NC 4.0 license makes it unsuitable as an ATape production dependency without separate permission.

## Product-owner decisions still required

1. Does Project Memory correctly replace the old Activity dashboard as the default project entry?
2. Should Search stay a context-preserving overlay rather than a persistent page?
3. Should child-thread navigation remain contextual (spawn card + breadcrumb) instead of an always-visible tree?
4. Should Raw stay in the drawer pattern shown here?
5. Is v0.1 search filtering complete with member, Harness and time, keeping branch/status out until evidence demands them?

