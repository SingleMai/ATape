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
    "harnesses": ["codex"],
    "gitAttribution": "atape.git-attribution.v1"
  }
}
```

The fields mean:

- `protocolVersion` selects the ATape Adapter contract. The only accepted value is currently `atape.adapter.v1alpha1`.
- `adapterId` is the stable ID stored in each local Project's enabled Adapter list.
- `displayName` is a non-empty human-readable name.
- `entry` must start with `./`, stay inside the installed package, and point to an existing file.
- `harnesses` is a non-empty list of source Harness identifiers represented by the Adapter.
- `gitAttribution` is required for Git capture and declares use of the Host's
  `atape.git-attribution.v1` callback. It may be omitted for directory-only capture.
  The Host checks this capability before importing a Git Adapter.

The package itself must also have valid `name` and `version` fields. Its installed name must match the requested package. npm lifecycle scripts are disabled, so build artifacts must already be present in the published or local package.

The CLI accepts a registry package specifier, local package directory, local npm `.tgz`/`.tar.gz` archive, or HTTPS archive URL. Local and remote archives must use npm's `package/package.json` layout. Before npm sees an archive, ATape performs a bounded streaming scan (32 MiB compressed, 64 MiB expanded, and 256 KiB for the manifest), validates TAR checksums, and decodes the Adapter manifest. HTTPS downloads use a private staging directory that is removed after installation. Registry packages cannot be preflighted locally, so their manifest is validated immediately after installation and still before any Adapter entry is imported.

These checks make installation inert; they do not sandbox Adapter execution. An enabled Adapter is trusted code loaded into the Collector Host and receives only its selected Project context.

## Paged observation runtime export

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

For this paged observation runtime, `context` contains the Adapter ID and version, the stable ATape user ID, plus the selected local Project ID, type, and absolute path. It also carries an `AbortSignal`. It does not contain another Project's path or server credentials.

For Git Projects, `context.gitAttribution` contains `version` and
`resolve(source, signal): Promise<"included" | "excluded" | "unknown">`.
Check the version before Git capture and require an updated Host when absent.
Each original source supplies `{ sourceId, originKey, cwd, repositoryRemote? }`:
the source ID is stable across relocation, the origin key identifies its immutable
starting record, CWD is its original absolute directory, and the optional remote
comes from provider metadata. Do not substitute a later CWD or the configured
Project path. The configured Git path is only a locator and need not still exist.

Await resolution before emitting a source. Include only `included`; omit
`excluded`; report `unknown` as an `attribution` source diagnostic. Do not catch a
rejected resolution as unknown: authentication, transport and persistence failures
fail the job. Pass the operation's cancellation signal. The Host owns Git lookup,
server matching and durable attribution evidence, with bounded per-call caches.
See [ADR-0037](../architecture/adr/0037-shared-git-source-attribution.md).

`request` contains:

- `protocolVersion`, fixed to `atape.adapter.v1alpha1`
- `cursor`, the last page durably committed by ATape or `null`
- `previousAdapterVersion` when a prior checkpoint exists
- `limits` for observations, Threads, Events, Canonical bytes, Raw segments, and Raw segment bytes
- `rawProgress`, the Host's acknowledged provider generation and source offset for this Project/Adapter
- `signal`, interrupted on cancellation

An Adapter returns no more than the requested limits. When it emits observations it must advance to a non-empty replacement cursor. `hasMore: true` requires a non-empty replacement cursor different from the requested cursor, but may have no observations when traversal advances without new content. The Host commits that progress without uploading fabricated observations and continues within its per-cycle page limit. Given the same committed cursor, an Adapter must reproduce the same observation identities, revisions, timestamps, segmentation, and source bytes until the Host advances it.

Pages may include local `sourceFailures: [{ source, reason }]` diagnostics and
`sourceFailuresTruncated: true` when further failures were omitted. Reasons are
`io`, `format`, `unsupported`, `changed`, `limit`, `duplicate` or `attribution`. At most 32 entries
with nonempty source paths of at most 4096 UTF-8 bytes are accepted per page.
The Host redacts and deduplicates them into a bounded job report. They are not
Canonical/Raw payloads and never acknowledge source progress. Diagnostic-only
pages without traversal progress must use `hasMore: false`; a failed source keeps its last committed cursor.
The managed Collector exposes partial health and `collect --once` exits nonzero
after printing partial results. Use an updated Host to retain these optional fields.

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

An Adapter segment and a server transport chunk are deliberately different units. The Host redacts the complete Adapter segment, then divides it at UTF-8 boundaries into transport chunks no larger than 3 MiB. It owns globally scoped object and deterministic chunk IDs, SHA-256, Base64 encoding, server generations, and post-redaction offsets. The provider source offset advances only after all transport chunks for the segment are acknowledged; a partial failure replays already accepted chunks rather than persisting a mid-record provider offset. Adapters use `rawProgress` only to resume provider reads; they must not pre-redact offsets or build server Raw IDs.

The authoritative runtime Schemas and types live in [`packages/domain/src/collector.ts`](../../packages/domain/src/collector.ts). The pull/checkpoint decision and failure semantics are recorded in [ADR-0009](../architecture/adr/0009-pull-adapter-runtime-and-checkpointed-collector.md).

The repository's first production implementation is documented in the [Codex Adapter guide](codex.md).

The opt-in [Claude Code Adapter](../../adapters/claude/README.md) now uses the
same runtime, ingestion and reader Interfaces for bounded Project-scoped discovery
and incremental Session collection. Its documented restrictions are not a claim
of general Claude history support.

### Raw capture capability

`rawCapturePolicy: "atape.raw-capture.v1"` declares that the Adapter accepts
`AdapterCollectRequest.rawCaptureEnabled`, continues Canonical without Raw when
false, and can resume Raw from real host receipts on re-enable. The host requires
this capability for disabled Raw; it never fabricates receipts to skip work.

## Bounded source-capture capability

`sourceCapture: "atape.source-capture.v1"` selects the source-capture runtime used
by [OpenCode](opencode.md). Its factory returns `sourceCapture` plus `close()`
instead of the paged `collect()` method above. It does not declare
`rawCapturePolicy`; Raw-off is required behavior of this capability itself.

`sourceCapture` exposes its protocol version, bounded `discover({ cursor, limits,
signal })` and `open({ sourceId, rawEnabled, limits, projection, signal })`.
Discovery returns original source attribution evidence and paged source IDs. An
open view supplies a complete target header and bounded `read(signal)` frames,
then `close()`. The Host checks page and total limits, cursor progress, identity,
Raw policy and lifetime cancellation. A view has one scoped source snapshot;
recovering a delivery never requires reopening it.

Unlike the paged observation runtime's attribution callback, discovery passes
source evidence to the Host, which resolves directory/Git membership before
opening included sources. Authentication, authorization and transport failures
retain their own failure channels. The Adapter owns source-format semantics;
the Host owns attribution, redaction, comparison, revisions, Raw references,
journaling and delivery. Neither Server credentials nor upload operations are
part of the foreign runtime Interface.

The Host freezes final validated and masked bytes into an account-bound SQLite
capture journal before uploading content. It selects a complete Canonical target
atomically after genuine activation proof. Raw acknowledgements and unresolved
Raw bytes remain independent of that selected head. Raw-off does not retain full
source JSON for future archival, and re-enable does not rewrite existing Event
provenance merely to add Raw. Recovery can continue after source deletion using
only frozen units and receipts. These rules replace the paged observation replay
and Raw-append ordering above for this capability.

The authoritative types remain in `packages/domain/src/collector.ts`; see
[ADR-0068](../architecture/adr/0068-source-capture-runtime.md) and
[default admission](../architecture/adr/0076-source-collection-release-admission.md).
