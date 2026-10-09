# Claude background candidate: 2026-10-09

The [Claude guide](../../adapters/claude.md) owns current behavior and limits;
[ADR-0102](../../architecture/adr/0102-claude-background-subagents.md) records the
decision. This record distinguishes source evidence, local checks and final
integration gates. [PR #203](https://github.com/SingleMai/ATape/pull/203) records
the final candidate and its exact-head CI/Security results before merge.
Package publication, manual Server deployment and production
database migration are not requested.

## Candidate and evidence

The increment starts from main `a525090395ebddc7e05a0b97ab87cb91e655a11a`
([PR #202](https://github.com/SingleMai/ATape/pull/202)). It reuses sourceCapture
v2, Host publication and Server retention without a new protocol or migration.
The native [background fixture ledger](../../../adapters/claude/fixtures/native-background-child-2.1.263/README.md)
records real Claude Code 2.1.263 with isolated HOME/configuration/workspace,
deterministic loopback SSE and a successful native exit. Eight real persisted API
IDs carry controlled counters totaling 248 input / 136 output. These counters
establish source projection, not real provider billing.

Native observed snapshots and complete-LF replay cuts are labeled separately.
The child-only append replay holds root bytes constant. Missing files, conflicting
identity, rewind and expanded notification content are generated test mutations,
not additional native acquisitions. No native failure/cancellation, repeated
notification, nested child or fork is claimed.

## Completed local checks

- Claude public factory: **156/156 tests pass** across four files, including the
  existing 111 cases, 42 background cases and three genuine previous-v2 upgrade
  cases. Log SHA-256:
  `fe3ccfe8c22c4f0f9664c03494c67658eb3b28c7903407126bb09bcc1b971791`.
- A real source-built `a525090395ebddc7e05a0b97ab87cb91e655a11a` v2 factory
  generates the old checkpoint and Thread metadata. On identical native source
  bytes, the candidate withdraws the old notification user Event and admits the
  child, preserving Origin, Session, retained message anchors and root usage.
  Old Raw on/off and later child-only append are checked. Genuine `f6093535`
  collect separately generates a pending projection slot in an explicitly
  expanded notification body; adoption validates its old slot semantics before
  v2 omits the control.
- Workspace typechecks, production build, documentation and architecture checks
  pass. No Host, Server, API or database production changes are included.
- `pnpm test:release` passes: packaged CLI/PTY/daemon, all six installed Adapters,
  seven release tarballs, checksums and package replacement/state invariance.
  The installed Claude check covers 64 native root snapshots, nine rewind stages,
  twelve compaction scenarios, foreground/thinking families, background lifecycle,
  partial LF, child-only append, retention/rewind, Raw and eight unlinked cases.
  Log SHA-256:
  `b767770efac65274b7b52d2c7e6e3c01f20a6c444e1d88804ba1810cbfb5893d`.

| Candidate artifact | SHA-256 |
| --- | --- |
| Claude archive source | `c34e382d2c5cb006ad5acdc1347f43fd9858f35d7da1f2e038a9288389a286fd` |
| Claude bundled entry | `449d99b6f65fd74125d041644483accc09a87c6b79ee04b580fa5143088e20a2` |
| Claude 0.5.3 tarball | `518d01d9f52d866aaaeb4fa2714d3bb8e259aab7b69301a70d4b5312d5037383` |
| CLI 0.5.3 tarball | `36b6bf4e671287d30dfe6f6b34938004cc8d70da7321bc086d0eef7ff0b59d70` |

These are local acceptance artifacts, not an npm publication. Final PR CI/Security
gates determine integration separately from these completed local checks.

## Fresh publication assertion correction

The initial full UTC PostgreSQL run reached the new child-only append assertion
and failed; it was then stopped. Its log SHA-256 is
`8ab37212a02395083ceb07d36a8e257b604f431e75e309881be221c164f59acc`.
This is not a passing whole-gate run. A focused replay identified exactly three
changed fields on all four root and three existing child Events: ObservedAt,
ReceivedAt and IngestSeq. The other 21 fields, including versions, source order,
native OccurredAt, payloads, Raw references and relationships, were identical.
Diagnostic log SHA-256:
`36ab81a929c70dd935e55e370feb0251683d7394af1f3ea31041302c40a84b5f`.

Fresh explicit publication intentionally allocates new observation provenance.
The two fresh-reprojection assertions now require those three fields to advance
and compare all other fields exactly. Missing-child retention and Raw-only
backfill continue comparing all 24 fields. This corrects test expectations without
changing production or the accepted package artifacts.

Two subsequent focused runs exposed test-harness assumptions: macOS canonical
source paths use `/private/var` while `t.TempDir` can return `/var`, and Search
matches literal substrings, so the expected native reply query must include its
colon. Expected diagnostic paths are now resolved while the child exists, and
the Search check uses the exact reply substring with its unique Thread/Event
anchor. Neither change relaxes source or Search validation.

## Authenticated PostgreSQL acceptance

The corrected focused UTC run passed all 26 restarted native stages and its
complete HTTP parent/final Search assertions in 43.38 seconds. Log SHA-256:
`4dd762f40ba1d21b3fce9a8eae38e1b33f808ac29ed0717a9d1a21415ce326f8`.

Final `TZ=UTC pnpm test:claude-contract` passed both required Claude subtests and
the complete HTTP parent/final Search assertions in 279.41 seconds, with zero
failures and zero skips. This run logged **26 unique current stages and 203 unique
legacy phases**; these counts were computed from the actual final log. Legacy
phases include both the main contract and its manual-fixture helpers. Log SHA-256:
`02ba66d4eb969e9e150d9f9db8e0fcbe60ce49e222a95e8c4e213d5f61d7c3ac`.
Final HTTP fixture source SHA-256:
`abace62fbfde3df7c47c7e992c6ebede97180f7af26e05c808dc2c1df1b01eb8`.

This establishes the installed Collector/Reader/Search/Overview/Raw path,
root-unchanged child append, stable Event versions and anchors, exact retained
membership, notification exclusion, eight real usage samples, source-free
recovery inherited from the existing contract, Raw off/backfill and rewind.
The final PR must also pass whole-repository CI, the full PostgreSQL provider
corpus and Security on its exact head before merge.
