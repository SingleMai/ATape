# Adapter package and runtime contract

ATape Adapters are independently installed npm packages. The management plane reads a versioned `atapeAdapter` object from `package.json` before any Adapter source is imported.

```json
{
  "name": "@atape/adapter-codex",
  "version": "0.1.0",
  "type": "module",
  "atapeAdapter": {
    "protocolVersion": "atape.adapter.v1alpha1",
    "adapterId": "codex",
    "displayName": "Codex CLI",
    "entry": "./dist/index.js",
    "harnesses": ["codex"]
  }
}
```

The fields mean:

- `protocolVersion` selects the ATape Adapter contract. The only accepted value is currently `atape.adapter.v1alpha1`.
- `adapterId` is the stable ID stored in each local Project's enabled Adapter list.
- `displayName` is a non-empty human-readable name.
- `entry` must start with `./`, stay inside the installed package, and point to an existing file.
- `harnesses` is a non-empty list of source Harness identifiers represented by the Adapter.

The package itself must also have valid `name` and `version` fields. Its installed name must match the requested package. npm lifecycle scripts are disabled, so build artifacts must already be present in the published or local package.

## Runtime export

The entry module exports one factory:

```js
export async function createAtapeAdapter(context) {
  return {
    async collect(request) {
      return {
        protocolVersion: "atape.adapter.v1alpha1",
        nextCursor: request.cursor,
        hasMore: false,
        observations: []
      }
    },
    async close() {}
  }
}
```

`context` contains the Adapter ID and version, the stable ATape user ID, plus the selected local Project ID, type, and absolute path. It also carries an `AbortSignal`. It does not contain another Project's path or server credentials.

`request` contains:

- `protocolVersion`, fixed to `atape.adapter.v1alpha1`
- `cursor`, the last page durably committed by ATape or `null`
- `previousAdapterVersion` when a prior checkpoint exists
- `limits` for observations, Threads, Events, Canonical bytes, Raw segments, and Raw segment bytes
- `rawProgress`, the Host's acknowledged provider generation and source offset for this Project/Adapter
- `signal`, interrupted on cancellation

An Adapter returns no more than the requested limits. When it emits observations it must advance to a non-empty replacement cursor. `hasMore: true` also requires at least one observation. Given the same committed cursor, an Adapter must reproduce the same observation identities, revisions, timestamps, segmentation, and source bytes until the Host advances it.

The optional `close` method releases file handles, database connections, or other resources. The Host calls it when the Project/Adapter collection scope ends.

## ACP-centered observations

ATape does not define another Message or ContentBlock taxonomy. Every Adapter Event carries a stable ACP v1 `SessionUpdate` profile in `update`. The accepted profile currently includes:

- `user_message_chunk`
- `agent_message_chunk`
- `agent_thought_chunk`
- `tool_call`
- `tool_call_update`

Message chunks use ACP `ContentBlock`; text, image, audio, resource-link, and embedded-resource variants are accepted. The TypeScript compatibility check is pinned to `@agentclientprotocol/sdk` 1.4.0 and stable ACP protocol v1. Adapters reconstruct a complete source message or content unit before emitting it; they do not expose arbitrary streaming fragments that could split a secret across collection pages. ATape's surrounding fields add capture concerns ACP does not own: provider Event identity and revision, ordering/fidelity, occurrence time, Raw reference, and optional child Thread relation.

One observation is one revision of one provider Session. It includes the Session metadata, complete Thread topology for that revision, bounded Events, and zero or more Raw append segments. Exactly one Thread has no parent. Subagent conversations remain child Threads; an Event links to one with `childSourceThreadId` instead of flattening its messages into the parent.

The current Go ingestion endpoint stores a reader-oriented text projection. The client HTTP Adapter derives that projection from ACP updates while preserving the original provider source in Raw. This internal mapping is not the public Adapter message model.

## Raw append contract

A Raw segment contains a stable `sourceObjectId`, opaque provider `sourceGeneration`, provider byte `sourceOffset`, source name, textual media type, bounded content, and `final` flag. The first segment starts at offset zero. Segments in one generation are contiguous; a rewrite changes the source generation and restarts at offset zero. A non-final segment must contain complete UTF-8 records and end with a newline. This keeps redaction boundaries deterministic instead of splitting a credential or code point between Adapter pages.

An Adapter segment and a server transport chunk are deliberately different units. The Host redacts the complete Adapter segment, then divides it at UTF-8 boundaries into transport chunks no larger than 256 KiB. It owns globally scoped object and deterministic chunk IDs, SHA-256, Base64 encoding, server generations, and post-redaction offsets. The provider source offset advances only after all transport chunks for the segment are acknowledged; a partial failure replays already accepted chunks rather than persisting a mid-record provider offset. Adapters use `rawProgress` only to resume provider reads; they must not pre-redact offsets or build server Raw IDs.

The authoritative runtime Schemas and types live in [`packages/domain/src/collector.ts`](../../packages/domain/src/collector.ts). The pull/checkpoint decision and failure semantics are recorded in [ADR-0009](../architecture/adr/0009-pull-adapter-runtime-and-checkpointed-collector.md).

The repository's first production implementation is documented in the [Codex Adapter guide](codex.md).
