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

Keyword, Team, and Project are the supported filters. There are no member, Agent,
or date filters in the existing backend contract. Cross-project global relevance,
server-side filtering, and latency improvements for very large project directories
belong to the next Search API increment. Project pinning/recent-visit persistence
is also outside this increment; the current directory uses stable name ordering.

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
