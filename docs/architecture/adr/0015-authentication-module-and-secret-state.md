# ADR-0015: Deep Authentication Module and Opaque Secret State

- Status: Accepted
- Date: 2026-09-05

## Context

ATape needs one authentication boundary for browser sign-in, External Identity
binding, revocable Web Sessions, and the CLI Device Authorization flow. The
implementation must remain correct across process restarts and multiple server
replicas. Provider tokens and raw claims must stay inside a Federated Identity
Adapter, while PostgreSQL rows, locks, digests, encryption keys, and retry
rules must not leak into HTTP handlers or future Team authorization code.

Authentication is a consequential Interface: Web, CLI, middleware, account
management, and every protected product Module will depend on the Principal it
establishes.

## Considered Interfaces

### One use-case-shaped Authentication Module

Expose a concrete `authentication.Module` with operations such as beginning
and completing a federated login, authenticating or revoking a Web Session,
creating and deciding a CLI Device Authorization, claiming or revoking a CLI
Credential, and bounded maintenance. Keep PostgreSQL and cryptography private.
The only replaceable production Seam is the small `FederatedIdentityAdapter`
used by configured Provider Registrations.

### Separate identity, session, and device services

Expose independent `IdentityService`, `SessionService`, and `DeviceService`
Interfaces. Each surface is initially smaller, but federated completion, User
disable, audit, and credential rotation span those services. Their callers
would have to own transaction order or a fourth coordinator would repeat all
three Interfaces.

### Generic repositories and state-transition commands

Expose repositories for each authentication table plus a generic transition
API. This is flexible for tests, but makes callers learn persistence states,
row versions, digest lookup, and transaction sequencing. It also permits
invalid workflows that no product use case needs.

## Decision

ATape uses one concrete, use-case-shaped `authentication.Module`.

- The Module owns User and External Identity resolution, Federated Login
  Transaction state, Web Session secret generations, CLI Device Authorization,
  CLI Credentials, Security Audit Events, transaction scope, and maintenance.
- PostgreSQL is a local-substitutable Implementation dependency, not a public
  Repository Seam. Integration tests use real PostgreSQL through the same
  exported operations as production callers.
- A `FederatedIdentityAdapter` is the sole Provider Seam. It exposes only
  `Begin` and `Complete`; opaque PrivateState crosses the calls, and only a
  normalized Verified External Identity enters Authentication.
- Provider Registrations are typed startup configuration. Transactions pin a
  registration revision so rolling deployments may retain an older revision
  for in-flight callbacks.
- High-entropy bearer values are stored only as domain-separated SHA-256
  digests. Human-entered codes use purpose-separated HMAC keys derived from a
  versioned pepper ring. Opaque Provider state uses AES-256-GCM with associated
  data bound to the login transaction.
- The Module uses database time and authoritative reads on every
  authentication. It does not issue JWTs or cache User, Session, Credential, or
  Membership authority.
- Public values are domain results and typed failures. SQL rows, `pgx.Tx`, key
  material, digests, retry categories, and audit insert ordering remain private.
- Fx only constructs and owns the Module in the executable Composition Root.

The Interface may grow with coherent account lifecycle operations, but it must
not be split merely to make mocking convenient. Team Membership and resource
authorization remain separate Modules and consume only `Principal`.

## Consequences

- Replacing GitHub with another identity system requires a new Federated
  Identity Adapter and Provider Registration, without changing User, Session,
  CLI, Team, or HTTP domain behavior.
- Cross-cutting authentication mutations can commit their state and Security
  Audit Event atomically.
- Tests are slower than mock-based repository tests, but they exercise the
  unique constraints, row locks, advisory locks, and multi-replica behavior on
  which the Interface guarantees depend.
- The Module is intentionally unavailable in in-memory demo mode. A production
  authentication boundary cannot silently fall back to process-local state.

## Rejected Alternatives

- **Separate identity/session/device services**: reduces Depth and moves
  transaction knowledge into coordinators and callers.
- **Per-table repositories**: exposes the Implementation and makes invalid
  state transitions representable.
- **JWT or self-contained permission claims**: cannot provide immediate User,
  Session, Credential, or future Membership revocation.
- **Redis or process-local login state**: adds self-hosting infrastructure or
  loses correctness across replicas and restarts.
- **Reversible bearer-secret storage**: expands the consequence of a database
  disclosure without enabling a required use case.
