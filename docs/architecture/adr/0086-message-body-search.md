# ADR-0086: Indexed message-body Search

- Status: Accepted
- Date: 2026-09-24

## Context

The deployed Search query scans roughly 320,000 Project documents, combines an
unindexed substring predicate with full-text ranking, and counts all matches before
returning 20. An observed query exceeded the Web 15-second deadline. The requested
scope is user and agent message bodies, including child Threads, not tool activity.

## Alternatives

1. Keep full-text ranking and add pg_trgm. This helps words but cannot index every
   one/two-character or punctuation-only substring; these remain full-index scans.
2. Add a remote search engine. It introduces another deployment and consistency
   boundary without evidence that the existing PostgreSQL capacity is exhausted.
3. Use PostgreSQL GIN over literal character grams, verify the original substring,
   and page by a stable timestamp/Event key. This preserves arbitrary body lookup
   without language tokenization, relevance sorting, or offset/count work.

## Decision

Choose the third design inside the existing Search Adapter. The Module Interface
continues to accept a Project, literal query and opaque cursor. Search indexes only
Canonical `kind=message` text. Titles, authors, tool labels and tool output are
navigation metadata, not match sources. Matching is case insensitive, retains
punctuation and whitespace inside the trimmed query, and is not fuzzy or semantic.

The index contains distinct one-, two-, and three-character grams of lowercased
body text. A query uses grams of width min(3, character length), followed by exact
substring verification, so gram intersections cannot produce false positives.
PostgreSQL GIN array containment supports even a single symbol or CJK character.
No extension or provider-specific parsing is required.

Results are ordered newest first, then Event ID descending. Keyset pagination
reads limit+1 and never counts all matches. Versioned cursors bind the Project and
query and reject old offset cursors with the existing validation Problem. Results
contain a bounded excerpt around the match; the existing Event anchor opens the
full message. Canonical and Raw remain unchanged.

Non-message projection rows retain identity, version and publication descriptor as
small tombstones with empty body/index. This preserves stale-worker protection and
checkpoint coverage when a message becomes a tool Event. Migration classifies old
rows from authoritative Canonical data and fixed publication members, strips tool
bodies, and builds the new index transactionally. Existing publication membership
and authorization checks remain mandatory at query time.

Search uses a bounded query lifetime, disables JIT for this interactive operation,
and requests custom plans so selective and common terms do not inherit a generic
prepared plan. Diagnostics record duration and outcome without query/body content.
The Web retains its bounded Project fan-out and explicit complete-page failures.

## Verification and rollout

Target: authorized Search Interface p95 <=1 second for first and subsequent pages,
at four concurrent queries over a representative corpus at least the deployed
364,000 total Events. Include absent, common, rare, multilingual, punctuation,
short and long-body matches, and verify paging, visibility and projection updates.
This is an evidenced capacity target, not an unbounded guarantee for every corpus
or hardware. Record measured hardware, corpus and tail latency in the owning guide.

Server rollout requires a migration window and sufficient index-building disk.
Old Server binaries must not run against the new Search schema. A paired backup
and the previous Server/database version are the rollback boundary. Package
publication is unnecessary. Production migration/deployment is a separate action.

## Consequences

The change trades larger character indexes and asynchronous projection cost for
bounded interactive reads. Short common terms can still have many candidates;
scale evidence must include them. Cross-Project global ranking and arbitrarily
large Project directories remain outside this increment. ADR-0005's durable
projection boundary and ADR-0035's workspace coordination remain intact.

## Comparative research (2026-09-24)

These are primary implementation/design sources, not vendor latency claims treated
as ATape benchmarks. Adopt the mechanism while retaining our authoritative Project
permissions and selected publication heads.

| System | Observed design | ATape decision |
| --- | --- | --- |
| [GitHub Blackbird](https://github.blog/engineering/the-technology-behind-githubs-new-code-search/) | Character ngram inverted lists, lazy intersections stop after enough results; indexing runs independently | Adopt indexed substring candidates and limit+1; avoid full match counts. Do not introduce its distributed infrastructure at this corpus size. |
| [Sourcegraph Zoekt](https://github.com/sourcegraph/zoekt/blob/main/doc/design.md) | Positional trigrams, selective gram pairs, UTF-8 rune offsets, immutable shards | Preserve exact verification and Unicode boundaries. Position indexes are a possible next increment if large-body false positives dominate measured latency; they add storage and replacement complexity. |
| [Session Search query](https://github.com/neonwatty/session-search/blob/main/menubar/Sources/SessionSearchQuery.swift) and [parser](https://github.com/neonwatty/session-search/blob/main/menubar/Sources/JSONLParser.swift) | SQLite FTS5, bounded snippets and LIMIT; recursively collects user/assistant content, including nested tool inputs/results | Adopt bounded result previews. Filter by Canonical Event kind rather than provider envelope role, which alone does not exclude tools. |
| [session-browser database](https://github.com/giannimassi/session-browser/blob/main/db.py) and [indexer](https://github.com/giannimassi/session-browser/blob/main/indexer.py) | Incremental file-mtime indexing, per-session FTS5, COUNT and OFFSET; skips subagent directories | Keep our durable change feed, message-level anchors and child Threads. Do not inherit full count/offset cost or omit subagents. |
| [Claude-Mem database architecture](https://github.com/thedotmack/claude-mem/blob/main/docs/public/architecture/database.mdx) | Separate FTS5 read models for observations, summaries and user prompts with update synchronization | Keep Search separate from Canonical/Raw; use original message bodies rather than generated observations to guarantee literal recall. |

[SQLite's trigram tokenizer](https://sqlite.org/fts5.html#the_trigram_tokenizer)
cannot MATCH a substring shorter than three Unicode characters; unsuitable LIKE
patterns fall back to scans. Similarly [PostgreSQL pg_trgm](https://www.postgresql.org/docs/17/pgtrgm.html)
falls back to full-index scans without extractable trigrams. These boundaries
justify explicit short-character grams. PostgreSQL's built-in [GIN array_ops](https://www.postgresql.org/docs/17/gin.html)
supports array containment, so the existing database can implement this without
adding a search daemon or extension. Tests must include separated grams that are
all present in a body but never form the requested contiguous string.
