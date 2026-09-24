# Workspace and global Search

The workspace keeps a compact Team identity and an alphabetical Project directory
in the sidebar, with no project-filter input. With multiple Teams, the Team name opens a
Team switcher that remains available when the sidebar is collapsed and in the
mobile header. A single Team displays its identity without a dropdown.
Team settings is available from the account settings dialog.
The sidebar can collapse; on small screens it starts collapsed. The Project page
shows one deduplicated conversation list with All/Active controls. Reader content
starts below a compact title and metadata line. Refresh settings, capture details,
and Raw source are disclosed through More; degraded capture and refresh failures
remain visible without opening it.

Search everything in the sidebar, Cmd+K on macOS, or Ctrl+K elsewhere opens the
same modal across the authenticated workspace and settings. Search defaults to all
accessible Projects across Teams. Filters progressively reveal Team and Project
scope. Queries are debounced, and the dialog retains query, scope, current result
page, and scroll when dismissed or when opening a result. This state is local to
the current authenticated app session, not persisted across reloads. Recently
opened queries appear when the input is cleared.

The native dialog contains keyboard focus and returns it on dismissal. Arrow keys
move between results; Enter opens a result's canonical Session/Thread/Event URL.
The reader expands matching Activity and focuses the exact Event. Reopening Search
returns to the retained result list. Old `/teams/:team/projects/:project/search?q=`
links seed a project-scoped dialog over the Project page; closing does not depend
on having a prior browser history entry.

## Shipped scope and limits

The application Search Module queries the existing project Search API with at most
four concurrent requests. Results are grouped by Project with server ordering
preserved inside each group. Next/Previous move through batches of project pages;
exhausted Projects do not restart. A failed Project yields an explicit failure
instead of silently showing an incomplete search. The browser UI test Adapter
covers multiple projects, independent cursors, exact-message navigation, dialog
focus/state retention, legacy URLs, and responsive layouts.

Search matches user and agent message bodies, including child Threads. Tool
execution, tool output, reasoning and navigation metadata do not produce hits.
Queries are literal and case-insensitive, including Chinese, code fragments,
punctuation and single characters. Results are newest first within each Project.
The server returns a bounded excerpt around the match; opening it loads the full
message. Versioned keyset cursors replace offset/count queries. Old open Search
pages must restart at page one after a Server upgrade.

Keyword, Team, and Project are the supported filters. There are no member, Agent,
or date filters in the existing backend contract. Cross-project global relevance,
server-side filtering, and latency improvements for very large project directories
belong to the next Search API increment. Project pinning/recent-visit persistence
is also outside this increment; the current directory uses stable name ordering.

## Agent identity

Project conversation rows, global Search results and Session reader headers use
the shared `@atape/ui` `AgentIdentity` component with a 24px color icon and name.
Child readers reuse the same header. Names and assets resolve through one
`resolveAgentIdentity` mapping; captured aliases such as `codebuddy-code` display
as WorkBuddy without changing stored names or message authors. OpenCode, unknown
agents and failed image loads keep a readable text fallback. Status markers,
capturing-user avatars, branch metadata and conversation navigation remain
independent of agent identity.

See the [agent-logo guide](../packages/ui/docs/agent-logos.md) for aliases,
rendering behavior and how to add another asset.

## Conversation Markdown

Message headings use a local reading scale (1–1.25 times the message body size)
with consistent weight, line height, and spacing. They no longer inherit the
page-level hero typography. Long paths wrap, images fit the message width, and
wide code blocks and tables scroll inside the message. Colors continue to use
the shared theme tokens.

Captured file and artifact links render as selectable text rather than navigation:
local paths, relative paths, and source-app links have no uploaded artifact host
or source-workspace base in the reader. Explicit HTTP(S) and email links remain
clickable, including files hosted at public web URLs. Link labels and inline
formatting are preserved.

This increment changes presentation only; it preserves Markdown content and
heading semantics. It does not restructure attachment metadata or audit every
tool disclosure and search-highlight state. A broader reader visual review is
the next increment if those states need refinement.

## Settings overlay

