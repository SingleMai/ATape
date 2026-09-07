# ADR-0035: Global Search workspace

## Decision

The authenticated Web shell owns one persistent Search dialog. Project and Session
URLs remain the navigation Interface; opening Search does not replace the current
page. Search state and result scroll survive closing the dialog and navigating
between authenticated pages. The existing project Search URL remains a compatible
entry point that seeds the dialog.

The Search Module adds a bounded multi-project operation over the existing remote
SearchGateway Seam. Its Implementation queries up to four authorized Projects at a
time, annotates results with their Project/Team, preserves server ranking within
each Project, and carries independent continuation cursors. Exhausted Projects are
not restarted on the next page. Any Project failure fails the page explicitly;
partial results must not masquerade as complete results.

## Alternatives

A server-wide Search endpoint would provide better global ranking and avoid request
fan-out, but requires a new authorization/query contract. A presentation-owned
Promise fan-out would spread workflow knowledge into views and violate the Effect
boundary. The existing Search Module provides the required Depth and Locality for
this increment without a new Seam.

## Limits

Results are grouped by Project, not globally ranked. Work scales with the number
of selected Projects. Filters are keyword, Team, and Project; member, Agent, and
date filters require server support and are not simulated on a partial page.
The next increment should add a server-owned global query when fan-out latency or
cross-project relevance warrants it.
