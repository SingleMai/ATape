# Authentication HTTP v1

ATape exposes one first-party HTTP contract for browser and CLI callers. It is
not a general OAuth authorization server. Provider-specific tokens and claims
stop at a `FederatedIdentityAdapter`; HTTP receives only normalized identity
results from the Authentication Module.

The complete schema and executable route metadata are in
[OpenAPI v1](openapi-v1.yaml). Every operation declares one closed route class,
its body ceiling, cache policy, Origin policy, fresh-authentication guard, and
whether `Idempotency-Key` is required. A contract test compares those values to
the actual Go route registry.

## Credential boundary

- `PublicProtocol` never creates an optional Principal and ignores ambient
  Cookies or Authorization headers.
- `AnyPrincipal` accepts exactly one valid Web Session or CLI Credential.
- `WebOnly` accepts only the Session Cookie. Unsafe methods require an exact
  canonical Web `Origin` and the Session-bound `X-ATape-CSRF` value returned by
  `GET /api/v1/auth/session`.
- `CLIOnly` accepts `Authorization: Bearer atc_v1_...` only.

A protected request containing both credentials, duplicate Session Cookies, or
duplicate Authorization headers returns `400 ambiguous_credentials`. Resource
authorization is not middleware behavior: each action-owning Module receives
the typed Principal, loads current Resource and Membership facts, and enforces
the policy at its transaction boundary.

In a split-subdomain deployment, CORS exposes only `ETag`, `Retry-After`, and
`X-Request-ID` to the exact configured Web origin; it never reflects arbitrary
request headers or origins.

## Browser sign-in

The Web application reads enabled entries from
`GET /api/v1/auth/provider-registrations`, then posts a registration and local
`returnTo` path to one of the three distinct begin routes:

- `/api/v1/auth/federated/sign-ins`;
- `/api/v1/auth/federated/identity-bindings`;
- `/api/v1/auth/federated/reauthentications`.

The response stores a short-lived host-only login-binding Cookie and returns a
Provider authorization URI for top-level navigation. The exact GitHub callback
accepts only bounded `state`, `code`, or `error` values. It clears the binding
Cookie and redirects to either the transaction's stored local return path or a
fixed safe error page. Provider descriptions, codes, state, subjects, and
tokens are never reflected.

The Session Cookie is topology-derived. A same-host HTTPS deployment uses a
host-only `__Host-atape_session`; a split Web/API subdomain deployment uses one
domain-scoped `__Secure-atape_session`. HTTP Cookies are allowed only for an
explicit loopback development topology. The default Session policy has a
180-day absolute lifetime, a 30-day idle lifetime, and a 15-minute
fresh-authentication window; revocation and User disable take effect on the
next authenticated request.

## CLI sign-in

The CLI posts `{}` to `/api/v1/auth/cli/device-grants`, opens the returned
`verification_uri_complete`, and polls `/api/v1/auth/cli/token` using the
opaque Device Code. The browser resolves the six-character, case-insensitive
User Code and explicitly approves or denies the non-secret grant view. A CLI
Credential is returned exactly once and is stored by the CLI under `~/.atape`.

Polling is bounded by the server-provided interval. Pending returns `202`, an
early poll returns `429 slow_down` with `Retry-After`, and terminal outcomes are
typed Problems. `DELETE /api/v1/auth/cli/credentials/current` performs a
proof-bound, idempotent logout; replaying the just-revoked bearer remains `204`.

## Errors, caching, and redirects

Every JSON error is an RFC 9457 `application/problem+json` document whose type
is `https://atape.net/problems/v1/{code}`. Missing and concealed Resources use
the same data-poor `404 not_found` representation. Each response has a
server-generated `X-Request-ID`, which is correlation only and never authority
or an idempotency key.

Authenticated data, auth workflows, Problems, and responses carrying Cookies
use `Cache-Control: no-store`. Instance discovery and enabled Provider entries
are the only publicly cacheable JSON responses; they use five-minute caching
plus an ETag. Federated callback is the only redirecting API operation.

## Production startup configuration

The server derives all public values from explicit configuration and ignores
`Host`, `Forwarded`, and `X-Forwarded-*` when constructing origins, redirects,
Cookies, or callback URIs.

Required outside explicit demo mode:

- `ATAPE_DATABASE_URL` or `_FILE`;
- `ATAPE_RAW_DIRECTORY`;
- `ATAPE_PUBLIC_URL`, the canonical Web and Instance origin;
- `ATAPE_AUTH_PEPPER_KEY_RING` or `_FILE`;
- `ATAPE_AUTH_PRIVATE_STATE_KEY_RING` or `_FILE`;
- at least one active Provider registration. v0.2 requires the GitHub Client ID
  and Client Secret while GitHub is the shipped Adapter.

Demo mode is an in-memory development Adapter, not an authentication setting:
startup rejects it when a durable database is configured or the listener is
not an explicit loopback address.

`ATAPE_API_PUBLIC_URL` defaults to `ATAPE_PUBLIC_URL`. Split subdomains also
require `ATAPE_COOKIE_DOMAIN`. GitHub requires both
`ATAPE_GITHUB_CLIENT_ID` and `ATAPE_GITHUB_CLIENT_SECRET` (or the secret's
`_FILE` form); missing or partial configuration fails startup.
The callback registered in that self-hosted GitHub OAuth App must be the
canonical `${ATAPE_API_PUBLIC_URL}/api/v1/auth/github/callback` (or the
`ATAPE_PUBLIC_URL` equivalent when both origins are the same).

Each key ring is one strict JSON object. Values are base64-encoded 32-byte
keys, and the active key must also remain in `keys` while older persisted state
can reference it:

```json
{
  "active": "2026-09-a",
  "keys": {
    "2026-09-a": "<base64-encoded-32-byte-key>",
    "2026-06-a": "<previous-key-kept-during-rotation>"
  }
}
```

Secret files are bounded to 64 KiB. Direct and `_FILE` forms are mutually
exclusive, and startup fails closed for missing, malformed, unsafe-origin, or
partial Provider configuration.

`ATAPE_AUTH_CUTOVER_MODE` defaults to `normal`. Only an operator performing the
reviewed v0.1.1 ownership transition sets it to `bootstrap`; see the
[cutover runbook](../operations/auth-cutover.md). Production readiness also
checks the durable cutover state and Raw Chunk Store availability.

## Idempotent creation

Team and Project creation require a 128-bit `Idempotency-Key`. A replay with
the same canonical input returns the original Resource, changed input returns
`409 idempotency_conflict`, and a concurrent in-flight operation returns
`409 idempotency_in_progress` with `Retry-After` instead of occupying a server
request while waiting on another transaction.
