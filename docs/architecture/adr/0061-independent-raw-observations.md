# ADR-0061: Independent fresh Raw observations

- Status: Accepted implementation detail of ADR-0059 and ADR-0060
- Date: 2026-09-10

A Canonical capture prepared with Raw disabled cannot later acquire old source
bytes or have its references rewritten to imply historical archive coverage.
Re-enabling Raw must allow a fresh observation of rows still present without
replacing an unchanged Canonical target.

## Decision

Reuse the capture journal with an explicit immutable purpose: `publication` or
`raw-observation`. Format 3 adds this discriminator transactionally after verifying
the account/installation binding; existing format 1 and 2 captures retain publication
purpose, bytes, receipts and checkpoints.

A Raw observation begins from a locally retained, genuinely activated Canonical
capture of the same source scope. The workflow obtains current enabled Raw policy and rechecks its original proof through
the authenticated Server Interface and freezes that proof with a new observation
identity and current Raw authority. This is a metadata operation: it creates no
Canonical reservation, Begin or activation and selects no new head. The Host then
freshly reads, validates, redacts and appends bounded Raw units. No source content
is recovered from the old Raw-off capture.

The journal permits only Raw units for this purpose and seals exactly the declared
nonempty unit set. It requires existing Canonical coverage and an unchanged input/
output checkpoint. Recording the reused activation proof never writes the Canonical
checkpoint. Unsealed restart abandons the incomplete observation; sealed restart
uses its frozen proof and bytes with the existing bounded Raw recovery operation.
Raw receipt checks, independent authority, policy cancellation and payload cleanup
have the same semantics for both capture purposes.

Raw manifest hashing chains fixed pages of at most 100 unit metadata rows, starting
from 64 zeroes and hashing the previous hex digest, newline and ordered
`ordinal:byteCount:digest\n` lines for each nonempty page. It retains one metadata
page in memory. The journal stores every immutable unit identity, digest and byte
count; no Server aggregate Raw manifest is introduced. The Canonical wire manifest
keeps its existing bounded ordered-concatenation hash.

## Interface and alternatives

`beginRawObservation`, `sealRawObservation` and the existing
`deliverPublicationRaw` form the application Interface. Their Implementation owns
proof binding, frozen intent, manifest validation and restart routing. The journal
owns purpose restrictions and checkpoint invariants independently of workflow JSON.
Tests call these Interfaces with real SQLite and actual HTTP/PostgreSQL.

A fake Canonical part would confuse content publication and archive observation,
including checkpoint advancement. Attaching Raw to an old Raw-off capture would
break its immutable policy and unit set. A second journal would duplicate binding,
quota, ownership and recovery behavior across a new Seam. Explicit purpose keeps
these responsibilities local to the existing deep Module.

This increment does not allocate source record revisions, assert Raw source
coverage, schedule source observations or enable OpenCode. Those Host responsibilities
must still distinguish newly observed bytes from previous projections and retain
canceled archive gaps. No package publication or deployment is implied.
