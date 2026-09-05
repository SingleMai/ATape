import { createServer } from "node:http"

/**
 * Starts the smallest real HTTP boundary needed by packaged CLI release
 * verification. It deliberately exercises discovery and authenticated setup;
 * callers never seed trusted User, Team, or Project fields into local config.
 */
export async function startCLIAuthFixture(options = {}) {
  const userId = options.userId ?? "fixture-user"
  const userName = options.userName ?? "Fixture User"
  const teamId = options.teamId ?? "fixture-team-id"
  const teamSlug = options.teamSlug ?? "fixture-team"
  const teamName = options.teamName ?? "Fixture Team"
  const projectId = options.projectId ?? "fixture-project"
  const projectName = options.projectName ?? "Fixture Project"
  const credential = options.credential ?? "atc_v1_fixture-secret"
  const credentialId = options.credentialId ?? "fixture-credential"
  const userCode = options.userCode ?? "Q7KM4W"
  const now = "2026-09-06T00:00:00Z"
  const requests = []
  let origin = ""

  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    let body
    if (chunks.length > 0) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {
        body = undefined
      }
    }
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      idempotencyKey: request.headers["idempotency-key"],
      body
    })
    response.setHeader("Content-Type", "application/json")
    const send = (status, value) => {
      response.statusCode = status
      response.end(value === undefined ? undefined : JSON.stringify(value))
    }

    switch (`${request.method} ${request.url}`) {
      case "GET /api/v1/instance":
        send(200, {
          protocol: "atape.instance.v1",
          instance_origin: origin,
          web_origin: origin,
          api_origin: origin,
          protocols: ["atape.cli-authorization.v1", "atape.canonical.v1", "atape.raw.v1"]
        })
        return
      case "POST /api/v1/auth/cli/device-grants":
        send(201, {
          protocol: "atape.cli-authorization.v1",
          device_code: "atd_v1_release-device",
          user_code: userCode,
          verification_uri: `${origin}/cli/authorize`,
          verification_uri_complete: `${origin}/cli/authorize?user_code=${userCode}`,
          expires_in: 60,
          interval: 1
        })
        return
      case "POST /api/v1/auth/cli/token":
        send(200, {
          token_type: "Bearer",
          credential,
          credential_id: credentialId,
          capability_version: "atape-cli.v1",
          created_at: now,
          user: { id: userId, display_name: userName }
        })
        return
      case "GET /api/v1/users/me":
        if (request.headers.authorization !== `Bearer ${credential}`) {
          send(401, { status: 401, code: "unauthenticated" })
          return
        }
        send(200, { id: userId, displayName: userName, avatarUrl: "" })
        return
      case "GET /api/v1/workspace":
        if (request.headers.authorization !== `Bearer ${credential}`) {
          send(401, { status: 401, code: "unauthenticated" })
          return
        }
        send(200, {
          teams: [{
            id: teamId,
            slug: teamSlug,
            displayName: teamName,
            membership: { role: "owner" },
            createdAt: now,
            updatedAt: now
          }],
          projects: []
        })
        return
      case `POST /api/v1/teams/${teamSlug}/projects`:
        if (request.headers.authorization !== `Bearer ${credential}`) {
          send(401, { status: 401, code: "unauthenticated" })
          return
        }
        send(201, {
          id: projectId,
          teamId,
          type: "folder",
          name: projectName,
          state: "active",
          createdAt: now,
          updatedAt: now
        })
        return
      case "DELETE /api/v1/auth/cli/credentials/current":
        send(204)
        return
      default:
        send(404, { status: 404, code: "not_found" })
    }
  })
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("CLI auth fixture did not bind")
  origin = `http://127.0.0.1:${address.port}`

  return {
    origin,
    requests,
    close: () => new Promise((resolveClose, reject) =>
      server.close((error) => error ? reject(error) : resolveClose()))
  }
}
