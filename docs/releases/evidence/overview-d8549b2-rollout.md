# Overview rollout: d8549b2

This record covers the hosted `atape.net` Server and Web rollout on
2026-09-13 UTC (2026-09-14 in Asia/Singapore). It does not authorize or attest
package publication. The current behavior and next increment belong to the
[Team Overview guide](../../team-overview.md#indexed-publication-facts-and-operations).

## Candidate and gates

- Commit: `d8549b2e84a3a40644028e239a2d84770add17f2`, merged through
  [PR #168](https://github.com/SingleMai/ATape/pull/168).
- Server identity: version `0.5.2`, auth epoch `auth-v1`, minimum CLI `0.5.2`.
- ARM64 image digest:
  `sha256:d1bf10f6121d306027fc41ee901cf44999c3065165b83f7435b0b75b7413353f`.
- [Main CI](https://github.com/SingleMai/ATape/actions/runs/34737515301)
  passed on attempt 2, including PostgreSQL/installed Adapter contracts and
  physical disk exhaustion recovery. Attempt 1 failed two CLI timing tests;
  no code or timeout thresholds were changed for the rerun.
- [Security](https://github.com/SingleMai/ATape/actions/runs/34737515263)
  passed on this commit.
- [Web deployment](https://github.com/SingleMai/ATape/actions/runs/34767902690)
  passed and served the same commit.

The user explicitly continued the proposed Server deployment, migration and
bounded backfill. No package publication was performed by this rollout.

## Recovery and deployment

A paired PostgreSQL custom dump and Raw archive was created at
`/opt/atape/backups/overview-d8549b2-pre-schema20` before migration. Its manifest
records schema 19 and creation at `2026-09-13T16:03:35Z`; the backup occupied
263 MiB. PostgreSQL archive-list and Raw archive structure checks passed.
An encrypted EBS snapshot containing that completed backup also reached
`completed`. The previous image and configuration were retained for rollback.
This particular recovery point was not restored in an isolated environment.

The rollout used the complete base/publication/pinned-Web Compose topology,
shared the Web deployment lock, and checked that the Server image and
configuration had not changed since preparation. It replaced only the Server
container, reloaded the Web proxy to resolve the new container, and verified
readiness. A failed readiness check would restore the previous image pin;
that rollback path was not exercised on this successful live rollout.

Server rollout completed at `2026-09-13T16:14:13Z`. Startup applied additive
migration 20 without a data backfill in the migration transaction. Initial
coverage reported six retained parts and six missing current-head parts.
Two operator invocations, paced at 250 ms between parts, acknowledged two and
four completed parts respectively. Subsequent status checks reported:

```json
{"retainedParts":6,"missingParts":0,"currentHeadMissingParts":0}
```

The projection contained 189 message facts and 698 Usage facts, using 616 KiB
including indexes. Database, Server and Web were healthy; the sampled lock-wait
count was zero and root disk utilization was 64%. These observations are point
samples, not sustained write/load acceptance. New native Canonical activity
continued during validation, so live totals can change between requests.

## Authenticated behavior and latency

Measurements used the existing logged-in browser against the public HTTPS
endpoint. The original `overview?days=30&page=0` request timed out after
15,001 ms before deployment. After deployment and complete backfill, three
sequential requests returned HTTP 200:

| Sample | Browser request round trip | Overview Module duration |
| --- | ---: | ---: |
| 1 | 858 ms | 518 ms |
| 2 | 979 ms | 468 ms |
| 3 | 817 ms | 469 ms |

Browser round trips include browser-tool overhead and the public network.
Module durations come from `Server-Timing` and exclude authentication,
serialization and transmission. These are small warm samples, not HTTP P95
or a throughput guarantee, and cannot isolate the contribution of each change.

A fixed `from=2026-08-15&to=2026-09-13` comparison returned identical business
fields across partial and complete backfill, excluding only response
`updatedAt`. The comparison included current/previous metrics, trends,
dimension tables, choices, Session rows/previews and unknown-time disclosure.
Complete coverage repeated the same result. Legacy and compact choices
produced identical remaining business fields. The Session-only page matched
every shared field of the full Overview for page 1. Project-filtered rows
belonged to the selected Project; Project and model queries returned HTTP 200
in 622 ms and 606 ms respectively. Reloading the deployed Web rendered the
30-day Overview normally.

The first request after Server replacement, before any backfill, returned
HTTP 503 at the 12-second Module budget: Events consumed about 11.6 seconds.
After two parts were covered, the fixed-range request returned HTTP 200 in
5.3 seconds; complete coverage returned in about 1.0 second. A subsequent
read-only SQL probe forced the full JSON fallback without changing coverage
markers and completed the Events query in about 375 ms with warm data.
That probe used a UTC window rather than the exact browser-local boundaries
and was not an end-to-end request. Initial cache state, host conditions and
backfill were not independently controlled; the initial slow read remains a
material cold-start/rollout acceptance limit rather than proof of a persistent
fallback join defect.

## Remaining limits

- Cold-cache requests, concurrent HTTP load, WAL/write amplification and
  sustained reclamation were not accepted in this live rollout.
- Fresh publication Validate/Activate projection behavior is covered by
  integration contracts; no new publication was created solely for this check.
- Existing fact and directory limits remain. Most measured Events are native
  Canonical records; adding publication indexes does not remove their transfer
  or Go aggregation cost.
- The next increment remains database aggregation and Session page selection,
  with result-equivalence verification. No additional cache, background
  backfill worker or new tracing backend was introduced.
