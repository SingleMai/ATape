# `@atape/adapter-codex`

Project-scoped Codex rollout collection for ATape. It discovers local root and subagent sessions, projects completed items to ATape's ACP-centered Canonical protocol, and streams the original JSONL separately as Raw.

From the ATape repository:

```sh
pnpm atape adapters install ./adapters/codex
pnpm atape adapters enable codex --project <project-id>
pnpm atape collect --once --project <project-id>
```

This Adapter is a version-sensitive compatibility layer because the Codex local rollout format is not a documented stable API. See [`docs/adapters/codex.md`](../../docs/adapters/codex.md) for discovery, projection, subagent, Raw, and compatibility behavior.
