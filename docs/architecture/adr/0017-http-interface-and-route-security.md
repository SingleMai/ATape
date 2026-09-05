# ADR-0017: Closed HTTP Interface and Route Security Contract

- Status: Accepted
- Date: 2026-09-06

## Context

ATape's browser and CLI need one stable `/api/v1` translation boundary over
Authentication, Team, Canonical ingestion, conversation, Search, Workspace,
and Raw Modules. Cookie/Bearer ambiguity, Origin and CSRF rules, body limits,
Problem Details, cache behavior, and callback redirects must be uniform. If
each handler chooses those behaviors independently, adding a Provider or a
business route can silently create a weaker security path.

This Interface is also the pre-launch breaking cutover from anonymous alpha
ingestion to server-established Principals. HTTP DTOs must not become domain
types, and middleware must not become a second resource-authorization system.

## Considered designs

### Closed route registry around standard-library routing

Register every route with one mandatory access class and transport policy.
Compose request security and credential authentication once, then call concrete
deep Modules. Keep OpenAPI as a Presentation artifact and continuously compare
its route metadata to the executable registry.

### Framework middleware attached per handler

A router framework could attach authentication, validation, and error helpers
near each endpoint. That reduces initial boilerplate but makes omission the
default, scatters precedence rules, and places correctness in framework
conventions rather than an inspectable ATape contract.

### Generated transport services as domain Interfaces

Generate handler Interfaces and domain values from OpenAPI. This keeps wire
schemas synchronized mechanically, but reverses the dependency direction:
business Modules would inherit HTTP optionality, naming, and versioning.

## Decision

ATape uses the standard-library `http.ServeMux` behind one concrete `httpapi`
Adapter and a closed route registry.

- Every route declares exactly one of `PublicProtocol`, `AnyPrincipal`,
  `WebOnly`, or `CLIOnly`. Registration without a class, request-body policy,
  handler, or cache policy fails startup.
- `RouteInventory` exposes method, path, class, body ceiling, cache policy,
  Origin policy, fresh-authentication guard, and idempotency requirement as
  machine-readable Presentation metadata.
- Request security runs before handler decoding. Public routes ignore ambient
  credentials. Protected routes reject duplicate or mixed Cookie/Bearer proof.
  Web unsafe methods require exact configured Origin and Session-bound CSRF;
  CLI unsafe calls do not inherit browser CSRF semantics.
- Web and CLI logout retain their proof-specific idempotency behavior even
  immediately after revocation. Those narrow exceptions remain registered as
  `WebOnly` and `CLIOnly`; they do not establish an optional Principal for
  ordinary product calls.
- Body policy is route-owned. Strict JSON decoding accepts one
  `application/json` object, rejects unknown/trailing fields, and enforces the
  16 KiB auth, 64 KiB control-plane, 4 MiB Canonical, and 512 KiB Raw ceilings;
  routes declared without a body reject one rather than silently ignoring it.
- All JSON failures use one RFC 9457 registry. Authentication challenges,
  `Retry-After`, `Allow`, request correlation, no-store behavior, and public
  metadata ETags are transport-owned and data-poor.
- Public origins and Cookie shape come only from validated startup config.
  Request `Host` and forwarding headers cannot influence callback URI,
  redirects, discovery, CORS, or Cookie scope.
- `docs/api/openapi-v1.yaml` is OpenAPI 3.1 and remains a Presentation
  contract. Tests compare all executable routes and every Problem code to it;
  generated schemas never flow inward into Module Interfaces.
- Fx constructs the concrete Modules and HTTP Adapter only in the executable
  Composition Root. Fx does not enter a business Module.

Resource policy remains in each action-owning Module. In particular, captured
Session deletion is an ingestion lifecycle operation: its Implementation
authorizes against current Membership, commits a durable tombstone and audit,
and makes Canonical, Raw, and Search reads unavailable. HTTP only translates
the path, Principal, request ID, result, and typed failure. Physical Raw byte
reclamation is a later bounded GC concern.

## Consequences

- A new route cannot accidentally become public or silently inherit a default
  body/cache policy.
- Replacing or adding a Federated Identity Adapter does not alter User,
  Session, CLI, Team, resource authorization, or general HTTP schemas. A
  Provider may add its own exact callback route while reusing the same begin
  and normalized identity contract.
- The route table is intentionally explicit and somewhat repetitive. That
  repetition buys reviewable security policy and contract-drift failures.
- Standard-library routing avoids a framework dependency; shared middleware
  and response code remain internal to the Adapter.
- OpenAPI describes the wire and supports client tooling, while handwritten
  translation protects Module Depth and Locality.

## Rejected alternatives

- **Per-handler security choices**: omission and precedence drift are unsafe.
- **Optional Principal middleware**: public output could vary with ambient
  Cookies and protected handlers could forget to require authentication.
- **Central HTTP authorization service**: cannot atomically own every business
  Resource and would duplicate Membership logic outside its Module.
- **OpenAPI-generated domain model**: couples internal invariants to transport
  naming and compatibility constraints.
