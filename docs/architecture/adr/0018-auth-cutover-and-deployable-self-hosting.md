# ADR-0018: Authenticated Cutover and Deployable Self-Hosting

- Status: Accepted
- Date: 2026-09-06
- Supersedes: the unauthenticated deployment and rollback statements in
  [ADR-0010](0010-compose-self-hosting-topology.md)

## Context

ATape v0.1.1 persisted Teams, Projects, Canonical Sessions, Raw manifests and
chunks, and Search documents before it had a User identity. A v0.2 binary
cannot infer which newly authenticated User owns an existing Team, and it must
not accept new anonymous writes while an operator is deciding that mapping.
Fresh installations have no such ambiguity, but must use the same durable
schema and authenticated serving boundary.

The transition also has to remain fully self-hostable. Public origins,
Provider credentials, authentication key rings, PostgreSQL, Raw storage,
readiness, and recovery cannot depend on an ATape-operated control plane.

## Considered Designs

### Give every legacy Team to the first User who signs in

This is simple, but authentication order is not proof of ownership. A leaked or
mistyped public URL could permanently assign all history to the wrong account.

### Ask operators to edit rows with ad-hoc SQL

Manual SQL can express any mapping, but exposes persistence details, has no
stable review artifact, and makes partial application or concurrent writes hard
to detect and recover.

### Use a durable bootstrap phase and one cutover Module

Classify the installation during an additive migration, expose only login and
account routes while mapped history is unresolved, and let one deep Module own
planning, validation, locking, audit, and atomic application.

## Decision

ATape adopts the durable bootstrap design.

- Migration `000008_auth_cutover.sql` classifies a genuinely empty database as
  `fresh/completed`. Any database containing v0.1.1 Workspace, Canonical, Raw,
  Search, authentication, or session state becomes `mapped/prepared`.
- The migration adds explicit `legacy_anonymous` versus `authenticated`
  capture lineage and `unknown`, `linked`, or `not_applicable` repository-link
  state. It does not synthesize a User, Owner, Team slug, or repository match.
- `authcutover.Module` is the only cutover control surface. PostgreSQL rows,
  schema snapshot hashing, advisory locks, table locks, transaction isolation,
  mutation order, and audit writes remain in its Implementation.
- A mapped installation must start in `bootstrap` mode. The closed HTTP route
  registry then permits health, readiness, Instance discovery, Provider login,
  current-account, and Web Session management only. CLI authorization,
  Workspace, Team, Project, reads, Search, and ingestion return
  `cutover_incomplete` before authentication or request-body parsing.
- `auth-cutover users` lists candidate authenticated Users only during that
  bootstrap phase. `plan` accepts a versioned complete Team mapping and emits a
  non-secret plan containing canonical mapping and database snapshot digests,
  counts, intended changes, findings, and expected audit volume.
- `apply` requires the exact reviewed plan and mapping. It serializes with a
  maintenance advisory lock, locks every snapshotted relation, recomputes the
  snapshot, rejects stale or invalid input, and commits Team slugs, active
  Owners, per-Team audit, final audit, and completed ledger state in one
  transaction. Same-mapping replay is safe; a different post-completion mapping
  is rejected.
- Normal startup checks migration/cutover state, Team slug and active-Owner
  invariants, live authentication key and Provider revision references, and Raw
  storage writability. It conservatively records the first normal-serving time
  before listening.
- Once normal serving has been recorded, running an anonymous v0.1 binary is
  not a supported rollback. Incident response keeps the authenticated schema
  and rolls forward or restores a complete authenticated PostgreSQL + Raw
  backup. The v0.2 Compose contract supplies the database URL only through the
  new `_FILE` setting, so an image-only rollback to v0.1 fails its required
  database configuration instead of silently starting against retained data.
- The filesystem Raw Adapter implements the Chunk Store availability probe.
  HTTP consumes only `Raw Archive.CheckStorage`; switching to an object-store
  Adapter does not expose storage details to the transport.
- Production startup requires one active Provider registration. v0.2 ships a
  GitHub Federated Identity Adapter, while account, Session, CLI, Team, and
  authorization behavior continue to depend only on the Authentication Module
  and its normalized Provider Seam.
- Runtime secrets use Docker secret files and application `_FILE` settings.
  The default Compose topology is one Web/API origin. An override publishes the
  API on loopback for a second TLS virtual host. HTTP is accepted only for an
  explicitly enabled loopback development origin.
- Backup stops all application writers, captures PostgreSQL and filesystem Raw
  bytes, and records digests and cutover metadata. Restore validates and stages
  both sides, swaps them with recovery copies retained, starts the server, and
  removes the copies only after readiness succeeds.

## Consequences

- Legacy ownership requires an explicit human-reviewed mapping; a deployment
  cannot become anonymously writable or silently claim history while mapping
  is incomplete.
- Fresh and upgraded installations share the normal runtime after cutover.
- The migration and bootstrap process add operational steps, but each step is
  repeatable and leaves durable evidence.
- PostgreSQL and Raw storage still cannot be atomically snapshotted by one
  storage transaction. Quiescing writers plus staged paired restore is the
  supported consistency boundary.
- Authentication key rings are not included in data backups. Operators must
  retain the matching secret files in a separate encrypted backup or restored
  Sessions and pending transactions may be unusable.
- TLS termination, WAF rules, volumetric rate limiting, and encrypted off-host
  backup storage remain operator infrastructure responsibilities.

## Rejected Alternatives

- **First-login ownership**: authentication order is not authorization proof.
- **Ad-hoc SQL mapping**: leaks the persistence Implementation and cannot give
  stable stale-plan, crash, concurrency, replay, and audit guarantees.
- **Keep product routes online during mapping**: allows the reviewed snapshot
  to change and permits ambiguous new content.
- **Rollback by starting v0.1 against the upgraded database**: reopens the
  anonymous security boundary and cannot understand authenticated lineage.
- **ATape-hosted migration or secret service**: prevents complete independent
  deployment and creates infrastructure cost and trust that the product does
  not require.
