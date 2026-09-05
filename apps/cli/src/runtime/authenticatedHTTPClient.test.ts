import {
  CLIAuthenticationError,
  CLIAuthenticationGateway,
  CLICredentialStore
} from "@atape/application"
import type { InstanceMetadata, StoredCLICredential } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  AuthenticatedHTTPClient,
  makeAuthenticatedHTTPClientLayer
} from "./authenticatedHTTPClient.ts"

const credential: StoredCLICredential = {
  version: 1,
  instanceOrigin: "https://atape.dev",
  apiOrigin: "https://api.atape.dev",
  credential: "atc_v1_private-fixture",
  credentialId: "credential-1",
  capabilityVersion: "atape-cli.v1",
  createdAt: "2026-09-06T00:00:00Z",
  user: { id: "user-1", displayName: "Mai" }
}
const metadata: InstanceMetadata = {
  protocol: "atape.instance.v1",
  instanceOrigin: "https://atape.dev",
  webOrigin: "https://atape.dev",
  apiOrigin: "https://api.atape.dev",
  protocols: ["atape.cli-authorization.v1", "atape.canonical.v1"]
}

const fixture = (options: {
  readonly stored?: StoredCLICredential
  readonly metadata?: InstanceMetadata
} = {}) => {
  let discoveries = 0
  const fetches: Array<{ readonly url: string; readonly init?: RequestInit }> = []
  const dependencies = Layer.mergeAll(
    Layer.succeed(CLICredentialStore, CLICredentialStore.of({
      read: () => Effect.succeed(options.stored === undefined ? credential : options.stored),
      replace: () => Effect.void,
      remove: () => Effect.succeed(true)
    })),
    Layer.succeed(CLIAuthenticationGateway, CLIAuthenticationGateway.of({
      discover: () => Effect.sync(() => {
        discoveries++
        return options.metadata ?? metadata
      }),
      createDeviceAuthorization: () => Effect.fail(new CLIAuthenticationError({
        reason: "unavailable", message: "unused"
      })),
      pollDeviceAuthorization: () => Effect.fail(new CLIAuthenticationError({
        reason: "unavailable", message: "unused"
      })),
      revokeCredential: () => Effect.void
    }))
  )
  const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
    fetches.push({ url: String(input), ...(init === undefined ? {} : { init }) })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  }) as typeof fetch
  const layer = makeAuthenticatedHTTPClientLayer(fetchImplementation).pipe(Layer.provide(dependencies))
  return {
    discoveries: () => discoveries,
    fetches,
    run: <A, E>(effect: Effect.Effect<A, E, AuthenticatedHTTPClient>) =>
      effect.pipe(Effect.provide(layer), Effect.runPromise)
  }
}

describe("authenticated CLI HTTP boundary", () => {
  it("verifies pinned discovery once, checks User scope, and rejects redirects", async () => {
    const client = fixture()
    await client.run(Effect.gen(function*() {
      const http = yield* AuthenticatedHTTPClient
      yield* http.request({
        instanceOrigin: "https://atape.dev",
        expectedUserId: "user-1",
        path: "/api/v1/workspace",
        method: "GET"
      })
      yield* http.request({
        instanceOrigin: "https://atape.dev",
        expectedUserId: "user-1",
        path: "/api/v1/workspace",
        method: "GET"
      })
    }))

    expect(client.discoveries()).toBe(1)
    expect(client.fetches).toHaveLength(2)
    expect(client.fetches[0]?.url).toBe("https://api.atape.dev/api/v1/workspace")
    expect(new Headers(client.fetches[0]?.init?.headers).get("authorization"))
      .toBe("Bearer atc_v1_private-fixture")
    expect(client.fetches[0]?.init?.redirect).toBe("error")
  })

  it("fails before a credentialed request when discovery drifts", async () => {
    const client = fixture({ metadata: { ...metadata, apiOrigin: "https://new-api.atape.dev" } })
    await expect(client.run(AuthenticatedHTTPClient.use((http) => http.request({
      instanceOrigin: "https://atape.dev", path: "/api/v1/workspace", method: "GET"
    })))).rejects.toMatchObject({ reason: "metadata_drift" })
    expect(client.fetches).toEqual([])
  })

  it("fails before HTTP when the local Project belongs to another User", async () => {
    const client = fixture()
    await expect(client.run(AuthenticatedHTTPClient.use((http) => http.request({
      instanceOrigin: "https://atape.dev",
      expectedUserId: "user-2",
      path: "/api/v1/workspace",
      method: "GET"
    })))).rejects.toMatchObject({ reason: "identity_changed" })
    expect(client.discoveries()).toBe(0)
    expect(client.fetches).toEqual([])
  })
})
