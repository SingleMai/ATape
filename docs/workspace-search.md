# Workspace and global Search

The workspace keeps a compact Team identity and an alphabetical, filterable
Project directory in the sidebar. The Team name opens a menu containing Team settings and, when applicable, a Team switcher. This menu remains available when the sidebar is collapsed and in the mobile header.
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

Keyword, Team, and Project are the supported filters. There are no member, Agent,
or date filters in the existing backend contract. Cross-project global relevance,
server-side filtering, and latency improvements for very large project directories
belong to the next Search API increment. Project pinning/recent-visit persistence
is also outside this increment; the current directory uses stable name ordering.
