# ADR-0060: Independent Raw authority and immutable chunk receipts

- Status: Accepted implementation detail of ADR-0059
- Date: 2026-09-10

Publication recovery must finish Raw from an older activated capture after a
new Canonical head. It must also distinguish a lost successful upload response
from an uncommitted obligation, without reading remote Raw bodies.

## Decision

Raw Archive keeps its existing immutable Chunk Store and transactional manifest
Seams. Publication uploads additionally bind the original activation head and a
Raw authority version. The storage boundary verifies an actually activated
capture, the stable Session lifecycle and the authenticated user/installation/
Adapter binding. It never compares that head with the current Canonical head or
borrows the current Canonical writer fence.

Raw authority is independently fenced by Team policy and personal preference
revisions. A changed policy value advances its revision in the same transaction;
an identical setting does not. `force` uses personal revision zero, so changes to
an ignored personal preference cannot revoke forced capture. The effective policy
and relevant revisions are checked before blob writes and under policy locks in
the manifest transaction. Off/on cannot make an old authorization current again.
This is an authority version, not a new timestamp-based lease or source revision.

Publication Raw objects bind their activation and authority immutably and permit
one generation. A new observation uses a new object identity. A caller cannot
reuse an old object under another activation or re-sign it after authority changes.
Existing legacy Sessions preserve their append/generation protocol; publication
Sessions require the additional proof, so legacy upload cannot bypass this gate.

An immutable chunk receipt contains the submitted source identity, committed
offset/length/digest/final marker and publication binding. A bounded caller-scoped
metadata lookup returns that actual receipt even when Raw is now disabled; it
still checks current account, ownership and Session access. It neither fetches
blobs nor grants new upload authority. Unknown lookup is not an ACK. The Collector
can retain real receipts, cancel the remaining obligations, and record gaps.

After re-enabling, fresh source observations can use current Raw authority and
an existing genuine activation proof without replacing Canonical solely to add
Raw references. A previous Raw-off Canonical reference remains unavailable.

## Alternatives and scope

Reusing the current Canonical fence would revoke unfinished Raw on every new
head. A second independent expiring writer lease would add takeover/re-signing
work to already immutable chunk identities. Policy revisions plus immutable
object ownership concentrate authorization in Raw Archive and enforce the
required off/on boundary without another renewal workflow.

This extends the existing deep Module rather than returning authorization and
receipt steps for HTTP handlers to coordinate. PostgreSQL/HTTP tests exercise the
public Interface and real Chunk Store. Native source preparation, Collector Raw
orchestration and bounded archive browsing remain separate delivery increments.
No package publication, instance deployment or production migration is implied.
