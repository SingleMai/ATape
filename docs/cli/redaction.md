# Client redaction

The Host applies one shared Redaction Module before Canonical and Raw upload and
before retaining source diagnostics. Adapters supply provider data; they do not
own the privacy policy. This guide describes the implementation in this checkout,
not a published CLI release. See [ADR-0104](../architecture/adr/0104-client-redaction-policy.md).

## Supported rules

| Capability | Behavior |
| --- | --- |
| Built-in credentials | Confab's 34-rule catalog covers private keys, cloud/service tokens, Git credentials, JWTs, password-bearing URLs and credential assignments; existing ATape patterns remain. |
| Exact literals | Environment discovery and `ATAPE_REDACT_VALUES` add exact values to the built-ins. |
| Value pattern | `pattern` matches text with RE2 syntax. Optional `capture_group` masks only that group; the default is the complete match. |
| Field pattern | `field_pattern` matches the JSON field name, not a JSONPath. When combined with `pattern`, both must match. Arrays inherit their field name. |
| Structured content | JSON/JSONL and valid nested JSON TEXT are decoded before masking, including escaped values and keys. Duplicate decoded keys or masked-key collisions fail safely. |
| Local inspection | `atape redaction-test` tests a UTF-8 file with the same effective policy and reports safe aggregate rule counts. |

Built-ins are always enabled; custom rules add protection. Built-in replacements
retain `[REDACTED]` or `[REDACTED PRIVATE KEY]`. Custom replacements use
`[REDACTED:TYPE]`. Overlapping matches are merged so their uncovered suffixes
cannot leak. Counts describe masking operations, not unique credentials.

## Global configuration

Create `$ATAPE_HOME/config/redaction.json` (`~/.atape/config/redaction.json` by
default). A missing default file uses built-ins and environment values.
`ATAPE_REDACTION_CONFIG_FILE` selects another file; an explicitly selected missing
file is an error.

```json
{
  "patterns": [
    {
      "name": "Internal credential",
      "type": "INTERNAL_TOKEN",
      "pattern": "internal_[A-Za-z0-9]{16,}"
    },
    {
      "name": "Private account field",
      "type": "ACCOUNT",
      "field_pattern": "(?i)^account_number$"
    },
    {
      "name": "Session value",
      "type": "SESSION",
      "pattern": "session=([A-Za-z0-9_-]{12,})",
      "capture_group": 1
    }
  ]
}
```

Only `patterns` is accepted at the top level. Rule names are labels; `type` uses
1–40 ASCII letters, digits, `_` or `-`. RE2 intentionally excludes lookarounds and
backreferences. Invalid syntax, missing capture groups, duplicate JSON keys and
unsupported configuration fields reject the policy rather than silently skipping
a rule. There is no global/default-disable switch or project override.

Environment discovery uses names ending in `KEY`, `TOKEN`, `SECRET`, `PASSWORD`,
`PASSWD`, `CREDENTIAL`, `DATABASE_URL` or `DSN`, and values of 8–4096 characters.
Explicit values use a JSON string array in `ATAPE_REDACT_VALUES`; comma-separated
values remain supported. Explicit values outside that length range or non-string
array entries are errors. Duplicates are removed. Resolved values are never
written to policy metadata or rule reports.

Configuration is read once at each collection job's start. A job keeps its
immutable snapshot through preparation and delivery; edits apply to the next job.
Changing the inherited environment of a running background process requires
restarting that process. A configuration error stops that job before opening the
Adapter or delivering content.

## Test locally

```sh
atape redaction-test sample.jsonl
atape redaction-test sample.txt --format text --config ./redaction.json
atape redaction-test --help
```

The command works with redirected output and without sign-in. `.json` selects
JSON, `.jsonl`/`.ndjson` select JSONL, and other extensions select text; `--format`
overrides this. Masked content goes to stdout; counts and generated rule IDs go to
stderr. It does not print matching values or configured regular expressions.
It preserves the original representation when no masking is needed; masking JSON
may normalize its representation.

