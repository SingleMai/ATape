import { execFile } from "node:child_process"
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

const exec = promisify(execFile)
const temporaryDirectories: Array<string> = []
const servers: Array<Server> = []
const cli = fileURLToPath(new URL("./main.ts", import.meta.url))

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const authenticationServer = async () => {
  let origin = ""
  const requests: Array<{ readonly method?: string; readonly url?: string; readonly authorization?: string }> = []
  const now = "2026-09-06T00:00:00Z"
  const server = createServer(async (request, response) => {
    requests.push({
      ...(request.method === undefined ? {} : { method: request.method }),
      ...(request.url === undefined ? {} : { url: request.url }),
      ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization })
    })
    const chunks: Array<Buffer> = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    response.setHeader("Content-Type", "application/json")
    switch (`${request.method} ${request.url}`) {
      case "GET /api/v1/instance":
        response.end(JSON.stringify({
          protocol: "atape.instance.v1",
          instance_origin: origin,
          web_origin: origin,
          api_origin: origin,
          protocols: ["atape.cli-authorization.v1", "atape.canonical.v1", "atape.raw.v1"],
          release_version: "0.2.0",
          auth_epoch: "auth-v1",
          minimum_cli_version: "0.2.0"
        }))
        return
      case "POST /api/v1/auth/cli/device-grants":
        response.statusCode = 201
        response.end(JSON.stringify({
          protocol: "atape.cli-authorization.v1",
          device_code: "atd_v1_command-fixture",
          user_code: "Q7KM4W",
          verification_uri: `${origin}/cli/authorize`,
          verification_uri_complete: `${origin}/cli/authorize?user_code=Q7KM4W`,
          expires_in: 60,
          interval: 1
        }))
        return
      case "POST /api/v1/auth/cli/token":
        response.end(JSON.stringify({
          token_type: "Bearer",
          credential: "atc_v1_command-fixture",
          credential_id: "credential-1",
          capability_version: "atape-cli.v1",
          created_at: now,
          user: { id: "user-1", display_name: "Mai" }
        }))
        return
      case "GET /api/v1/users/me":
        response.end(JSON.stringify({ id: "user-1", displayName: "Mai", avatarUrl: "" }))
        return
      case "GET /api/v1/workspace":
        response.end(JSON.stringify({
          teams: [{
            id: "team-1",
            slug: "acme",
            displayName: "Acme Engineering",
            membership: { role: "owner" },
            createdAt: now,
            updatedAt: now
          }],
          projects: []
        }))
        return
      case "POST /api/v1/teams/acme/projects":
        response.statusCode = 201
        response.end(JSON.stringify({
          id: "project-1",
          teamId: "team-1",
          type: "folder",
          name: "support-notes",
          state: "active",
          repositoryLinkState: "not_applicable",
          createdAt: now,
          updatedAt: now
        }))
        return
      case "DELETE /api/v1/auth/cli/credentials/current":
        response.statusCode = 204
        response.end()
        return
      default:
        response.statusCode = 404
        response.end(JSON.stringify({ status: 404, code: "not_found" }))
    }
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("fixture server did not bind")
  origin = `http://127.0.0.1:${address.port}`
  return { origin, requests }
}

describe("atape CLI", () => {
  it("reports a development version when run from TypeScript source", async () => {
    const result = await exec(process.execPath, [cli, "--version"])
    expect(result.stdout.trim()).toBe("ATape development")
  })

  it("completes non-interactive Project setup and listing", async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-cli-command-"))
    temporaryDirectories.push(root)
    const project = join(root, "support-notes")
    await mkdir(project)
    const canonicalProject = await realpath(project)
    const remote = await authenticationServer()
    const environment = {
      ...process.env,
      ATAPE_HOME: join(root, ".atape"),
      ATAPE_INSTANCE_URL: remote.origin,
      ATAPE_DEVELOPMENT_ALLOW_HTTP: "true"
    }

    const login = await exec(process.execPath, [
      cli, "login", "--no-browser", "--json"
    ], { env: environment })
    const setup = await exec(process.execPath, [
      cli, "setup", project, "--team", "acme", "--create", "--type", "directory", "--json"
    ], { env: environment })
    const listed = await exec(process.execPath, [cli, "projects", "list", "--json"], { env: environment })
    const collected = await exec(process.execPath, [cli, "collect", "--once", "--json"], { env: environment })

    expect(JSON.parse(login.stdout)).toMatchObject({
      instanceOrigin: remote.origin,
      credentialId: "credential-1",
      user: { id: "user-1", displayName: "Mai" }
    })
    expect(login.stdout).not.toContain("atc_v1_")
    expect(login.stderr).toContain("Q7KM4W")
    expect(JSON.parse(setup.stdout)).toMatchObject({
      createdLocally: true,
      createdRemotely: true,
      project: { id: "project-1", type: "directory", path: canonicalProject }
    })
    expect(JSON.parse(listed.stdout)).toMatchObject({
      activeInstanceOrigin: remote.origin,
      projects: [{ id: "project-1", teamId: "team-1", userId: "user-1" }]
    })
    expect(JSON.parse(collected.stdout)).toMatchObject({ jobs: [], failures: [] })
    expect(remote.requests.find((request) => request.url === "/api/v1/teams/acme/projects"))
      .toMatchObject({ authorization: "Bearer atc_v1_command-fixture" })
  })
})
