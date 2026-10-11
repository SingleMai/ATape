# ADR-0119: Static release discovery and explicit cache freshness

Status: Accepted (2026-10-11)

Extends [ADR-0108](0108-compatible-release-bundle-discovery.md) and
[ADR-0115](0115-explicit-capture-migrations.md). This decision changes metadata
delivery and retry behavior, without changing capture contracts or migration
plans. Integration, static deployment and npm publication remain separate.

## Problem and alternatives

Anonymous GitHub API requests share an IP-based quota. A local update timer can
therefore encounter a quota exhausted by unrelated applications. Persistent
backoff preserves collection, but delays discovery. Repeated exact-version
requests also spend network budget on identities already verified and retained.

Three materially different distribution Interfaces were considered:

1. Give every installation a GitHub credential. This adds credential management
   and does not belong in unattended initialization.
2. Proxy GitHub requests through a dynamic service. This moves quota pressure to
   one service and adds runtime availability to discovery.
3. Publish the existing strict catalogs and immutable bundle descriptors as a
   complete static snapshot on an owned CDN hostname. This is selected.

Cloudflare Workers Static Assets serves the snapshot without a dynamic Worker.
The publisher reads GitHub only during publication. Existing immutable clients
retain the GitHub catalog bridge; new clients use the static origin and do not
fall back to the quota-limited API. Public package archives remain on npm.

## Module boundaries and Interface

The domain Module owns the existing catalog/bundle Schemas and shared static URL
layout. The discovery Module retains its small `latest`, `exact` and scoped
artifact Interface. Its Node Adapter hides bounded HTTPS, validated durable
receipts and transport retries. It gains Depth by keeping these rules out of
setup, manual maintenance and background callers. GitHub, npm and Cloudflare are
real remote dependencies at their respective Seams.

`latest` returns both a complete bundle and explicit `fresh`/`stale` freshness.
The AutomaticUpdates Module owns the scheduling consequence. A verified stale
bundle may still be prepared, but failed refresh uses the persisted transient
backoff instead of recording a successful 24–30-hour discovery interval. This
preserves Locality; the Node Adapter does not secretly alter the application
schedule. Freshness never changes compatibility or package integrity.

Catalogs live at `/catalog/v1.json` and `/catalog/v2.json`; immutable descriptors
live at `/releases/<version>/bundle.v1.json` and `bundle.v2.json`. Catalog and
manifest responses require revalidation. Exact descriptors may be cached
indefinitely because same-version mutation is rejected. A publisher-only
`manifest.json` binds the full retained file inventory and hashes; it is not a
new client protocol or a cryptographic signature.

## Publication and recovery

Finalize and verify public npm bytes, the versioned GitHub Release and legacy
catalog advertisements before exporting the static snapshot. Validate strict
catalogs, immutable descriptors, historical routes and public npm bytes before
deployment. Historical bundles retain their original valid package sets; the
current producer's eight-package requirement is not applied retroactively.

Each deployment includes all retained exact descriptors and replaces the static
snapshot as one Cloudflare deployment. Serialized publication and monotonic
comparison with the current public snapshot reject old writers, deleted routes,
revision regression and rewritten exact versions. Metadata-only recovery can
re-export published releases without republishing npm. Missing or corrupt state
is not treated as a new empty site after adoption.

The HTTPS origin remains the metadata authority, with canonical npm URLs and
SHA-512 verification binding installed bytes. Static JSON and hashes do not add
signed metadata or expiry protection against a compromised origin. No dynamic
proxy, client token, remote command or log recall is introduced.

## Cache, retry and verification

Retain bounded owned local state and existing monotonic floors. Reuse fresh
catalogs for up to twelve hours when caching is requested. A transport failure
may reuse a verified expired catalog, while malformed or regressed metadata must
fail. An explicit uncached check reports refresh failure. Exact receipts are
reused only when their contract and migration authority are sufficient; a v1
receipt cannot erase an adopted v2 plan.

Retry transient metadata transport/status failures at most three times within
one ten-second request budget, including body reads and delay. Honor a bounded
Retry-After only when it fits the remaining budget; otherwise defer to the
persisted automatic schedule. Cancellation interrupts both reads and delays.
Cached lookups with valid saved state return it after the first transport failure
instead of spending a short display caller's remaining time on retries.
Corruption, integrity failures, unsupported metadata and ordinary missing
resources do not receive transport retries. Existing size limits, artifact
leases and handoff bounds remain in force.

Verify the caller Interfaces for cache freshness, stale scheduling, cancellation,
retry exhaustion, immutable receipts, v2 adoption and regressions. Exercise the
installed executable against controlled static metadata. Verify the actual
public snapshot and response behavior separately after deployment. Neither
controlled HTTP checks nor static deployment establish delivery of this code to
already-published clients; that requires a later authorized package release.