Account and Team settings open in a lightweight dialog over the current page.
Account and CLI credentials are separate categories; Team
settings shares the same dialog. Closing restores keyboard focus and preserves
the reader URL and scroll position. Nested security confirmations retain their
existing behavior and do not dismiss Settings when canceled.

Browser-session management is no longer exposed in Settings or requested by the
Web account loader. Ordinary sign-out remains available; server-side session
validation, expiration, and revocation APIs remain unchanged.

Legacy account and Team settings URLs open the dialog above the default workspace.
Settings selection is ephemeral; a reload returns to the underlying workspace.
Existing account and Team Effect presenters still own remote data and actions.

## Child conversation tabs

Child conversation cards open a tab in a right-hand reading panel without changing
the main Session/Thread/Event URL. Opening the same child selects its existing tab;
children reached inside a tab open alongside it. Each mounted reader retains its
scroll position and disclosures. The existing Effect conversation presenter owns
loading, refresh, failures, and cleanup independently for each tab. A child failure
can be retried without replacing the main conversation.

Each tab also retains its own versioned page cursor. Next page and Read from the
beginning operate inside that tab; replacing a publication uses the existing
presenter reload flow without changing the main URL.

Tabs support Left/Right, Home/End, and Delete while focused. Closing the active tab
selects its neighbor; closing the last tab or the entire panel restores focus to
the main reader's opener. The root breadcrumb returns focus to that main reader.
On screens up to 1100px wide the split is vertical, initially giving the child
panel the lower half of the reading area.
Direct links and Search results still open their requested thread in the main
reader. Navigating to another main thread/session clears the panel.

The presentation uses the `Group`, `Panel`, and `Separator` Interface from
`react-resizable-panels` (4.12.4). Its Implementation owns size constraints,
pointer/touch resizing, and keyboard access to the divider. This replaces the
fixed sidebar layout without adding another workflow runtime or a custom drag
implementation. Both sides have independent scroll viewports; the main prompt
index and reading anchor use that viewport's bounds. Panel proportions are
remembered separately for horizontal and vertical layouts during this visit.

Opening and closing animate panel sizes over 220ms; tab content fades in over
160ms. Dragging remains immediate. Closing keeps content mounted until its
transition completes. The system's reduced-motion preference disables these
transitions, including when that preference changes while the reader is open.
The toolbar contains tabs and a close button, with no additional section title.

Tab state and panel proportions are ephemeral and do not survive a reload.
Reordering, durable tab restoration, and a prompt index within each child panel
are possible follow-up work. Canonical conversation and Raw source data remain
behind their existing separate Interfaces.

## Search implementation and verification

[ADR-0086](architecture/adr/0086-message-body-search.md) compares code-search and
conversation-search designs and records the selected PostgreSQL character index.
Search keeps non-message identity/version rows without body text so asynchronous
stale workers cannot resurrect excluded content. Message bodies are fully indexed;
response excerpts do not restrict recall. The query lifetime is two seconds, and
HTTP diagnostics include request ID, duration and outcome without query text.

Run `ATAPE_INTEGRATION_TESTS=1 go test ./internal/adapters/postgres -run TestMessageBodySearch -v`
from `server/` for the behavior contract. Add `ATAPE_SEARCH_SCALE=1` to build a
400,000-Event fixture (80,000 message bodies) and test first/second pages at four
concurrent searches with a p95 <=1-second target per query class. The fixture covers
common/rare/absent text, single-character Chinese, symbols, emoji, code paths and
literal verification. Test results are capacity evidence for that corpus and host,
not a guarantee for arbitrary hardware, index backlog or Project directory size.

