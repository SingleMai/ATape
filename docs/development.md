# Developing ATape

Use the [root README](../README.md#run-locally) for installation and local startup.
The runtime requirements are in [package.json](../package.json) and
[server/go.mod](../server/go.mod); workspace library versions are pinned in
[pnpm-workspace.yaml](../pnpm-workspace.yaml) and the lockfile. Install with
`pnpm install --frozen-lockfile`. Browser checks use Playwright Chromium;
`pnpm --filter @atape/web exec playwright install chromium` installs it locally.
Package terminal checks require Python 3. PostgreSQL and installed OpenCode
integration checks require Docker.

## Code map

| Area | Responsibility and entry points |
| --- | --- |
| [apps/web/src](../apps/web/src/) | `view` renders, `presenters` bind intents and ViewModels, `runtime` provides Browser Adapters and Layers |
| [apps/cli/src](../apps/cli/src/) | `main.ts` composes the executable; `commandInput.ts` decodes command input; `commands.ts` and `interactive` present the CLI; `runtime` owns Node Adapters |
| [packages/application](../packages/application/) | Effect Modules for client management, collection, capture, publication, recovery and reader workflows |
| [packages/domain](../packages/domain/) | Shared domain types, Schemas and pure rules |
| [packages/adapter-catalog](../packages/adapter-catalog/) | Shared official-tool metadata |
| [packages/ui](../packages/ui/README.md) and [packages/i18n](../packages/i18n/) | Reusable presentation, semantic themes and localization support |
| [adapters](../adapters/) | Codex, Claude and OpenCode provider Implementations; the Host loads their declared runtime capability |
| [server/internal](../server/internal/) | Go Modules for authentication, authorization, Team, Canonical ingestion, publication, conversation, Raw and Search; private infrastructure under `adapters` |
| [server/cmd/atape-server](../server/cmd/atape-server/) | Server Composition Root and process lifetime |
| [specs](../specs/), [scripts](../scripts/) and [workflows](../.github/workflows/) | Machine-readable contracts, verification, packaging and delivery gates |

These are existing ownership boundaries, not a template for adding pass-through
Modules. The [architecture manual](architecture/README.md) defines the rules;
the [documentation index](README.md) routes to feature-specific contracts.

## Verification

Choose checks for the changed Interface and its consumers. Examples below are
starting points for local work; they do not replace required integration or
release gates. Use the package's `test` script with a test path to focus a
regression when appropriate.

| Changed area | Relevant local checks |
| --- | --- |
| Documentation only | `pnpm check:docs` and `git diff --check`, plus review of status claims; for release guidance also run `pnpm test:release:gates` |
| TypeScript Module or import boundary | `pnpm check:architecture`; affected package `typecheck` and `test`, e.g. `pnpm --filter @atape/application typecheck` and `pnpm --filter @atape/application test` |
| Web behavior | `pnpm --filter @atape/web typecheck`, `pnpm --filter @atape/web test`, and affected `test:browser` scenarios |
| CLI commands or terminal behavior | `pnpm --filter @atape/cli typecheck`, `pnpm --filter @atape/cli test`, `pnpm test:cli-package` for the installed executable |
| Adapter projection or package/runtime contract | Affected Adapter `typecheck` and `test`; `pnpm test:adapter-package` for installed artifacts |
| Collector / Server delivery | `pnpm test:e2e` for Codex/Claude; `pnpm test:opencode-contract` for installed OpenCode over authenticated HTTP/PostgreSQL |
| Go Module | From `server/`, `go test ./internal/<module>/...`; use `pnpm test:go:integration` for persistence and authenticated boundaries, and race/fuzz checks when affected |
| SQL migration or query | `pnpm generate:sqlc`, inspect generated changes, and run affected PostgreSQL integration checks |
| Compose or backup/restore | `pnpm test:self-hosting:config`; `pnpm test:self-hosting:restore` for paired recovery in isolated containers/volumes |
| Packaging or publication | [Release verification and gates](releasing.md#local-release-verification) |

`pnpm check` runs documentation and architecture checks, workspace typechecks and tests,
Web browser tests, Codex/Claude E2E and Go unit suites. It does not include every
release or PostgreSQL check. `pnpm test:go:integration` also runs installed
OpenCode contracts; its name is narrower than its coverage.

`pnpm check:docs` parses Markdown links and headings, checks local file/anchor
targets, concrete pnpm script names and documentation/ADR index coverage. It
checks links in historical documents while preserving their old command examples.
External links are not fetched, and passing this check does not establish that
prose matches product behavior. Reader response schemas are additionally compared
with the exported Go JSON types by the HTTP contract tests.

[CI](../.github/workflows/ci.yml) additionally verifies Web rollout/rollback,
production builds, release tarballs, PostgreSQL/installed OpenCode contracts and
Collector disk-exhaustion recovery. [Security](../.github/workflows/security.yml)
and [Release](../.github/workflows/release.yml) define their additional gates.
Read the workflows and package scripts when their exact scope matters.

After the relevant checks pass, repeat or broaden them only for new changes,
failures or unresolved risk. Report missing prerequisites and checks not run;
local success is not evidence that CI or manual staging passed.

## Deliver a change

Preserve concurrent work and update the affected feature guide. For an integration
request, start from the latest `main`, reconcile ADR/migration numbers and generated
code, and land one usable increment through required PR checks before expanding
the next. Keep research binaries and private transcripts out of implementation
commits. Record architectural exceptions in an ADR before implementation.

Merging, package publication and Server deployment are distinct actions. The
dogfood Web already has an [automatic deployment workflow](operations/aws-dogfood.md#automatic-web-deployment)
after successful `main` checks; account for that existing effect when integrating.
Publication requests follow [ADR-0048](architecture/adr/0048-release-request-manual-acceptance.md)
and the [release guide](releasing.md).
