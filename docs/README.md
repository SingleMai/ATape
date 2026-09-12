# ATape documentation

Start with the [project README](../README.md) to run ATape, or the
[development guide](development.md) to change it. [AGENTS.md](../AGENTS.md) is the
short agent entry point; the architecture manual owns the engineering rules.
Read the guides for the task at hand rather than loading every document.

## Find a guide

| Task | Start here |
| --- | --- |
| Install, connect a first Project, verify sync, upgrade or recover | [CLI setup](cli/setup-and-adapters.md), [first-sync verification](cli/setup-and-adapters.md#confirm-the-first-sync), [upgrades](cli/setup-and-adapters.md#upgrade-the-cli-and-adapters), [troubleshooting](cli/setup-and-adapters.md#troubleshooting) |
| Find code, choose checks, contribute a change | [Development](development.md) |
| Design a Module or change a boundary | [Architecture manual](architecture/README.md), [Deep Modules](architecture/codebase-design.md), [decision index](architecture/adr/README.md) |
| Change TypeScript workflows or presentation | [TypeScript and Effect](architecture/typescript-effect.md) |
| Change the Go Server | [Go](architecture/go.md) |
| Change setup, commands, Tools or local configuration | [Setup and Adapters](cli/setup-and-adapters.md), [CLI user journey](cli/user-journey.md), [CLI package README](../apps/cli/README.md) |
| Change Raw capture policy | [Raw capture](cli/raw-capture.md) |
| Change source collection or add an Adapter | [Package and runtime contract](adapters/package-manifest.md), [Codex](adapters/codex.md), [Claude](adapters/claude.md), [OpenCode](adapters/opencode.md), [CodeBuddy Code CLI](adapters/codebuddy.md) |
| Change atomic publication or recovery | [Capture and publication contract](architecture/opencode-capture-publication.md), [Server publication](architecture/publication-candidates.md) |
| Change the reader, navigation or Search | [Workspace and Search](workspace-search.md) |
| Change Team usage or CLI device reporting | [Team Overview](team-overview.md), [CLI synchronization dashboard](cli-devices.md) |
| Change shared visual primitives or localization | [UI package](../packages/ui/README.md), [localization decision](architecture/adr/0072-localization-boundary.md) |
| Change HTTP behavior | [Authentication](api/authentication-http.md), [Canonical ingestion](api/canonical-ingestion.md), [Conversation reads](api/conversation.md), [Raw archive](api/raw-archive.md), [Workspace](api/workspace.md), [Project Search](api/project-search.md), [OpenAPI](api/openapi-v1.yaml) |
| Operate an instance | [Self-hosting](operations/self-hosting.md), [backup and restore](operations/backup-and-restore.md), [OpenCode rollout](operations/opencode-rollout.md) |
| Operate the dogfood environment | [AWS dogfood](operations/aws-dogfood.md), including automatic Web deployment |
| Migrate an old unauthenticated instance | [v0.1.1 to v0.2 auth cutover](operations/auth-cutover.md); apply only to that source topology |
| Prepare or publish packages | [Releasing](releasing.md), [release metadata](../specs/auth-v1-release.json), [gate index](../specs/auth-v1-release-gates.json) |

For a guided Adapter integration, manually invoke
[`$atape-adapter-integration`](../.agents/skills/atape-adapter-integration/SKILL.md).
This repository skill is explicit-only.

## Current guidance and historical evidence

Feature and API guides describe supported behavior in this checkout. They do not
prove that its code is published or deployed. Versioned [release notes](releases/)
and [candidate evidence](releases/evidence/) record their own scope; a pending
attestation or manual waiver is not a passed acceptance check.

The [ADR index](architecture/adr/README.md) records decisions and their evolution.
An accepted design can precede implementation. Read amendments and the linked
current guide before treating an old decision's delivery status as current.
In particular, the OpenCode capability implements a selected publication path;
it does not imply that every earlier Claude, byte-stream or checkpoint proposal
has been delivered.

Additional acceptance records and references:

- [Production terminal validation](cli/production-terminal-validation.md): dated
  candidate evidence, including unverified platforms and live operations.
- [auth-v1 release checklist](operations/auth-v1-release-checklist.md): manual
  acceptance scenarios originating in v0.2.0; use the current release guide for
  candidate identity, evidence paths and authorization.
- [Architecture sources](architecture/sources.md): background and attribution.

## Keep documentation current

Keep cross-project invariants and task routing in `AGENTS.md`; put detailed rules
in the architecture manual and commands/behavior in their owning guide. Link to
the owner instead of copying a second checklist or status summary. Runtime
requirements come from package manifests; commands from the CLI Interface; numeric
limits and defaults from the owning Module or named contract. Feature guides own
support scope and recovery; release notes own candidate-specific acceptance.
When changing an installation, setup, upgrade or recovery path, follow the guide
from its stated prerequisites and check the observable result. Use isolated package
fixtures for local validation and disclose any live steps that were not exercised.

When behavior changes, update the current summary, compatibility limits and
remaining work together. Consolidate still-relevant content into its owning guide,
then delete superseded plans, research notes and guides and update their links.
Use Git history for earlier document versions instead of keeping a separate
documentation archive. Preserve candidate hashes, waivers and measured release
evidence in release and acceptance records. An amendment to an ADR
should link to the later decision rather than erase the original rationale.

When adding a guide or ADR, add it to the corresponding index. Run `pnpm check:docs`
to verify relative links, headings, command names and index coverage; it also runs
in `pnpm check` and CI. Resolve disagreements using the
applicable decision and code/tests; document a discrepancy rather than silently
treating an implementation bug as a policy change.
