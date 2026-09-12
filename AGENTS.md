# ATape Engineering Guide

ATape captures coding-agent conversations through a local CLI and provider Adapters,
with a Go Server and Web reader. Complete the requested change with evidence for
its behavior and an accurate account of any remaining limits.

## Find the relevant context

- [docs/README.md](docs/README.md) routes tasks to current feature guides, API contracts, operations and release evidence.
- [docs/development.md](docs/development.md) maps the checkout and verification commands.
- Before changing production code, read [docs/architecture/README.md](docs/architecture/README.md), [Codebase design](docs/architecture/codebase-design.md), and the language guide for the area you are changing: [TypeScript](docs/architecture/typescript-effect.md) or [Go](docs/architecture/go.md).
- Read the feature guide and relevant ADRs for the affected behavior. ADRs and candidate validation records describe their recorded scope; they do not establish current implementation or release status.

## Architecture invariants

The following rules are mandatory:

- Design deep Modules: keep the Interface small and hide substantial behavior in the Implementation.
- In architecture discussions and reviews, use Module, Interface, Implementation, Seam, Adapter, Depth, Leverage, and Locality as defined in the architecture manual.
- Presentation code translates input and output. It does not own business rules, persistence, retries, or distributed workflows.
- TypeScript uses Effect for side effects, dependency requirements, typed failures, resource lifetime, and asynchronous workflows.
- Go uses ordinary Go Modules. Fx is allowed only in the executable Composition Root.
- Do not introduce an Interface or Seam merely to make mocking convenient. A varying production implementation, a remote dependency, or a justified test Adapter must make the Seam real.
- Test behavior through the same Interface used by callers. Do not couple tests to private orchestration.
- Canonical conversation data, Raw source data, and the Search read model remain separate concerns even when one workflow coordinates them.

If a change needs an exception to these architecture rules, record the reason in
an ADR before implementing it. Routine choices within the rules do not require
a new ADR or additional approval.

## Completion and verification

- Continue authorized work through implementation, relevant verification and documentation. Ask only when missing information materially changes scope, correctness or authorization and cannot be resolved from the available context.
- Verify changed behavior through the caller's Interface. Choose checks using [the development guide](docs/development.md#verification); broaden them for affected boundaries or unresolved failures. Required PR and release gates still apply.
- Update the current feature guide when behavior, compatibility or limitations change. Keep decision rationale in ADRs and candidate evidence in validation/release records.
- Consolidate relevant content into its owning guide, then delete superseded documents and update their links. Use Git history for earlier versions; do not create a documentation archive.
- Report the result, checks actually run and material limits. Distinguish implementation, integration, publication and deployment; do not claim an unperformed check passed.

## Delivery cadence

- Finish one usable implementation increment, verify its changed behavior, and
  land it through the repository's pull-request checks before expanding the next
  increment when the user has requested integration.
- Start integration from the latest main branch. Preserve concurrent changes and
  reconcile migration numbers, ADR numbers and generated code before merging.
- Keep local research prototypes out of implementation commits. Record the shipped
  scope, remaining limitations and next increment in the relevant feature guide.
- Merging code, publishing packages and deploying an instance are separate actions.
  Do not infer publication or deployment authorization from a request to merge.

## Release authorization

When the user explicitly requests package publication, that request also authorizes
waiving incomplete manual staging acceptance for the requested release. Do not ask
for a separate per-version waiver confirmation. Record the request in candidate-bound
release evidence and disclose every unverified manual check in the release notes.
Automated CI, integration tests and security gates must still pass. A generic coding
or merge request does not authorize publication. Publication does not authorize
Server deployment or database migration. See [ADR-0048](docs/architecture/adr/0048-release-request-manual-acceptance.md)
and the [release guide](docs/releasing.md).
