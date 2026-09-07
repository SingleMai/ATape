# ADR-0032: Claude release artifacts and checkpoint recovery

Status: Accepted and implemented

## Decision

Claude joins the existing release contract alongside CLI and Codex. One catalog
drives version checks, packing, checksums and sequential npm publication; the
release workflow also attaches the Claude tarball. Both Adapters share the same
four-file/self-contained package verification. No alternate installer or release
workflow is introduced.

The Claude Adapter resumes only cursor formats its current Implementation decodes,
then verifies the committed source prefix exactly as before. Package-version
changes alone are no longer rejected. The existing Adapter Interface keeps cursor
recovery local to that Adapter; the Host continues preserving state and committing
its version after successful collection. Unknown schemas and changed prefixes are
not reset or accepted by this change. A future breaking cursor format requires
explicit migration or rejection, not forced compatibility.

## Alternatives

- Retain exact package-version equality: fails even for packaging-only changes and
  prevents usable upgrades without a new recovery path for every version.
- Maintain a growing package-version allowlist: exposes release bookkeeping as
  recovery semantics and promises compatibility independent of the actual data.
- Validate the supported cursor format and source invariants (selected): keeps
  recovery Depth and Locality inside the Adapter, without a new Seam or any
  server knowledge of Claude versions.

## Verification boundary

The exact release CLI installs and captures using an isolated test-only Claude
package, then runs the ordinary upgrade command against the release tarball.
The fixture bundle is re-versioned from the candidate, not downloaded from an old
release. It proves artifact replacement, checkpoint preservation, stable Event
identities, no duplicate upload and continued append capture; it does not prove
compatibility with historical Claude or ATape binaries. Unknown-schema and
changed-prefix rejection are tested through the production Adapter Interface.
Packaged network verification uses an authenticated loopback HTTP test Adapter;
the separate real CLI/Go suite covers persistence and existing reader APIs.

Artifacts, credentials and source data in this verification are temporary and
isolated. No tag, package publication, staging attestation or deployment is implied.
