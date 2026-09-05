import http from "node:http"

const address = "127.0.0.1"
const port = 8080
const now = "2026-09-05T00:00:00Z"
const later = "2027-03-04T00:00:00Z"

const initialState = () => ({
  cliDecision: "none",
  cliResolveCount: 0,
  failSessions: false,
  fresh: false,
  joinCodeEnabled: true,
  webSessions: ["session-current", "session-other"],
  cliCredentials: ["credential-one"],
  teamCreateBody: null,
  teamCreateIdempotencyKey: null,
  teamJoinBody: null
})

let state = initialState()

const user = { id: "user-1", displayName: "Mai", avatarUrl: "" }
const team = {
  id: "team-id",
  slug: "team-a",
  displayName: "Team A",
  membership: { role: "owner" },
  createdAt: now,
  updatedAt: now
}

const json = (response, status, body, headers = {}) => {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  })
  response.end(JSON.stringify(body))
}

const empty = (response, status = 204, headers = {}) => {
  response.writeHead(status, { "Cache-Control": "no-store", ...headers })
  response.end()
}

const problem = (response, status, code) => json(response, status, {
  type: `https://atape.dev/problems/v1/${code}`,
  title: code,
  status,
  code,
  detail: code === "fresh_authentication_required"
    ? "Reauthenticate before performing this action."
    : "The requested operation could not be completed.",
  instance: "urn:atape:request:fixture",
  requestId: "fixture-request"
}, { "Content-Type": "application/problem+json; charset=utf-8" })

const readBody = async (request) => {
  let encoded = ""
  for await (const chunk of request) encoded += chunk
  return encoded === "" ? {} : JSON.parse(encoded)
}

const signedIn = (request) => (request.headers.cookie ?? "").includes("fixture_session=1")

const requireWeb = (request, response) => {
  if (signedIn(request)) return true
  problem(response, 401, "unauthenticated")
  return false
}

const requireCSRF = (request, response) => {
  if (!requireWeb(request, response)) return false
  if (request.headers["x-atape-csrf"] === "csrf-fixture") return true
  problem(response, 403, "csrf_rejected")
  return false
}

