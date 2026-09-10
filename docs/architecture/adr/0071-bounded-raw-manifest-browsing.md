# ADR-0071: Bounded Raw manifest browsing

- Status: Accepted implementation detail of ADR-0059
- Date: 2026-09-11

Repeated source observations retain immutable Raw objects independently of the
current Canonical head. Loading every object to open the drawer would make the
read path grow with archive history, even though capture and content writes are
bounded. A valid 3 MiB chunk also expands beyond the Browser HTTP default 2 MiB
response allowance.

## Interface and alternatives

The Raw Archive Module exposes `OpenSessionPage(session, cursor, limit)` with a
50-object default and a 100-object maximum. Its existing metadata Seam gains an
exclusive position and bounded result count. PostgreSQL returns at most one page
plus one lookahead through an index; the memory Adapter retains at most that
bounded selection while scanning its development-only map. This preserves Depth
and Locality: callers do not coordinate authorization, sorting or cursor encoding.
Tests exercise the same Archive Interface with both concrete Adapters.

Keeping the old all-object Interface and paginating in the browser was rejected
because it does not bound database, transport or browser allocation. Offset pages
or ordering by mutable `captured_at` were rejected because appending to an old
object can move it across the cursor and cause omissions or duplicates. Pure ID
ordering is stable but does not present useful arrival chronology.

The selected keyset order is immutable server `created_at DESC, id DESC`, indexed
by Session. Appending a generation updates summary metadata but never moves the
object. This changes list ordering from reported capture time to first receipt
time; the displayed capture timestamp remains unchanged. Each page is a current
read, not a cross-request snapshot. Refresh sees newly arrived objects; concurrent
insertions and clock changes do not provide a frozen archive inventory.

Cursors are opaque bounded Base64URL JSON, versioned and scoped to one Session,
with an exclusive timestamp/object position. Unknown fields, trailing payloads,
invalid identities, oversized cursors and cross-Session reuse fail validation.
Cursors confer no authority: every page rechecks current Session access in the
read transaction. Raw remains independent of selected Canonical membership.

Legacy calls without `limit` still return a complete archive up to 100 objects.
Larger archives return `409 pagination_required`, never silent truncation. HTTP
requires `limit=1..100` to opt into paging; `cursor` requires an explicit limit.
Duplicate, unknown and empty query values are rejected.

## Browser behavior

The drawer requests 50 manifests, renders one page, and resets object selection
when changing pages. `rawCursor` is URL state, preserving browser back/forward;
first/next controls do not accumulate an object list. Each read uses a single
complete-key atom family, matching the conversation reader. Nested weak families
were observed restarting large-object requests under GC pressure on browser back;
the complete key preserves the mounted request identity. Raw still loads only when
opened explicitly, and closing removes Raw URL state.

Content requests use one chunk. A dedicated successful-response profile allows
5 MiB, enough for Base64 expansion and metadata of a legal 3 MiB chunk; streaming
reads cancel above the bound. Errors keep the default 2 MiB allowance. This does
not enlarge other endpoints. Existing legacy generation selection and content
navigation remain separate from the manifest-page bound; this ADR does not claim
a process-wide browser memory ceiling.

## Verification and scope

One shared Archive contract runs against memory and actual PostgreSQL: over 100
objects, legacy refusal, bounded complete walks, old-generation append stability,
new-object refresh and strict scoped cursors. PostgreSQL also verifies membership
revocation between pages. HTTP tests verify opt-in queries, bounds and complete
walks. Browser transport and real browser tests verify on-demand loading,
selection reset, navigation and a full 3 MiB content chunk; stream tests verify
oversize cancellation and the smaller error bound.

This increment enables bounded browsing of captured history. It does not register
OpenCode, select capture admission defaults, publish packages or deploy migrations.
Journal metadata capacity and installed-artifact/platform acceptance remain gates.
