# ADR-0084: Compact Overview options and operation diagnostics

- Status: Accepted
- Date: 2026-09-13

## Context and alternatives

Overview filter choices reuse statistic rows with empty counters. Removing those
fields unconditionally would break existing Web decoders. Keeping them forever
wastes response capacity, even when no matching Sessions exist.

1. Change the default response and require coordinated Web/Server rollout.
2. Let new Web clients request `options=compact`, retaining the default legacy
   representation in the HTTP Adapter. Both read the same Module result.

Choose option 2. The Module exposes narrow `Option` values; the HTTP Adapter
translates them to legacy rows only when compact options were not requested.
New Web decoders accept both representations, and older Servers ignore the new
query parameter. No persisted data or statistics semantics change. This keeps
compatibility Locality at the transport Seam and avoids a second query Module.

## Diagnostics and lifetime

Overview operations have a 12-second execution budget; earlier caller deadlines
and cancellation win. Persistence query cancellation and aggregation checkpoints
share that context. Timeouts remain `service_unavailable` with no partial result.
Transaction rollback uses a separate one-second cleanup deadline so an expired
read cannot leave unbounded cleanup work.

The PostgreSQL Adapter measures connection acquisition, directory/authorization,
Usage, Events, model options, unknown-time disclosure, selection and previews.
Diagnostics accompany the internal result, including errors, but are not JSON
business fields. The Module records total and aggregation durations. The HTTP
Adapter emits a structured completion log correlated to the existing request ID.
OpenTelemetry operation spans carry stage durations when an exporter is supplied
by the executable; this increment does not install a tracing backend.

## Limits

Unknown-time disclosure still covers all retained Team messages. Its query reads
only kind and occurrence time from the selected publication head. Both periods
still use bounded facts; this is not SQL aggregation or a statistics read model.
Compact options reduce payload but do not paginate large option directories.
See the [current guide](../../team-overview.md) for verification and next work.
