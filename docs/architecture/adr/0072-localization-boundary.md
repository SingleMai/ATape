# ADR-0072: Localization boundary for Web and CLI

- Status: Accepted; implemented for Web and CLI
- Date: 2026-09-11

ATape's user-facing copy is currently English string literals spread across Web
views and CLI rendering. Two problems follow. First, `apps/web/src/runtime/http.ts`
turns the server Problem `detail` into the displayed failure message, so server
English prose reaches the browser. Second, dates and numbers are formatted with a
hard-coded `"en"` locale and a fixed time zone. There is no locale concept, no
catalog, and no extraction workflow.

The product needs multiple locales without paying for a runtime language switch,
without a second general-purpose state runtime beside Effect, and without
hand-rolling ICU plural and select rules.

## Decision

Localization is a presentation concern. ATape adopts i18next as the catalog and
lookup runtime, `i18next-icu` for ICU MessageFormat, and `i18next-parser` as the
source scanner that maintains catalogs. A presentation-only workspace package
`@atape/i18n` owns the engine and locale matching; each application owns its
catalog.

The `@atape/i18n` Interface is deliberately small:

- `Locale`, `SUPPORTED_LOCALES`, `DEFAULT_LOCALE`, `isLocale`, `matchLocale`,
  `resolveLocale`;
- `createTranslator({ locale, catalogs })`, returning `t`, `has`, `formatDate`
  and `formatNumber`;
- `Catalog`, `MessageKey`, `MessageParams` types derived from the source catalog.

The package contains no React, no domain or application imports, and no product
copy. Web and CLI each create one translator at their Composition Root from their
own catalog and expose typed bindings. The package imports i18next internally;
callers never import it directly, so the engine can be replaced without touching
views.

Locale is resolved once at process start and is read-only for that process.
Changing language persists the preference and reloads the page or restarts the
command; there is no subscription, no React Context, and no re-render path. Web
resolves `localStorage` then `navigator.language`; CLI resolves its language flag,
`ATAPE_LANG`, then local configuration, and finally the ambient `LANG`/`LC_ALL`.
`resolveLocale` returns `DEFAULT_LOCALE` when no candidate matches. The preference
stays client-local: Web writes `localStorage` and CLI persists to its local config
file through `atape language`. An explicit client preference outranks ambient
browser or shell detection. ATape does not persist locale on the server, so no
locale field, route, or migration is added to the protocol.

Catalog values are ICU messages and are the source of truth for translations.
English copy stays inline at the call site as the i18next default value and
`i18next-parser` extracts it into the `en` catalog, so the scanner discovers and
maintains keys automatically. Other locales are translated in their catalog
files. A missing translation falls back to English.

The server keeps RFC 9457 Problem `code` values stable and continues to own the
English `title` and `detail` for API clients and diagnostics. The client maps
`code` and typed failure reasons to localized copy. The Problem `detail` is not
rendered to a user on a migrated surface; it may remain on the client error for
logs.

## Boundaries and invariants

- Localization belongs to Presentation. Domain and application Modules keep
  emitting typed codes, not localized prose.
- `@atape/i18n` imports neither React nor `@atape/domain` nor
  `@atape/application`. Web and CLI are its only consumers.
- No React Context and no second state runtime are introduced. The translator is a
  process-lifetime value created at the Composition Root.
- ViewModels carry message keys and typed codes; views render localized text. The
  server Problem `detail` is not a ViewModel field. Every Web presenter satisfies
  this.
- Adding a locale means adding it to `SUPPORTED_LOCALES` and providing its
  catalog; a recognized locale without a catalog falls back to English. No view
  changes are required.

## Rejected alternatives

- **A hand-written typed catalog.** Avoids a dependency but re-implements ICU
  plural, select, number and date formatting and provides no extraction tool.
- **LinguiJS.** Its message-macro model requires a Babel or SWC transform. The CLI
  runs under Node native TypeScript stripping in development and an esbuild bundle
  in release, so macro transforms do not apply cleanly.
- **Paraglide (inlang).** Compiles type-safe message functions but does not scan
  existing source, so it cannot discover keys from current call sites.
- **FormatJS / react-intl as the primary engine.** ICU is first class, but the
  ergonomic React API is Context-based and the framework-agnostic extraction and
  precompilation path is heavier than i18next's.
- **Translating Problem text on the server.** It would put locale into the
  protocol, couple the Go server to catalog management, and weaken the stable
  `code` contract.
- **Persisting the locale preference on the server.** A per-user locale field,
  route, and migration add protocol and schema surface for a preference that is
  only needed at render time. Client-local storage satisfies the requirement;
  cross-device sync is not worth the server coupling.

## Phases

1. `@atape/i18n` plus the Web access and authentication surface: boot wiring,
   `en` catalog, parser configuration, and removal of the Problem `detail` leak.
2. Remaining Web views, date and number formatting, the `localStorage`-backed
   language setting, and a `zh-CN` catalog.
3. CLI adoption through the same package and locale resolution.

## Verification and remaining work

The engine is verified through its public Interface with interpolation, ICU plural,
fallback, and locale matching tests. Web and CLI catalogs are maintained by
`i18next-parser` and verified idempotent. Web views render through the same
translator callers use; a browser test renders the sign-in surface in the persisted
`zh-CN` locale. CLI tests pin English and the CLI persists the choice with
`atape language` and honors `--lang`/`ATAPE_LANG`.

Remaining, intentionally deferred: CLI `runtime/**` error prose is still English,
and locale preference is client-local rather than synchronized across devices.
Adding a locale means extending `SUPPORTED_LOCALES` and providing its catalog. This
increment publishes no package and deploys no instance.
