# ADR-0052: Refresh only active sources on continuation pages

Status: Accepted

## Decision

The Codex Archive Module keeps one current Session discovery result for its
runtime lifetime. When an opaque cursor continues that Session, it refreshes only
those source files. Every refreshed file still rereads its original metadata,
resolves Git attribution through the Host, and reads current file stat information.
Missing paths trigger full discovery so archival and relocation remain supported.
Starting or selecting another Session always performs full discovery.

The cursor already defines a fixed set of source snapshots for pagination. Newly
created files and Sessions are selected at the next discovery boundary; they are
never added silently to an in-flight snapshot. Metadata/permission changes to an
active file are evaluated before each page. Discovery results carry no cached
authorization decisions. The existing projection cache remains separately keyed
by snapshots and current generation/size/modification times.

## Alternatives and evidence

Measurements of the real installation showed warm collection pages taking about
4.7–5.0 seconds before upload, including 15 serial project-match HTTP requests on
every page. Long-lived caching of repository matches would introduce stale
attribution decisions. Raising page limits leaves unrelated scanning work in the
critical path. Refreshing the active sources removes unrelated work while keeping
the existing per-call Host authorization and immutable evidence Interface.

This adds no new Seam or persistent state. The runtime retains one Session, not an
unbounded archive cache. Public Adapter tests verify active-source reauthorization,
archival during pagination, and discovery of new Sessions at the next boundary.
Canonical, Raw, and Search contracts remain unchanged.

## Backlog scheduling

The Collector Module exposes a pure decision over its existing cycle report:
continue immediately only when there are no job failures and a job has more
pages. Foreground and managed runners share this decision. Effect yields between
bounded cycles; idle and failed cycles retain the configured polling delay.
Source-level diagnostics do not block eligible sources. Authentication failure
still stops the runner. Public runner tests use a virtual clock to verify draining,
idle polling, failure backoff, and cancellation for both entry points.

Keeping unconditional polling wastes 30 seconds after each successful batch;
increasing the page bound instead weakens the existing scheduling boundary.
This decision retains bounded cycles and adds no new configuration or Seam.
