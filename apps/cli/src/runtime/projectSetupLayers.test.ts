import {
  ProjectSetupGateway
} from "@atape/application"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  AuthenticatedHTTPClient,
  AuthenticatedHTTPError,
  type AuthenticatedHTTPRequest
} from "./authenticatedHTTPClient.ts"
import { makeProjectSetupGatewayLayer } from "./projectSetupLayers.ts"

const now = "2026-09-06T00:00:00Z"
const team = {
  id: "team-1",
  slug: "acme",
  displayName: "Acme",
  membership: { role: "owner" },
  createdAt: now,
  updatedAt: now
}
const project = {
  id: "project-1",
  teamId: "team-1",
  type: "git",
  name: "Payments",
  state: "active",
  repositoryIdentity: "github.com/acme/payments",
  createdAt: now,
  updatedAt: now
}

describe("Node Project setup HTTP Adapter", () => {
  it("translates Workspace and exact-match protocol responses", async () => {
    const requests: Array<AuthenticatedHTTPRequest> = []
    const responses = [
      { status: 200, body: { id: "user-1", displayName: "Mai", avatarUrl: "" } },
      { status: 200, body: { teams: [team], projects: [project] } },
      { status: 200, body: { status: "exact", project } }
    ]
    const client = Layer.succeed(AuthenticatedHTTPClient, AuthenticatedHTTPClient.of({
      request: (input) => Effect.sync(() => {
        requests.push(input)
        const response = responses.shift()
        if (response === undefined) throw new Error("Unexpected request")
        return response
      })
    }))
    const layer = makeProjectSetupGatewayLayer().pipe(Layer.provide(client))
    const result = await Effect.gen(function*() {
      const gateway = yield* ProjectSetupGateway
      const workspace = yield* gateway.loadWorkspace("https://atape.dev")
      const match = yield* gateway.matchGitProject(
        "https://atape.dev", "team-1", "git@github.com:acme/payments.git"
      )
      return { workspace, match }
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(result.workspace).toMatchObject({
      user: { id: "user-1" }, teams: [{ id: "team-1", role: "owner" }]
    })
    expect(result.match).toMatchObject({ status: "exact", project: { id: "project-1" } })
    expect(requests[2]?.body).toEqual({
      teamId: "team-1", type: "git", remote: "git@github.com:acme/payments.git"
    })
  })

  it("reuses one idempotency key when a response is lost", async () => {
    const requests: Array<AuthenticatedHTTPRequest> = []
    let attempt = 0
    const client = Layer.succeed(AuthenticatedHTTPClient, AuthenticatedHTTPClient.of({
      request: (input) => Effect.suspend(() => {
        requests.push(input)
        attempt++
        return attempt === 1
          ? Effect.fail(new AuthenticatedHTTPError({ reason: "network", message: "response lost" }))
          : Effect.succeed({ status: 201, body: project })
      })
    }))
    const layer = makeProjectSetupGatewayLayer().pipe(Layer.provide(client))
    const created = await ProjectSetupGateway.use((gateway) => gateway.createProject(
      "https://atape.dev",
      "acme",
      { type: "git", remote: "git@github.com:acme/payments.git" }
    )).pipe(Effect.provide(layer), Effect.runPromise)

    expect(created.id).toBe("project-1")
    expect(requests).toHaveLength(2)
    expect(requests[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(requests[1]?.idempotencyKey).toBe(requests[0]?.idempotencyKey)
  })
})
