# ADR-0075: Confirmed Canonical progress in Collector checkpoints

- Status: Accepted implementation within the existing source collection contract
- Date: 2026-09-11

Source collection deliberately leaves the legacy `rawObjects` checkpoint empty.
After a successful publication, its next unchanged cycle reports zero batches.
The CLI experience therefore forgets that the Project has captured history and
returns to first-conversation waiting.

## Interface and alternatives

Add optional `canonicalPublished: boolean` to the existing CollectorCheckpoint
Interface. The SourceCaptureCollector Implementation owns this monotonic progress
fact within the checkpoint's account, Project registration and Adapter binding.
It becomes true only after confirmed Canonical activation, or recovery of an
existing source owner whose journal checkpoint already proves activation.
Discovery, local preparation, content ACKs and unconfirmed remote success do not
establish publication. The flag is observational: it never advances source
coverage, authorizes delivery, replaces receipts or drives Raw cleanup.

Having CLI inspection open and claim journal sources was rejected: inspection
would need capture admission, learn source recovery internals and fence a running
Collector. Parsing the private source cursor was also rejected: discovery progress
is not publication evidence. One fact on the existing Interface preserves Module
Depth and Locality without a new Seam, journal query API or Presentation workflow.

## Persistence, recovery and compatibility

Persist the flag with the existing revision-fenced JSON checkpoint. Missing or
false means no confirmed progress is recorded there. Existing state remains
decodable without a format change. A source owner recovered through the existing
bounded journal walk repairs a missing flag even if its provider file has gone.
If activation succeeds before Collector JSON can commit, the journal remains the
authority and the next recovery restores this derived fact. No source reread or
new Canonical publication is required for the repair.

CLI experience accepts the flag only for the current Project registration, and
retains the legacy Raw-object progress signal for existing Adapters. Current
failures, stopped collection, partial work and queued/running work keep their
existing precedence. A successful historical capture does not claim that the
latest collection succeeded or that all Raw obligations have completed.

Tests use the public SourceCaptureCollector, real SQLite journal and persisted
CollectorStateStore, plus the owned remote TestAdapters. They cover Raw-off
publication, a later empty cycle in a fresh runtime, absent-field compatibility,
lost activation receipt recovery after source deletion, and no false progress
from empty discovery or a failed first read. CLI experience tests cover both
progress forms, Project registration boundaries and later failure/stopped states.
