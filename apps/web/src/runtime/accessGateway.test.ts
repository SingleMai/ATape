import {
  AuthenticationGateway,
  TeamAccessGateway,
  createTeam,
  restoreWebSession
} from "@atape/application"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BrowserAccessLayer } from "./accessGateway.ts"
import { clearBrowserAuthentication, setBrowserCSRFToken } from "./http.ts"

const team = {
  id: "team-id",
  slug: "team-a",
  displayName: "Team A",
  membership: { role: "owner" },
  createdAt: "2026-09-05T00:00:00Z",
  updatedAt: "2026-09-05T00:00:00Z"
}

const bootstrap = {
  user: { id: "user-1", displayName: "Mai", avatarUrl: "" },
  webSession: {
    id: "session-1",
    createdAt: "2026-09-05T00:00:00Z",
    lastUsedAt: "2026-09-05T00:00:00Z",
    reauthenticatedAt: "2026-09-05T00:00:00Z",
    absoluteExpiresAt: "2027-03-04T00:00:00Z",
    current: true
  },
  csrfToken: "csrf-from-bootstrap"
}

const run = <A, E>(effect: Effect.Effect<A, E, AuthenticationGateway | TeamAccessGateway>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BrowserAccessLayer)))

describe("browser access Gateway Adapter", () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    clearBrowserAuthentication()
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("translates the public snake-case Instance document at the Adapter boundary", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      protocol: "atape.instance.v1",
      instance_origin: "https://atape.dev",
      web_origin: "https://atape.dev",
      api_origin: "https://api.atape.dev",
      protocols: ["atape.cli-authorization.v1"],
      release_version: "0.2.0",
      auth_epoch: "auth-v1",
      minimum_cli_version: "0.2.0"
    }), { status: 200 }))

    const metadata = await run(Effect.flatMap(AuthenticationGateway, (gateway) => gateway.loadInstance()))

    expect(metadata).toEqual({
      protocol: "atape.instance.v1",
      instanceOrigin: "https://atape.dev",
      webOrigin: "https://atape.dev",
      apiOrigin: "https://api.atape.dev",
      protocols: ["atape.cli-authorization.v1"],
      releaseVersion: "0.2.0",
      authEpoch: "auth-v1",
      minimumCliVersion: "0.2.0"
    })
  })

  it("captures the private CSRF proof only through session restoration", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(bootstrap), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(team), { status: 201 }))

    await expect(run(restoreWebSession())).resolves.toEqual({
      user: bootstrap.user,
      webSession: bootstrap.webSession
    })
    await run(createTeam({ slug: "team-a", displayName: "Team A" }))

    const mutationHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers)
    expect(mutationHeaders.get("X-ATape-CSRF")).toBe("csrf-from-bootstrap")
    expect(mutationHeaders.get("Idempotency-Key")).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it("replays an ambiguous Team creation with the same operation key", async () => {
    setBrowserCSRFToken("csrf-secret")
    fetchMock
      .mockRejectedValueOnce(new TypeError("connection reset after commit"))
      .mockResolvedValueOnce(new Response(JSON.stringify(team), { status: 201 }))

    await expect(run(createTeam({ slug: "team-a", displayName: "Team A" })))
      .resolves.toMatchObject({ id: "team-id" })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const first = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")
    const second = new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(second).toBe(first)
  })

  it("fails closed when session JSON does not match the protocol", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ user: bootstrap.user }), { status: 200 }))

    await expect(run(restoreWebSession())).rejects.toMatchObject({
      reason: "decode",
      code: "invalid_response"
    })
  })
})