The invoked CLI must include this command. A pre-feature npm bootstrap validates
arguments before delegation, so selecting a newer managed runtime alone cannot
add `redaction-test` to that older bootstrap. Install the newer npm CLI through
the explicit [upgrade flow](setup-and-adapters.md#upgrade-the-cli-and-adapters)
before using this command. Local tests deliberately bypass managed selection so
they remain usable when that selection needs recovery.

Only complete regular UTF-8 files of at most 16 MiB are accepted. Invalid
JSON/JSONL, invalid rules or exhausted limits fail without partial stdout. Test
mode uses an ephemeral policy identity and does not create ATape state, authenticate,
upload, advance checkpoints, reserve publications or invoke the managed updater.
It verifies the supplied sample, not complete session coverage or final wire bytes.

## Policy changes and recovery

Collector policy identity covers the engine/catalog version, normalized rules and
resolved literals using an installation HMAC key. Only the opaque identity enters
comparison/preparation metadata, checkpoints, frozen publication and Raw reuse.
Equal content under a changed policy cannot borrow an old packed Raw object.

Preserve `<collector-state-file>.redaction-key` and its `.json` binding with
Collector state. They are owner-only files. An established missing, corrupt or
replaced key fails closed; restore the consistent pair rather than deleting state.
Local file tests do not need or read this identity.

During a managed update, local readiness is separate from collection admission:
the replacement waits until both maintenance and the pending activation journal
are complete before starting a job. An interrupted update can therefore restore
its preceding runtime before any new-policy capture state is written. Manually
launching an older binary does not provide this version's redaction guarantees.

New content requests cannot resume a frozen capture under a different policy.
For source capture, the Host first reconciles Canonical status/receipts and Raw
cancellation/receipts. Confirmed activation or acknowledged bytes remain historical
evidence; unactivated candidates and unacknowledged obligations can be abandoned
before preparing available sources under the new policy. Unknown outcomes remain
pending. Already accepted history is not retroactively removed or re-redacted.

Legacy paged collection records policy identity, per-object policy and a durable
in-flight marker. Same-policy retries remain idempotent. A policy change after a
confirmed complete page can continue with newly prepared content; an uncertain
old request pauses because the legacy protocol has no equivalent receipt lookup.
Unbound old Raw objects also pause when a safe continuation cannot be established.
Preserve checkpoints and sources; resetting progress does not resolve uncertain
remote bytes. Claude's supported legacy-to-source migration retains its existing
adoption path.

## Content and resource boundaries

Canonical conversation/correlation identifiers stay stable. Content fields,
tool inputs/outputs, Raw values and source diagnostics are masked. Adapter authors
must keep secrets out of Canonical identifiers. Raw fields are content even when
named `id`. Field rules mask strings and matching numeric values; booleans/null
retain their type. Binary image/audio/resource bodies are not decoded or inspected.

The configuration admits at most 128 KiB, 128 custom rules, 2048 UTF-8 bytes per
expression and 64 KiB of expressions overall. Exact literals admit at most 2048
distinct values and 1 MiB overall. Content processing admits 32 MiB, depth 32,
100,000 nodes/tokens and 10,000 matches; decoding/traversal share these budgets.
The local file limit is smaller. Canonical failures stop preparation, Raw failures
record a limit/redaction gap, and diagnostic failures use a safe placeholder.

Full-session preview, project overrides, disabling protection, historical
re-redaction/deletion, OCR/audio/binary inspection and arbitrary replacement scripts
are outside this increment. Pattern matching can miss formats not covered by the
catalog or configured rules; use local samples to verify the rules you depend on.

The adapted Confab catalog and RE2JS carry MIT attribution in the CLI's
`THIRD_PARTY_NOTICES.md`; see [sources](../architecture/sources.md#redaction).
