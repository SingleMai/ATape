# Claude Active Path candidate: 2026-10-09

This record distinguishes local behavior evidence from integration, publication
and deployment. [PR #202](https://github.com/SingleMai/ATape/pull/202) carries the
final integrated candidate and its exact-head CI/Security results. The
[Claude guide](../../adapters/claude.md) owns current behavior and remaining work.
No package publication, Server deployment or production migration is attested.

## Source identity

The local final sourceCapture candidate used these SHA-256 values; rebasing onto
the concurrent CLI automatic-update change preserves these source files:

| Source | SHA-256 |
| --- | --- |
| Claude archive | `66e92b5699dcdb58ae7ca176ca0b647f11dbc15bd7d2ee49e2feff720eb6f9fd` |
| Claude factory | `4d8d5c40fc2f8321771b8caa94674f9d1e9c230149b574c0087317ad8ec0eb5f` |
| SQLite Capture Journal | `44ad6ac0942747a0465dda97ee2a41e89b1169e3317afda438fc443624ecdfb5` |
| Source Collector | `f8bc58d643b15edea307e50eb83ba59ff8c1c90ad3e3dbda1eb0302bfe91858b` |
| Publication delivery | `2d390bebf5733bf65b7b1d2bbebcc00e2ed166ba564bcc8f5f2a43f2c0bf9903` |

The genuine legacy baseline is main commit
`f6093535e92acfee47170b53c7dec7244fccf8c7`, built from untouched historical
sources and matching Effect/esbuild pins. The freeze script records per-file,
lock, toolchain, bundle and tarball hashes for each run. Esbuild source-location
comments can vary with the temporary directory; tarball byte equality across
machines is not claimed. Re-versioned current packages are used only for package
replacement checks, never historical checkpoint evidence.

Native rewind evidence is retained in its
[fixture ledger](../../../adapters/claude/fixtures/native-rewind-2.1.263/README.md).
It records installed Claude Code 2.1.263, successful live rewind control, empty
leaf selection and later descendants. Controlled loopback responses and counters
establish persistence/layout behavior, not real provider reasoning or billing.

## Completed local checks

- Public shipped factory: 111 tests pass (77 capture, 34 generic compaction).
  These include genuine previous-main first-record partial checkpoints, fully
  authenticated prefix failures, source isolation, thinking/tools/usage,
  rewind/empty paths, retained children, Raw and generated 100-cycle continuity.
- CLI: 310 tests pass in a complete serial rerun. An earlier concurrent workspace
  run and a separate retry hit existing CLI-upgrade timing assertions; no timing
  thresholds or production upgrade logic were changed for this rerun. All other
  workspace package tests passed in that run, including application 132, domain
  24 and Web 58. Workspace typechecks, Go unit tests, architecture/docs checks
  and the remaining Codex demo E2E passed.
- The installed authenticated PostgreSQL contract passed 18 independently
  restarted stages: genuine legacy seed, adoption, rewind/empty target, idle,
  missing/restored child, historical child first Raw backfill, old Raw links,
  committed-but-lost Activate response, source-free sealed recovery, and native
  manual compaction followed by ordinary continuation. Log SHA-256:
  `58f56ba5fe9175804f74f6a99442fbb714db0700745013cddc5778f4b8110236`.
  This run preceded the source-assisted no-root-UUID fallback; that branch's
  additional coverage is through the public factory, not an extra HTTP stage.
- Full `pnpm test:release` passed on the source-assisted candidate before the
  concurrent main rebase: installed CLI/PTY/daemon, all six Adapter packages,
  seven checksummed tarballs and package replacement/state invariance.
  Its Claude installed check covers 61 native roots, nine rewind snapshots,
  twelve compaction scenarios, families, thinking, retention, Raw and diagnostics.
  Log SHA-256: `2e98e54568838be2dacc3d5972f67b52b0b3dbcea69a2dc4142f393d73f7011a`.
  Claude bundle: `0eb11ac103176a4f7a3ff59af9413dffcda46f6c1b8d2f6859f08c1b84e24d29`;
  CLI bundle: `e06e15e06a433450362f440a0d2bac095b78441012572787380a31ed4f9b3b83`.
  These are local version-0.5.2 artifacts, not the rebased version-0.5.3 tarballs.

A preliminary full PostgreSQL gate passed every required provider subtest,
including new Claude 18 stages and the historical Claude contract, but its shared parent
expired before final Search checks. This is a failed whole-gate run, not a pass.
Its log SHA-256 is
`5e8d4abb783f08cceba577262580fd86e678b147046d2e6532d8467217436ddd`.
The expanded sequential corpus now has a bounded 20-minute fixture (plus the
existing optional review allowance) under a 30-minute runner. Individual source,
HTTP operation and publication lease deadlines are unchanged. Final integration
must pass on the rebased PR head, including both required Claude subtests and the
complete parent; skipped/missing results are rejected by the gate.

## Rebased integration acceptance

The production candidate on main `0840d6a7061f3a38302f2ed97a4d26915d238845`
was checked at `f1de7b56dafa6346bc2479bdb8ee1cb8cd071b0c`; subsequent evidence
edits do not change the source hashes above.

- Version-0.5.3 `pnpm test:release` passed, including the concurrent automatic
  update package checks, CLI PTY, all Adapter packages and exact release checksums.
  Log SHA-256: `4d8235dd3bd0e4594c976a533bffb615b010adc936538693fefbb0752ec65cfb`.
  Claude bundle: `07ac7079b709e72407fa8b1930b8218cb8776ff2c478a94cb074dc101a191133`;
  CLI bundle: `4dfb77692abc7d9e599c391cf06cb15d7a61956900685a875020c192d9cc5c9b`.
  Claude tarball: `fc29557bdfc31a7efba302ac93f398184ed8d40add8576431cb53cff1165d7f8`;
  CLI tarball: `36b6bf4e671287d30dfe6f6b34938004cc8d70da7321bc086d0eef7ff0b59d70`.
- The final installed Claude verifier passed on those bundles, with log SHA-256
  `c311e585ab365e23a395b48c906a65a8f06eaf3233e9cd6b63408c2951e1a6a4`.
- Full `pnpm test:go:integration` passed, including the complete HTTP parent and
  final Search assertions: 553.224 seconds for the HTTP package, zero failures
  and zero skips. All six required current/historical provider subtests passed.
  Claude current reported 18 independently restarted stages; the historical
  legacy contract logged 203 unique installed phases on this run. This count
  includes 163 phases logged by the main test and 40 by manual-fixture helpers; it is
  computed from this run's log, not reused from historical candidates. Log SHA-256:
  `f8f28f31e0ea8220046bb3a7a1d6cbb1c24e835ea0cbb277d09575646f06173c`.
- The CI merge tree was `376a0beec0efdaa4ce3d3397758bd0b519524414`, equal to that
  production candidate's tree. Final PR checks must additionally cover the
  committed evidence edits before integration.

## UTC retention assertion correction

[CI run 37912558272](https://github.com/SingleMai/ATape/actions/runs/37912558272)
passed repository checks, production builds and exact package acceptance, but
failed two newly added retention assertions. The same-head Security workflow
passed all three jobs. Legacy pgx
reads used `time.Local`; publication JSON restored the same timestamp instants
using `time.UTC`. The assertions compared Go Location representation as well as
Event values. Public Reader wire equality had already passed. The failed log's
SHA-256 is `be4ec3f3c6db696da23f588c7a15de4d9adf0d3401aff43e83dc0c90bc24e0b0`.

Both failures were reproduced with `TZ=UTC`. A test-only helper now copies Events,
normalizes ObservedAt/ReceivedAt/OccurredAt to UTC and compares every field.
Its regression checks reject changes to every Event field and timestamp instant,
preserve slice membership distinctions and verify inputs are unchanged. No
production code or artifacts changed; the source hashes above still apply.

- UTC PostgreSQL adoption and all eight retention rejection scenarios passed.
  The log records equal timestamp instants down to nanoseconds across Location
  representations. SHA-256:
  `139fca272f7684721b3e5eeb13d392d50a2eeef0de974af1234f6636fbe30a4c`.
- The UTC two-Claude installed HTTP run passed its shared parent and final Search,
  with current Claude's 18 restarted stages and all 203 unique legacy phases:
  196.49 seconds for the parent, zero failures or skips. SHA-256:
  `ae68729423f8d5242abcb7c970900dc7dea18d23d23c2d465fc772cb159c4a45`.
- The comparison helper's parent and 24 field-mutation subtests passed.
  SHA-256: `f5dbe2118ade781777e8a58d26b42b320319384281351a8300cbca96e3bb43f3`.
  Architecture checks still cover 174 production files.

Final PR CI must also cover these test corrections and evidence edits before
integration. A failed or skipped whole gate is not accepted as a pass.

## Material limits

Sealed delivery is recoverable without sources; unsealed preparation must reopen
them. Missing source bytes prevent new projection/backfill. A zero-byte old cursor
contains no historical first-record UUID/body hash, so source-assisted migration
cannot recreate that absent proof. Existing committed prefixes remain authenticated.
Single redacted Raw records still face the 3 MiB packed-object limit. Native
evidence does not accept every Claude version, cross-file adoption, broader child
histories, live-provider browser staging or historical published binaries.
