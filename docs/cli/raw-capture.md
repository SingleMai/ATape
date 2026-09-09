# Configurable Raw capture

Raw upload is separate from Canonical conversation capture and Search.

| Team policy | User enable | User disable |
| --- | --- | --- |
| force | Upload | Upload |
| personal | Upload | Skip |
| close | Skip | Skip |

New and existing Teams default to **personal**; new and existing Users default
to **disable**. Migration 000013 applies these defaults. An Owner changes the
policy in **Team settings → Raw source upload**. A User changes their
Instance-wide preference in **Account → Raw source upload**. The preference
is stored under every policy but takes effect only with personal.

The Collector reads the effective policy before each Project/Adapter job.
When disabled, supported Codex/Claude Adapters continue Canonical capture,
avoid Raw archival reads/buffers and uploads, report no Raw backlog, and keep
genuine Raw receipts. Parsing and integrity checks still read the source files
needed for Canonical capture. A denial during upload is a skip rather than
a failed sync; it does not invent acknowledgements. Policy lookup errors fail
the job closed and surface a retryable error where applicable.

Turning Raw on backfills retained local sources from acknowledged offsets.
It can therefore upload a large historical backlog. It cannot recover sources
already removed locally. Turning Raw off does not delete or hide existing
server data. Chunk admission and commit both check policy; an in-flight byte
write racing with disable can leave an unreferenced blob but cannot commit a
manifest after the disabling transaction completes.

## Compatibility and rollout

Deploy the Server with migration 000013 before upgrading the Collector and
official Adapters together. New Collectors fail closed against Servers without
the settings API. Adapters declare `rawCapturePolicy: "atape.raw-capture.v1"`;
older Adapters require an upgrade when Raw is disabled. Older Collectors are
still denied Raw writes by the Server, but may report sync failure until
upgraded. Merging, publication, Server deployment and migration remain separate
authorized delivery steps.

## Delivered scope and next increment

This increment adds Team/User configuration, both settings entries, authoritative
Server enforcement, Collector negotiation and Codex/Claude independent Raw
progress with re-enable backfill. Policy changes apply at the next job; enabled
uploads are checked at every Server append. Active remote recall, compression,
retention/deletion and historic blob cleanup are future increments.
