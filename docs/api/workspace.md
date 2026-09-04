# Workspace API

The Workspace Directory is the navigation read model for all Teams and Projects visible to the current user. v0.1 exposes all Projects to every Team member; the response shape does not imply future authorization policy.

```http
GET /api/v1/workspace
Accept: application/json
```

```json
{
  "teams": [
    {
      "id": "acme-engineering",
      "name": "Acme Engineering",
      "projects": [
        {
          "id": "payments-api",
          "name": "payments-api",
          "type": "git",
          "capturedThrough": "2026-09-04T02:52:18Z",
          "sessionCount": 3,
          "activeSessionCount": 2
        },
        {
          "id": "support-notes",
          "name": "support-notes",
          "type": "directory",
          "sessionCount": 0,
          "activeSessionCount": 0
        }
      ]
    }
  ]
}
```

Teams and Projects are ordered for display by the Workspace Module. Counts and capture watermarks are navigation hints; Session and Event payloads remain in the Project Memory and conversation APIs.

`git` identifies a configured Git repository and `directory` identifies an explicitly configured ordinary folder. A local path is never included in this response.
