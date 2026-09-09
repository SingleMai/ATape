import {
  ProjectSetupGateway
} from "@atape/application"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
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
  repositoryLinkState: "linked",
  repositoryIdentity: "github.com/acme/payments",
  createdAt: now,
  updatedAt: now
}

describe("Node Project setup HTTP Adapter", () => {
  it("backs off Git matching after a network failure and honors Retry-After before accepting authority", async () => {
    let attempts = 0
    const client = Layer.succeed(AuthenticatedHTTPClient, AuthenticatedHTTPClient.of({
      request: () => Effect.suspend(() => {
        attempts++
        return attempts === 1 ? Effect.fail(new AuthenticatedHTTPError({ reason: "network", message: "Offline" }))
          : Effect.succeed(attempts === 2 ? { status: 429, retryAfterSeconds: 5 }
            : { status: 200, body: { status: "exact", project } })
      })
    }))
    await Effect.gen(function*() {
      const gateway = yield* ProjectSetupGateway
      const fiber = yield* Effect.forkChild(gateway.matchGitProject("https://atape.net", "team-1", "git@github.com:acme/payments.git"))
      yield* TestClock.adjust("400 millis")
      expect(attempts).toBe(1)
      yield* TestClock.adjust("600 millis")
      expect(attempts).toBe(2)
      yield* TestClock.adjust("4 seconds")
      expect(attempts).toBe(2)
      yield* TestClock.adjust("1 second")
      expect((yield* Fiber.join(fiber)).status).toBe("exact")
      expect(attempts).toBe(3)
    }).pipe(Effect.provide(makeProjectSetupGatewayLayer().pipe(Layer.provide(client))), Effect.provide(TestClock.layer()), Effect.runPromise)
  })

  it.each([401, 403, 400, 429, 503, 200])("bounds matching retries without turning HTTP %s into an unknown source", async status => {
    let attempts = 0
    const client = Layer.succeed(AuthenticatedHTTPClient, AuthenticatedHTTPClient.of({
      request: () => Effect.sync(() => { attempts++; return { status, body: { invalid: true } } })
    }))
    await Effect.gen(function*() {
      const gateway = yield* ProjectSetupGateway
      const fiber = yield* Effect.forkChild(gateway.matchGitProject("https://atape.net", "team-1", "remote").pipe(Effect.flip))
      yield* TestClock.adjust("10 seconds")
      const error = yield* Fiber.join(fiber)
      expect(error.reason).toBe(status === 401 ? "unauthenticated" : status === 403 ? "forbidden"
        : status === 400 ? "invalid_remote" : status === 200 ? "decode" : "unavailable")
      expect(attempts).toBe(status === 429 || status >= 500 ? 3 : 1)
    }).pipe(Effect.provide(makeProjectSetupGatewayLayer().pipe(Layer.provide(client))), Effect.provide(TestClock.layer()), Effect.runPromise)
  })

  it.each([false, true])("keeps an unavailable match retryable and respects cancellation (%s)", async cancel => {
    let attempts = 0
    const client = Layer.succeed(AuthenticatedHTTPClient, AuthenticatedHTTPClient.of({
      request: () => Effect.suspend(() => {
        attempts++
        return Effect.fail(new AuthenticatedHTTPError({ reason: "network", message: "Offline" }))
      })
    }))
    await Effect.gen(function*() {
      const gateway = yield* ProjectSetupGateway
      const fiber = yield* Effect.forkChild(gateway.matchGitProject("https://atape.net", "team-1", "remote").pipe(Effect.flip))
      yield* TestClock.adjust("400 millis")
      expect(attempts).toBe(1)
      if (cancel) yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust("1 minute")
      if (!cancel) expect((yield* Fiber.join(fiber)).reason).toBe("transport")
      expect(attempts).toBe(cancel ? 1 : 3)
    }).pipe(Effect.provide(makeProjectSetupGatewayLayer().pipe(Layer.provide(client))), Effect.provide(TestClock.layer()), Effect.runPromise)
  })

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
      const workspace = yield* gateway.loadWorkspace("https://atape.net")
      const match = yield* gateway.matchGitProject(
        "https://atape.net", "team-1", "git@github.com:acme/payments.git"
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
      "https://atape.net",
      "acme",
      { type: "git", remote: "git@github.com:acme/payments.git" }
    )).pipe(Effect.provide(layer), Effect.runPromise)

    expect(created.id).toBe("project-1")
    expect(requests).toHaveLength(2)
    expect(requests[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(requests[1]?.idempotencyKey).toBe(requests[0]?.idempotencyKey)
  })
})
