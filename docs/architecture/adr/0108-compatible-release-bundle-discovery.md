# ADR-0108: Compatible release bundles and persistent discovery

Status: Accepted (2026-10-10)

Extends [ADR-0107](0107-independent-update-control.md). This decision covers
same-capture-contract delivery. Acceptance does not establish publication,
cross-contract migration or native lifecycle acceptance.

## Problem and alternatives

Automatic updating reads GitHub Latest; manual CLI and official Adapter updates
read separate npm tags. Initialization also installs unversioned official
packages. Publication propagation can produce different versions, and one Latest
pointer cannot permanently route different capture contracts.

Two materially different Interfaces were considered:

1. Keep independent lookups and check compatibility after installation. This
   repeats release knowledge and discovers incompatibility after replacement.
2. Discover an immutable complete ReleaseBundle before preparation. A persistent
   catalog routes each supported control/capture pair and exact descriptors serve
   installation and repair. This is selected.

The pure protocol belongs in domain. Node and publication Implementations consume
the same Schema and rules. GitHub/npm are true external dependencies with real
transport Adapters at the Seam; filesystem receipts and archives stay private
local-substitutable dependencies. The discovery Module gains Depth by hiding
transport, completeness, compatibility, caching and byte verification. Removing
it would spread those rules into automatic, manual and Adapter callers, reducing
Locality and Leverage.

## Interface and invariants

`atape.release-bundle.v1` contains one stable version, its opaque capture contract,
update-control protocol and the seven required public packages, each with SHA-512
integrity and a canonical public npm tarball URL. Every package uses the bundle
version. The v1 reader accepts up to 32 unique `@atape/*` packages so adding an
official Adapter does not strand older readers. The required base seven remain
fixed independently of the producer's current package list. Every package,
including an unknown addition, participates in the immutable fingerprint;
readers install only their already-configured eligible Adapters.
`atape.update-catalog.v1` contains a monotonic revision and compatible
latest bundles by control/capture pair. Same-version different bytes and family
regression are refused.

The Node Interface exposes `latest`, `exact` and scoped artifact acquisition with
the caller's compatibility fixed at construction. Latest reads fixed prerelease
tag `atape-update-catalog-v1`; each versioned GitHub Release retains its descriptor
in a unique delimited body section. Bounded Schema decoding, deadlines and a
durable last-valid cache remain private. Unavailable or unknown metadata does not
start maintenance; cache cannot move a reader floor backward.
Publisher preflight limits each JSON-encoded descriptor/catalog body to 128 KiB,
leaving room for GitHub's envelope within the client's 256 KiB metadata limit.
Public archives share the client's 16 MiB acquisition limit.

An exact lookup for the running CLI may derive its bundle from all seven exact
public npm manifests during first-publication descriptor propagation. It verifies
the CLI contract/control capability and every identity/integrity. This is not a
Latest fallback and does not advertise another automatic target.

Automatic target/prepare and manual latest/install carry the full bundle. npm
receives a locally acquired verified archive: installed bytes must match the
descriptor, not only a prior metadata request. Archive lifetime is scoped and
cancellation joins npm before cleanup. Existing immutable generations and bounded
handoff remain the update coordinator's responsibility.

Initialization, official tool addition, Git repair and single-Adapter maintenance
target the exact running CLI version. Central installation rejects another
resolved official registry version before Host refresh or configuration commit.
Local, URL and custom sources retain original-source semantics. Development builds
do not implicitly install official registry releases.

Manual CLI upgrading prepares and activates the complete managed bundle through
the automatic coordinator's Interface. Global npm command-entry refresh remains
a separate verified operation under the same ownership. Refresh failure reports
that the runtime already advanced and remains retryable; the actual command-entry
version determines whether refresh is still needed.
If npm or direct verification reports failure before durable rebinding changes
control, restore the original runnable entry, manifest and bin link with a
15-second budget. Once control advances, retain the verified new bootstrap for
forward recovery. This does not make global npm replacement crash-atomic.

## Publication and historical clients

One publication Module owns ordering. Repository publication runs serialize in a
fixed concurrency group. Anonymously retrieve all seven exact manifests and
tarballs, compare with verified local artifacts, and retry bounded propagation
failures before advertising a version. Existing npm bytes, Release descriptors
and catalog entries must match on rerun. Publish the versioned Release before
updating the catalog; an older run cannot move a shared target backward.

This same-v2 increment explicitly uses ordinary npm `latest` for a forward
compatible publication. Capable clients use the catalog as activation signal,
so individual tags cannot activate partial bundles. Separate staging/promotion
was considered but requires an additional Trusted Publisher `npm dist-tag` grant;
the established `npm publish` permission does not imply it. This increment does
not silently add that prerequisite. Historical unversioned installation behavior
cannot be retroactively changed.

Before offering another capture contract, retain a genuine catalog-capable v2
bridge at legacy GitHub Latest and npm latest. Incompatible releases must use
another npm tag and must not become GitHub Latest. This increment does not support
or authorize such publication. A finite bridge window cannot serve indefinitely
offline clients. The mutually exclusive 0.5.3 v1 bootstrap remains separate.

## Verification and remaining work

Verify complete bundles, exact integrity, unknown/corrupt metadata, monotonic
revisions/families, offline cache, first descriptor propagation, package download
delay, idempotent reruns and publication ordering. Exercise automatic, manual and
tool caller Interfaces with real installed tarball bytes and preserve Collector
intent, configuration and checkpoints.

Current feature/release guides own shipped behavior and limits. Fresh
cross-contract bootstrap before setup/authentication, data migrations and Server
prerequisites, independent periodic OS wakeup, and persistent failed-bundle
isolation remain subsequent increments. Transport failure alone cannot permanently
quarantine a release. Native reboot/power-loss acceptance remains separate.
