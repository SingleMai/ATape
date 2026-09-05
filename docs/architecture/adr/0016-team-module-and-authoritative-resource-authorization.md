# ADR-0016: Team Module and Authoritative Resource Authorization

- Status: Accepted
- Date: 2026-09-06

## Context

ATape shares captured conversations within a Team. Web and CLI callers need
different capabilities, Membership changes must take effect without cached ACL
state, and a guessed identifier must not reveal whether another Team owns a
Resource. Team creation, Join Codes, Membership roles, Project identity, and
last-Owner protection also form one transactional control plane.

The existing ingestion alpha accepted client-declared User, Team, Project, Raw
object, and chunk identity. Treating those fields as authority would allow
horizontal escalation and would couple every Adapter to ATape account details.

## Considered Interfaces

### Deep Team Module plus pure policy

Expose use-case-shaped Team and Project operations. Pass an authenticated
Principal explicitly into each protected business Module. The Module that owns
the operation loads current Membership and Resource facts, then applies one
closed, side-effect-free authorization policy at its atomic enforcement point.

### Central authorization service

Send every check to a generic service that owns Membership and Resource
lookups. This centralizes calls, but either duplicates ownership data or makes
the service depend on every business schema. It also separates the check from
the write transaction and creates time-of-check/time-of-use gaps.

### Signed claims or client-declared ownership

Put roles and Resource ownership in bearer claims or ingestion payloads. This
reduces database reads but makes removal and role changes stale, exposes ATape
business details to Adapters, and lets callers select an authority namespace.

## Decision

ATape uses a deep `team.Module`, an in-process pure `authorization.Policy`, and
authoritative enforcement inside each action-owning Module.

- Authentication establishes a `Principal` containing the User and credential
  method. HTTP middleware may translate a credential into that Principal, but
  it does not decide Resource authorization.
- Protected Module Interfaces accept the Principal explicitly. Presentation
  code only translates inputs, results, and typed failures.
- The policy has a closed Action and Resource catalog and returns `Allow`,
  `Conceal`, or `Forbid`. Unknown Actions, Resource kinds, credential methods,
  or roles fail closed.
- `Conceal` makes a missing Resource and a real Resource outside the caller's
  visible Teams indistinguishable. `Forbid` is reserved for a visible Resource
  where the credential capability, role, or freshness is insufficient.
- The action-owning Module loads current Resource and Membership facts in the
  same PostgreSQL transaction or consistent read snapshot as the operation.
  Search and Raw may consult Canonical control-plane facts through narrow
  consumer-owned Interfaces; neither stores a Membership or ACL copy.
- Teams have only `Owner` and `Member`. There are no custom roles, per-Project
  ACLs, or independent machine principals. Active members may create Projects,
  ingest with their own CLI Credential, and read Team data. Owner-only and
  fresh-authentication actions are fixed by the policy catalog.
- The Team Module owns Team creation, case-normalized slugs, Membership
  lifecycle, six-character case-insensitive Join Codes, code rotation and
  disable, and Git/Folder Project lifecycle. Join Code plaintext is returned
  once and only a purpose-separated HMAC digest is persisted.
- Team and Membership mutations lock a Team before changing Owner state. User
  disable participates in the same ordering. Concurrent leave, role change,
  removal, and disable operations cannot leave an active Team without one
  active Owner.
- A Git Project is matched by a normalized repository remote identity within a
  Team. A Folder Project is named explicitly. Local filesystem paths remain
  CLI configuration and never become server Resource identity.
- Archived Projects remain readable but reject Canonical and Raw ingestion.
  Deleted Projects and their derived data are concealed.
- Canonical v1 derives Session, Thread, Event, and Raw-reference identities
  using the authenticated User plus the target Project and source-local
  identifiers. Raw v1 derives object and chunk IDs on the server and permits
  append only by the User who captured the Canonical Session.
- PostgreSQL row/advisory locks, idempotency receipts, audit ordering, retries,
  and query shapes are private Implementation details. Integration tests use
  real PostgreSQL through the public Module Interfaces.

## Consequences

- Membership removal and User disable affect later operations without a cache
  invalidation protocol.
- Replacing a federated login Provider or Authentication Adapter cannot change
  Team, Project, ingestion, Raw, Search, or conversation authorization rules.
- Resource reads incur an authoritative relational lookup, accepted in return
  for revocation correctness and a self-hosted single-database topology.
- Canonical and Raw v1 are deliberate pre-launch breaking changes from their
  alpha payloads. Old client authority fields are rejected as unknown input.
- HTTP status and Problem translation remain a Presentation concern and may be
  introduced without changing policy outcomes or business Interfaces.

## Rejected Alternatives

- **Generic authorization service**: weakens Locality and cannot atomically own
  every protected business operation.
- **JWT role or ACL claims**: creates stale authorization after Membership or
  User lifecycle changes.
- **Per-Project ACLs**: add a second sharing model without a v1 product need.
- **Client-declared User/Team/ownership fields**: expose business internals to
  Adapters and permit authority confusion.
