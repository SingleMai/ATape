# Workspace API

The Workspace endpoint is the query-time-filtered navigation view for every
Team and Project visible to the current User. It is `AnyPrincipal`: callers
send exactly one valid Web Session Cookie or CLI Credential, never both.

```http
GET /api/v1/workspace
Authorization: Bearer atc_v1_...
Accept: application/json
```

```json
{
  "teams": [
    {
      "id": "019...",
      "slug": "acme-engineering",
      "displayName": "Acme Engineering",
      "membership": { "role": "owner" },
      "createdAt": "2026-09-04T02:40:00Z",
      "updatedAt": "2026-09-04T02:40:00Z"
    }
  ],
  "projects": [
    {
      "id": "019...",
      "teamId": "019...",
      "type": "git",
      "name": "acme/payments-api",
      "state": "active",
      "repositoryLinkState": "linked",
      "repositoryIdentity": "github.com/acme/payments-api",
      "capturedThrough": "2026-09-04T02:52:18Z",
      "createdAt": "2026-09-04T02:41:00Z",
      "updatedAt": "2026-09-04T02:52:18Z"
    }
  ]
}
```

Teams and Projects are separate arrays so callers can index them without
nesting or duplicating Team metadata. `git` identifies a normalized repository
remote; `folder` identifies an explicitly created ordinary-folder Project. A
migrated Git Project reports `repositoryLinkState: "unknown"` until a fresh
Owner relink or an explicit CLI selection establishes a trusted remote.
A local filesystem path is CLI configuration and never enters this response.

Membership removal, User disable, and Project deletion affect the next read
without an ACL cache invalidation protocol. Every success and Problem response
uses `Cache-Control: no-store` and carries a server-generated `X-Request-ID`.