Migration 22 rewrites the derived Search table and builds its message indexes in
the migration transaction. Schedule a Server migration window, ensure enough free
disk for table/index rewrite and WAL, and take a paired backup first. Old Server
binaries require the previous database schema; restoring only the binary is not a
rollback. Run the candidate's explicit `atape-server migrate --timeout 15m` command
with writers stopped, as described in [self-hosting operations](operations/self-hosting.md#routine-operations),
before normal startup; a large index build can exceed the ordinary startup deadline.
Verify exact-message results, exclusion of tool-only terms, pending
projection progress and request latency after rollout. This code change alone does
not deploy the Server or run the production migration.

### Capacity evidence (2026-09-24, local)

The live read-only inventory contained 62,349 legacy message Events averaging
440 bytes, within 360,636 legacy Events; the Search table held 363,910 documents.
The local synthetic test used 400,000 projection rows, 80,000 message bodies around
500 characters, plus a long body and correctness fixtures. PostgreSQL 17 ran in an
ARM64 Docker VM with a 2-CPU/2-GiB container limit. Go 1.25.14 invoked the authorized
Searcher Interface over TCP. This measures Server/DB operation latency, not the
public edge, browser debounce, cold disk cache, or depleted EC2 CPU credits.

At four concurrent workers, each query/page class had 40 samples. All classes
passed p95 <=1 second: the highest p95 was 294 ms for the common English term;
Chinese single/common terms were 199–209 ms; `#707` was 25–29 ms; rare paths,
emoji and absent terms were 5–18 ms. A deliberately absent phrase composed entirely
of common grams took 242 ms p95 and returned no false matches. Fifty sequential
pages (1,000 messages) had p95 87 ms with no duplicate anchors. The fixture's table
and indexes occupied 315 MiB; bulk fixture construction plus vacuum took 53 seconds.
That construction measurement is not production migration time or projector
throughput. Performance regression tests remain opt-in because shared CI hardware
cannot establish the deployment latency budget.

### Deployed verification (2026-09-24)

[PR #186](https://github.com/SingleMai/ATape/pull/186) passed CI and all Security
jobs and merged as `82b28717efe4554b1c34af7f3318a96d05942ab8`. The deployed ARM64
Server was built from checked PR head `158a5f1f104d38450f0655cd6f8203902c2580d0`,
whose tree is identical to the merge. Server version, Authentication epoch and
minimum CLI version remain `0.5.2`, `auth-v1`, and `0.5.2`; no package was published.

After the user authorized deployment, the operator stopped writers, made a paired
PostgreSQL/Raw backup with digests, and ran the explicit migration command from
schema 21 to 22. Migration took 6 minutes 8 seconds; the maintenance window was
06:59:40–07:06:48 UTC (7 minutes 8 seconds). Server/Web readiness passed. An encrypted
EBS snapshot containing the immutable paired backup completed; the previous image
and backup remain available for paired rollback. Future rollouts should budget
for this measured migration duration rather than the local fixture build time.

At migration completion, the read model contained 363,408 rows, including 62,538
message bodies. Every non-message row had empty text, search text and grams.
Authenticated browser requests through the public Cloudflare edge exercised two
Projects, eleven query classes, ten repetitions and four concurrent requests:
220 requests returned successfully with literal matches and excerpts <=640
characters; the deliberately absent term returned no results. `#707` also returned
no message-body matches in this corpus and was a valid empty-result check.

| Measurement | p50 | p95 | Maximum |
| --- | --- | --- | --- |
| Public HTTP, including response JSON consumption (220 requests) | 275 ms | 786 ms | 1,418 ms |
| Corresponding Server Searcher log durations (220 requests) | 64 ms | 442 ms | 1,052 ms |
| Public `#707` requests (20 requests) | 137 ms | 302 ms | 377 ms |
| Public single Chinese character `的` (20 requests) | 539 ms | 940 ms | 1,245 ms |

Other probes covered `#`, `正文`, `e`, `function`, `/api/`, `_`, `%`, emoji and absent
text. The UI displayed 40 highlighted `#` results across both Projects in 1.45
seconds from input, including debounce and rendering; the second page displayed
40 different results in 860 ms. Opening a result focused the exact Event anchor
and its full body contained the query. These measurements establish
second-scale retrieval on this deployed corpus, not an unlimited hardware/load SLA.

Two initial post-switch browser probes were aborted at their 6-second client
deadline before this 220-request run; Server logs recorded one 31-ms success and
one request cancellation. Their complete transport/authentication timing was not
captured, so their cause is not established. They did not recur in the subsequent
run and are not included in its latency percentiles. Retain this distinction when
comparing steady-state search with first requests after a deployment.
