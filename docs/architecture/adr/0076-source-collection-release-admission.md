# ADR-0076: Source collection admission for the first OpenCode release

- Status: Accepted implementation within the owner-approved first release scope
- Date: 2026-09-11

The owner accepted the [evidence-bound first release scope](https://github.com/SingleMai/ATape/issues/114#issuecomment-5629334423):
OpenCode 1.18.30 local v1 SQLite, macOS arm64 and Linux arm64/glibc. Actual schema,
indexes, creation Origin and family coverage still determine source readability.
Other versions/platforms, old JSON and a selected family's nonempty v2/mixed
history receive no compatibility promise. This does not authorize publication.

## Interface and alternatives

The SourceCaptureCollector Module exposes `defaultSourceCollectionLimits` as its
first release admission profile. Its constructor still validates explicit limits.
The Node Composition Root supplies that profile when the environment override is
absent. A present `ATAPE_SOURCE_COLLECTION_LIMITS` must be valid bounded JSON and
pass the same constructor invariants; empty, malformed, oversized or inconsistent
values fail instead of falling back to a larger budget. Layer construction alone
does not discover or open a source or initialize its journal.

Requiring every user to hand-author an environment JSON object was rejected for
ordinary enablement. Leaving numeric defaults to each provider was rejected:
frozen payload, metadata and recovery belong to the Host. One shared profile on
the existing Module Interface gives callers Leverage without exposing journal
or transport sequencing. No new Seam or configuration system is introduced.

## Selected profile

| Concern | Admission |
| --- | --- |
| Source | 1 MiB row, 4 MiB page, 100 rows/page, 100,000 records, 20 Threads, 120 seconds/view |
| Projection | 20,000 Events, 20,000 usage items, 100 frames/page, 4 MiB page |
| Journal payload | 5 MiB unit, 128 MiB target, 256 MiB account pending/retained payload |
| Journal metadata | 1,000,000 account entries; 100,000 records and 4,096 units/target |
| Raw | 3 MiB object, 5 MiB wire unit, 96 MiB target, 4,096 units |
| Comparison | 100,000 records, 120 seconds |
| Recovery slice | 20 sources, 20 captures/source, 64 operations/capture, 32 reclaim units, 15 seconds/source work |
| Outer deadlines | 240 seconds/fresh source work, 600 seconds/cycle |

The source row/page and payload sizes start from the measured capacity profile.
The account metadata ceiling leaves room beyond the single 10,000-Event study's
90,320 peak entries. Source work allows comparison plus preparation; the outer
deadline leaves room to advance beyond a slow source. These are independent
ceilings: admitting 20,000 Events does not promise every such history fits all
byte, metadata and time limits. Server-advertised admission still applies and may
be smaller. Existing bounded Collector job concurrency remains unchanged.

Payload admission is neither a physical SQLite file cap nor an RSS cap. SQLite
page overhead and reuse, retained proof metadata and concurrent jobs are separate
costs. Existing overload handling preserves the old selected head and pending
obligations; it never discards unconfirmed data to admit another capture. Safe
membership retirement and real receipt-based content reclamation remain in force.

## Failure semantics and verification

The foreign Host boundary preserves a typed `sourceFailureReason` on an
AdapterRuntimeError. Source collection uses it for the existing source diagnostic
Interface, so an oversized row is a `limit`, uncertain Origin an `attribution`,
and unsupported layout a `format`. It does not parse human error messages or trust
arbitrary provider reason strings; lifecycle, authentication and transport error
handling retain their existing behavior.

Tests verify that the normal Node composition provides collection without an
environment override and still rejects invalid overrides without creating local
progress. A real OpenCode runtime/Host boundary and SourceCaptureCollector perform
three complete 1,000-Event, 1 KiB text observations with real SQLite and explicit
owned remote TestAdapters: 999 unchanged Event Raw references remain stable;
unchanged polling sends nothing; an oversized source row leaves the prior head
intact and reports `limit`. The installed CLI background HTTP/PostgreSQL contract
now omits the admission environment override, exercising the shipped default.
The separate 10,000-Event capacity studies remain simulated-ACK observations,
not an HTTP throughput guarantee or a final release-candidate platform test.
