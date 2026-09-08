# Ink feasibility validation

- Date: 2026-09-08
- Scope: increment 1 of [CLI experience improvement](experience-improvement.md)
- Decision: [ADR-0036](../architecture/adr/0036-ink-cli-experience.md)
- Source checkout: `9fc38d55e19fda3b60a104cb2453fd76c6d2fad3`
- Result: proceed with Ink; no Node major upgrade or package-size exception needed

## What was exercised

A disposable entry bundled the real ATape CLI and a separate Ink interaction
probe into one ESM executable. Explicit commands used the real application and
Node Layers. Only a private probe argument entered a directory input followed by
a source multiselect; it performed no real login, configuration or upload.

The probe was research outside the repository and is not a production command.
The production CLI source and its dependencies were not changed in this increment.
Its purpose was to expose runtime, package and terminal failures before connecting
the new presentation to actual setup side effects.

The candidate npm tarball was installed into an independent prefix with
`npm install --ignore-scripts --no-audit --no-fund`. It had no dependency on a
source checkout or a sibling `node_modules` directory at runtime. A second install
of the identical tarball ran in an isolated Linux container, with no workspace
or host dependency directories mounted into the container.

The unchanged `apps/cli/scripts/verify-package.mjs` also ran against the candidate
package on both platforms. This checked the four-file package allowlist and size
gate, clean installation, help/version/JSON, fixture device login, installation of
a temporary Adapter, Project setup, managed Collector startup, a successful cycle,
shutdown and logout. Authentication and capture used the script's disposable
fixture Instance and isolated local state, not a user's real account or Projects.

## Versions and artifact

| Component | Version / value |
| --- | --- |
| Ink | 7.1.1 |
| React | 19.2.8 |
| `@inkjs/ui` | 2.0.0 |
| esbuild | 0.28.2 |
| macOS runtime | Node 24.18.0, arm64 |
| Linux runtime | Node 24.20.0, arm64, Debian bookworm container |
| Linux image | `node:24-bookworm`, manifest digest `sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2` |
| ESM executable | 2,061,127 bytes |
| Compressed npm tarball | 408,356 bytes, below the 1,048,576-byte gate |
| Packed files | `LICENSE`, `README.md`, `dist/atape.js`, `package.json` |

SHA-256 of the disposable candidate tarball:

```text
cbf9c7410d7d82c864066c7bee20993240d88cf24a001497561f1f2dc7bd133b
```

SHA-256 of its bundled executable:

```text
3db261d1994c1613967a2a208edf9e293c3c952b1d70c333549a2b94bf939d9b
```

This is a research artifact carrying the checkout's package version, not a
published release. Its measured size is evidence of headroom, not a guarantee
of the eventual complete TUI's size.

## Installed-terminal results

Each row below passed on both macOS arm64 and Linux arm64. Tests attached the
installed executable to a real pseudo-terminal and sent input through its public
stdin/stdout Interface, rather than mocking React or inspecting component state.

| Check | Observable result |
| --- | --- |
| Unicode, completion, resize and multiselect | A real directory containing Chinese characters and a space was completed using Tab; resizing from 80×24 to 38×12 updated the display; Space changed selection and Enter returned the selected sources |
| Bracketed paste | A pasted Unicode path with a newline remained input; it did not advance the screen until explicit Enter |
| Escape | Cancelled the probe and restored terminal state |
| Ctrl+C | Exited cleanly and restored terminal state |
| SIGTERM | Released the renderer and exited cleanly after pending output was drained |
| CI with a TTY | Printed plain guidance and did not enter interactive input |
| Piped input/output | Printed plain guidance without ANSI screen controls or waiting for input |
| Explicit version | Printed the version without starting the renderer or emitting ANSI |
| Status JSON | Produced parseable plain JSON with isolated state |

Interactive exit checks compared the complete terminal attributes before and
after the process and checked restoration of the primary screen, visible cursor
and disabled bracketed-paste mode. The captured narrow-window transcript was
also inspected: long paths and help text wrapped within the available width.

## Build failures found and resolved in the probe

1. **Optional DevTools was not optional to the bundler.** The unmodified build
   could not resolve `react-devtools-core`. Marking it external built a file, but
   hoisted an import that failed in a clean installation even for `--help`.
   The working build replaced only Ink's `./devtools.js` import from its
   reconciler with an empty release Module. It did not patch npm-installed files
   or add DevTools to the user-facing artifact. Pinning Ink and validating the
   artifact must accompany this narrowly scoped build integration.
2. **Bundled CommonJS built-in calls need an ESM bridge.** Opening the actual
   interactive branch initially failed with `Dynamic require of "assert" is not
   supported`. A build banner defining `require` through Node's `createRequire`
   resolved the bundled dependency's calls without external npm dependencies.
3. **A successful build is insufficient.** The packaged command checks passed
   before the CommonJS failure was reached. Both noninteractive commands and a
   real interactive render must remain in the eventual release acceptance checks.

The working configuration retained `bundle: true`, `platform: node`, `format:
esm`, `target: node24`, the version define, shebang and legal comments. It selected
React's production build and used the DevTools exclusion and `createRequire`
bridge above. The esbuild output metadata listed only Node built-ins as external
imports; Yoga WASM did not require a separate distributed asset.

## Limits and requirements for the production increment

- This validates the renderer, controls and distribution direction. It does not
  verify a production setup workflow, real browser authentication, source
  authorization, recovery, Git attribution or background/TUI concurrency.
- macOS and Linux arm64 were exercised. Linux x64, Windows, SSH/tmux combinations,
  a physical terminal/font matrix, IME composition and screen-reader usability
  remain unverified. The probe's Chinese input is Unicode/paste verification,
  not an IME or accessibility acceptance claim.
- Directory completion in the probe only establishes feasibility. Production
  requires bounded asynchronous filesystem Effects, stale-result handling,
  useful errors and complete input editing. `@inkjs/ui` is not being claimed as
  an out-of-the-box path browser.
- The probe used React without JSX. Production TSX views require a deliberate
  development runner or build-before-run arrangement; Node's existing native
  TypeScript execution does not parse TSX. The installed ESM path is already
  validated.
- A real Effect-scoped binding still needs cancellation/cleanup tests with
  in-flight work. The raw probe's local input callbacks must not be copied into
  production as business workflow ownership.
- Research scripts and terminal transcripts are retained with the local task
  artifacts, outside implementation commits. Do not ship the candidate binary,
  private probe flag or temporary fixture data.

## Follow-through

Shared Git attribution is implemented under
[ADR-0037](../architecture/adr/0037-shared-git-source-attribution.md). The production
Ink setup and console now have permanent installed-terminal checks; their separate
[validation record](production-terminal-validation.md) supersedes this prototype
as evidence for the current executable. The research evidence above remains a
record of library selection, not a shipped probe.
