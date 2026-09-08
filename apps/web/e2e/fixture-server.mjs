import http from "node:http"

const address = "127.0.0.1"
const port = 8080
const now = "2026-09-05T00:00:00Z"
const later = "2027-03-04T00:00:00Z"

const initialState = () => ({
  cliDecision: "none",
  cliResolveCount: 0,
  conversationRequests: 0,
  failConversation: false,
  projectMemoryRequests: 0,
  failCredentials: false,
  fresh: false,
  joinCodeEnabled: true,
  cliCredentials: ["credential-one"],
  teamCreateBody: null,
  teamCreateIdempotencyKey: null,
  teamJoinBody: null,
  workspaceMode: "full",
  createdTeam: null,
  createdProjectVisible: false
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
  type: `https://atape.net/problems/v1/${code}`,
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
  if (url.pathname === "/__fixture/fail-credentials" && request.method === "POST") {
    state.failCredentials = url.searchParams.get("value") === "1"
    empty(response)
    return true
  }
  if (url.pathname === "/__fixture/fail-conversation" && request.method === "POST") {
    state.failConversation = url.searchParams.get("value") === "1"
    empty(response)
    return true
  }
  if (url.pathname === "/__fixture/fresh" && request.method === "POST") {
    state.fresh = url.searchParams.get("value") === "1"
    empty(response)
    return true
  }
  if (url.pathname === "/__fixture/workspace" && request.method === "POST") {
    state.workspaceMode = url.searchParams.get("value") === "empty" ? "empty" : "full"
    empty(response)
    return true
  }
  if (url.pathname === "/__fixture/created-project" && request.method === "POST") {
    state.createdProjectVisible = url.searchParams.get("value") === "1"
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
      protocols: ["atape.cli-authorization.v1"],
      release_version: "0.2.0",
      auth_epoch: "auth-v1",
      minimum_cli_version: "0.2.0"
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
    const teams = state.workspaceMode === "full" ? [team] : []
    if (state.createdTeam !== null) teams.push(state.createdTeam)
    const projects = state.workspaceMode === "full" ? [{
      id: "project-1",
      teamId: team.id,
      type: "git",
      name: "ATape",
      state: "active",
      repositoryLinkState: "linked",
      repositoryIdentity: "github.com/SingleMai/ATape",
      capturedThrough: now,
      createdAt: now,
      updatedAt: now
    }] : []
    if (state.createdTeam !== null && state.createdProjectVisible) projects.push({
      id: "created-project",
      teamId: state.createdTeam.id,
      type: "git",
      name: "Captured Project",
      state: "active",
      repositoryLinkState: "linked",
      repositoryIdentity: "github.com/SingleMai/captured-project",
      capturedThrough: later,
      createdAt: now,
      updatedAt: now
    })
    return json(response, 200, {
      teams,
      projects
    })
  }
  if (path === "/api/v1/sessions/session-reader" && request.method === "GET") {
    if (!requireWeb(request, response)) return
    state.conversationRequests++
    if (state.failConversation) return problem(response, 503, "service_unavailable")
    return json(response, 200, {
      session: {
        id: "session-reader",
        projectId: "project-1",
        title: "Conversation hierarchy",
        actor: { name: "User", harness: "Codex" },
        branch: "main",
        status: "active",
        captureStatus: "healthy",
        updatedAt: "2026-09-05T00:00:09Z"
      },
      thread: { id: "root", label: "Root", captureStatus: "healthy" },
      threadPath: [{ id: "root", label: "Root" }],
      events: [
        { id: "event-01", kind: "message", author: "User", occurredAt: "2026-09-05T00:00:01Z", text: "Please diagnose the startup failure" },
        { id: "event-02", kind: "thought", author: "Codex", occurredAt: "2026-09-05T00:00:02Z", text: "Planning diagnosis" },
        { id: "event-03", kind: "message", author: "Codex", occurredAt: "2026-09-05T00:00:03Z", text: "I am checking the environment" },
        { id: "event-04", kind: "tool_call", author: "Codex", occurredAt: "2026-09-05T00:00:04Z", text: "exec · completed", toolLabel: "exec" },
        { id: "event-05", kind: "message", author: "Codex", occurredAt: "2026-09-05T00:00:05Z", text: "The startup issue is fixed" },
        { id: "event-06", kind: "message", author: "User", occurredAt: "2026-09-05T00:00:06Z", text: "Can you verify it?" },
        { id: "event-07", kind: "tool_result", author: "Codex", occurredAt: "2026-09-05T00:00:07Z", text: "test · completed", toolLabel: "test" },
        { id: "event-08", kind: "message", author: "Codex", occurredAt: "2026-09-05T00:00:08Z", text: "Verification passed" }
      ]
    })
  }
  if (path === "/api/v1/projects/project-1/search" && request.method === "GET") {
    if (!requireWeb(request, response)) return
    const query = url.searchParams.get("q") ?? ""
    return json(response, 200, { projectId: "project-1", query, results: query.toLowerCase().includes("startup") ? [{
      eventId: "event-01", sessionId: "session-reader", sessionTitle: "Conversation hierarchy",
      threadId: "root", threadPath: [{ id: "root", label: "Root" }], author: "User", harness: "Codex",
      occurredAt: "2026-09-05T00:00:01Z", text: "Please diagnose the startup failure"
    }] : [] })
  }
  if (path === "/api/v1/projects/project-1/memory" && request.method === "GET") {
    if (!requireWeb(request, response)) return
    state.projectMemoryRequests++
    const session = {
      id: "session-reader",
      title: "Conversation hierarchy",
      summary: "Diagnosed and verified the startup issue.",
      insight: "The environment now starts successfully.",
      actor: { name: "User", harness: "Codex" },
      branch: "main",
      status: "active",
      updatedAt: "2026-09-05T00:00:09Z",
      eventCount: 8,
      childThreadCount: 0
    }
    return json(response, 200, {
      project: { id: "project-1", teamId: "team-id", name: "ATape", type: "git" },
      capturedThrough: "2026-09-05T00:00:09Z",
      active: [session],
      trail: [session]
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
  if (path === "/api/v1/users/me/cli-credentials" && request.method === "GET") {
    if (!requireWeb(request, response)) return
    if (state.failCredentials) return problem(response, 503, "service_unavailable")
    return json(response, 200, { items: state.cliCredentials.map((id) => ({
      id,
      capability: "atape-cli.v1",
      createdAt: now,
      lastUsedAt: now
    })) })
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
    if (input.user_code !== "Q7KM4W") return problem(response, 400, "invalid_user_code")
    return json(response, 200, {
      grantViewId: "grant-view-one",
      userCode: "Q7KM4W",
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
    state.createdTeam = {
      ...team,
      id: "created-team",
      slug: state.teamCreateBody.slug,
      displayName: state.teamCreateBody.displayName
    }
    return json(response, 201, state.createdTeam)
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