const routeFixtureControl = (request, response, url) => {
  if (url.pathname === "/__fixture/state" && request.method === "GET") {
    json(response, 200, state)
    return true
  }
  if (url.pathname === "/__fixture/reset" && request.method === "POST") {
    state = initialState()
    empty(response)
    return true
  }
  if (url.pathname === "/__fixture/fail-sessions" && request.method === "POST") {
    state.failSessions = url.searchParams.get("value") === "1"
    empty(response)
    return true
  }
  if (url.pathname === "/__fixture/fresh" && request.method === "POST") {
    state.fresh = url.searchParams.get("value") === "1"
    empty(response)
    return true
  }
  return false
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${address}:${port}`)
  const path = url.pathname

  if (path === "/healthz") return json(response, 200, { status: "ok" })
  if (routeFixtureControl(request, response, url)) return

  if (path === "/api/v1/instance" && request.method === "GET") {
    return json(response, 200, {
      protocol: "atape.instance.v1",
      instance_origin: "http://127.0.0.1:4187",
      web_origin: "http://127.0.0.1:4187",
      api_origin: "http://127.0.0.1:4187",
      protocols: ["atape.cli-authorization.v1"]
    })
  }
  if (path === "/api/v1/auth/provider-registrations" && request.method === "GET") {
    return json(response, 200, { items: [{ id: "github-main", label: "GitHub" }] })
  }
  if (path === "/api/v1/auth/session" && request.method === "GET") {
    if (!requireWeb(request, response)) return
    return json(response, 200, {
      user,
      webSession: {
        id: "session-current",
        createdAt: now,
        lastUsedAt: now,
        reauthenticatedAt: now,
        absoluteExpiresAt: later,
        current: true
      },
      csrfToken: "csrf-fixture"
    })
  }
  if (path === "/api/v1/auth/federated/sign-ins" && request.method === "POST") {
    await readBody(request)
    return json(response, 201, {
      loginTransactionId: "login-fixture",
      authorizationUri: "https://github.com/login/oauth/authorize?state=fixture",
      expiresAt: later
    })
  }
  if (path === "/api/v1/auth/federated/reauthentications" && request.method === "POST") {
    if (!requireCSRF(request, response)) return
    await readBody(request)
    return json(response, 201, {
      loginTransactionId: "reauth-fixture",
      authorizationUri: "https://github.com/login/oauth/authorize?state=fixture",
      expiresAt: later
    })
  }
  if (path === "/api/v1/auth/logout" && request.method === "POST") {
    if (!requireCSRF(request, response)) return
    return empty(response, 204, { "Set-Cookie": "fixture_session=; Path=/; Max-Age=0" })
  }
  if (path === "/api/v1/workspace" && request.method === "GET") {
    if (!requireWeb(request, response)) return
    return json(response, 200, {
      teams: [team],
      projects: [{
        id: "project-1",
        teamId: team.id,
        type: "git",
        name: "ATape",
        state: "active",
        repositoryIdentity: "github.com/SingleMai/ATape",
        capturedThrough: now,
        createdAt: now,
        updatedAt: now
      }]
    })
  }
  if (path === "/api/v1/users/me/external-identities" && request.method === "GET") {
    if (!requireWeb(request, response)) return
    return json(response, 200, { items: [{
      id: "identity-one",
      providerRegistrationId: "github-main",
      displayName: "singlemai",
      avatarUrl: "",
      createdAt: now,
      lastVerifiedAt: now
    }] })
  }
  if (path === "/api/v1/users/me/web-sessions" && request.method === "GET") {
    if (!requireWeb(request, response)) return
    if (state.failSessions) return problem(response, 503, "service_unavailable")
    return json(response, 200, { items: state.webSessions.map((id) => ({
      id,
      createdAt: now,
      lastUsedAt: now,
      reauthenticatedAt: now,
      absoluteExpiresAt: later,
      current: id === "session-current"
    })) })
  }
  if (path === "/api/v1/users/me/cli-credentials" && request.method === "GET") {
    if (!requireWeb(request, response)) return
    return json(response, 200, { items: state.cliCredentials.map((id) => ({
      id,
      capability: "atape-cli.v1",
      createdAt: now,
      lastUsedAt: now
    })) })
  }
  if (path === "/api/v1/users/me/web-sessions/revoke-all" && request.method === "POST") {
    if (!requireCSRF(request, response)) return
    state.webSessions = []
    return empty(response, 204, { "Set-Cookie": "fixture_session=; Path=/; Max-Age=0" })
  }
  if (path.startsWith("/api/v1/users/me/web-sessions/") && request.method === "DELETE") {
    if (!requireCSRF(request, response)) return
    const id = decodeURIComponent(path.split("/").at(-1))
    state.webSessions = state.webSessions.filter((item) => item !== id)
    return empty(response)
  }
  if (path === "/api/v1/users/me/cli-credentials/revoke-all" && request.method === "POST") {
    if (!requireCSRF(request, response)) return
    state.cliCredentials = []
    return empty(response)
  }
  if (path.startsWith("/api/v1/users/me/cli-credentials/") && request.method === "DELETE") {
    if (!requireCSRF(request, response)) return
    const id = decodeURIComponent(path.split("/").at(-1))
    state.cliCredentials = state.cliCredentials.filter((item) => item !== id)
    return empty(response)
  }
  if (path === "/api/v1/auth/cli/device-grants/resolve" && request.method === "POST") {
    if (!requireCSRF(request, response)) return
    state.cliResolveCount++
    const input = await readBody(request)
    if (input.user_code !== "Q7KM-4WDP") return problem(response, 400, "invalid_user_code")
    return json(response, 200, {
      grantViewId: "grant-view-one",
      userCode: "Q7KM-4WDP",
      instanceOrigin: "http://127.0.0.1:4187",
      clientLabel: "atape-cli",
      capabilityVersion: "atape-cli.v1",
      permissionSummary: "Read and sync this account's ATape projects.",
      expiresAt: later,
      status: state.cliDecision === "approve"
        ? "approved_unclaimed"
        : state.cliDecision === "deny" ? "denied" : "pending"
    })
  }
  if (/^\/api\/v1\/auth\/cli\/device-grants\/[^/]+\/(approve|deny)$/.test(path) && request.method === "POST") {
    if (!requireCSRF(request, response)) return
    state.cliDecision = path.endsWith("/approve") ? "approve" : "deny"
    return empty(response)
  }
  if (path === "/api/v1/teams/team-a" && request.method === "GET") {
    if (!requireWeb(request, response)) return
    return json(response, 200, team)
  }
  if (path === "/api/v1/teams/team-a/members" && request.method === "GET") {
    if (!requireWeb(request, response)) return
    return json(response, 200, { items: [
      { userId: user.id, displayName: user.displayName, avatarUrl: "", role: "owner", joinedAt: now, updatedAt: now },
      { userId: "user-2", displayName: "Rin", avatarUrl: "", role: "member", joinedAt: now, updatedAt: now }
    ] })
  }
  if (path === "/api/v1/teams/team-a/join-code" && request.method === "GET") {
    if (!requireWeb(request, response)) return
    return json(response, 200, { enabled: state.joinCodeEnabled, generation: 2, updatedAt: now })
  }
  if (path === "/api/v1/teams/team-a/join-code/rotations" && request.method === "POST") {
    if (!requireCSRF(request, response)) return
    if (!state.fresh) return problem(response, 401, "fresh_authentication_required")
    state.joinCodeEnabled = true
    return json(response, 201, { code: "K7M4PX", generation: 3, rotatedAt: now })
  }
  if (path === "/api/v1/teams/team-a/join-code" && request.method === "DELETE") {
    if (!requireCSRF(request, response)) return
    state.joinCodeEnabled = false
    return empty(response)
  }
  if (/^\/api\/v1\/teams\/team-a\/members\/[^/]+\/role$/.test(path) && request.method === "PUT") {
    if (!requireCSRF(request, response)) return
    const input = await readBody(request)
    return json(response, 200, { teamId: team.id, userId: "user-2", role: input.role, status: "active" })
  }
  if (/^\/api\/v1\/teams\/team-a\/members\/[^/]+$/.test(path) && request.method === "DELETE") {
    if (!requireCSRF(request, response)) return
    return empty(response)
  }
  if (path === "/api/v1/teams/team-a/leave" && request.method === "POST") {
    if (!requireCSRF(request, response)) return
    return problem(response, 409, "last_owner_required")
  }
  if (path === "/api/v1/teams" && request.method === "POST") {
    if (!requireCSRF(request, response)) return
    state.teamCreateBody = await readBody(request)
    state.teamCreateIdempotencyKey = request.headers["idempotency-key"] ?? null
    return json(response, 201, {
      ...team,
      id: "created-team",
      slug: state.teamCreateBody.slug,
      displayName: state.teamCreateBody.displayName
    })
  }
  if (path === "/api/v1/team-memberships" && request.method === "POST") {
    if (!requireCSRF(request, response)) return
    state.teamJoinBody = await readBody(request)
    return json(response, 201, { ...team, membership: { role: "member" } })
  }

  problem(response, 404, "not_found")
})

server.listen(port, address)

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
