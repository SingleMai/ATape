# Sources and Attribution

## Codebase Design

ATape's Deep Module vocabulary and design process were adapted from Matt Pocock's `codebase-design` skill:

- Source: <https://github.com/mattpocock/skills/tree/main/skills/engineering/codebase-design>
- Author: Matt Pocock
- License: MIT, copyright 2026 Matt Pocock
- License text: <https://github.com/mattpocock/skills/blob/main/LICENSE>

This manual is an ATape-specific paraphrase and extension rather than a substantial verbatim copy. The source introduced the vocabulary around Module depth, Interface leverage, Seam placement, Adapter discipline, locality, dependency classification, and designing important Interfaces more than once.

## Conversation protocol

- Agent Client Protocol stable v1 schema: <https://github.com/agentclientprotocol/agent-client-protocol/tree/main/schema/v1>
- Official ACP TypeScript SDK: <https://github.com/agentclientprotocol/typescript-sdk>
- Pinned SDK package: `@agentclientprotocol/sdk` 1.4.0

ATape's Adapter-facing content profile is structurally checked against stable ACP v1. ATape-specific envelopes add capture and archive metadata but do not replace ACP Message chunks or ContentBlock variants. Draft ACP v2 is intentionally not selected.

## Harness compatibility references

- Official Codex CLI documentation: <https://learn.chatgpt.com/docs/codex/cli>

The official documentation describes the Codex CLI product but does not establish its local rollout JSONL as a stable integration protocol. ATape's Codex Adapter treats that layout as version-sensitive provider input, preserves unrecognized records in Raw, and keeps the ATape Adapter protocol independent from it.

## Go references

- Go project layout: <https://go.dev/doc/modules/layout>
- Go context cancellation: <https://go.dev/doc/database/cancel-operations>
- Uber Fx: <https://github.com/uber-go/fx>
- `errgroup`: <https://pkg.go.dev/golang.org/x/sync/errgroup>
- `sqlc`: <https://github.com/sqlc-dev/sqlc>
- OpenTelemetry Go: <https://opentelemetry.io/docs/languages/go/>

Google Wire is intentionally not selected because its upstream repository was archived in August 2025 and is no longer maintained.
