# Controlled OpenCode v1 source fixture

`native-v1.json` contains the Session/message/part rows, the three matching
`session.created.1` events, and their table/index DDL from
the isolated OpenCode **1.18.30** native fixture produced on 2026-09-10, plus the
official CLI exports for root, child and fork. The source commit is
[`3104c1428ec91f809e5ab86631300de41eb6952e`](https://github.com/anomalyco/opencode/tree/3104c1428ec91f809e5ab86631300de41eb6952e).

The official binary created the source schema and records through its public
API: user `noReply` prompts, a controlled shell output, a child Session, a fork,
a text update with open metadata, and compaction with a loopback model stub.
No user history, credentials or paid model requests were used. The original
JSON TEXT columns remain strings in this fixture; parsing the outer fixture
recovers their original text rather than a reconstructed provider JSON object.

The [native research observations](https://github.com/SingleMai/ATape/blob/6d1c082db48793dff8a48050552b2a7fc586be14/packages/application/prototypes/opencode-native/OBSERVATIONS.md)
record binary hashes, isolation, API operations, source/export parity and
limitations. The JSON here is a selected readback of that actual fixture, not
the provider's entire database: credentials, the rest of the event log and unrelated
tables are excluded. Test setup recreates its selected tables in a temporary SQLite file
and compares every hydrated message and part through the production source
Interface with the official export. Other tests explicitly use synthetic data
for mutations, malformed sources and capacity failures.

The production source Interface was also run directly against the retained
official database on macOS arm64 / Node 24.18.0: 3 Sessions, 9 messages and 11
parts matched the exports, with unchanged database mtime. The committed fixture
makes those content comparisons available to CI; it does not substitute for
running OpenCode on every supported release platform or prove a version range.
