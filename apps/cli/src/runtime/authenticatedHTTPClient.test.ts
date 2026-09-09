import {
  CLIAuthenticationError,
  CLIAuthenticationGateway,
  CLICredentialStore
} from "@atape/application"
import type { InstanceMetadata, StoredCLICredential } from "@atape/domain"
import { Effect, Layer, Logger } from "effect"
import { describe, expect, it } from "vitest"
import {
  AuthenticatedHTTPClient,
  makeAuthenticatedHTTPClientLayer
} from "./authenticatedHTTPClient.ts"

const credential: StoredCLICredential = {
  version: 1,
  instanceOrigin: "https://atape.net",
  apiOrigin: "https://api.atape.net",
  credential: "atc_v1_private-fixture",
  credentialId: "credential-1",
  capabilityVersion: "atape-cli.v1",
  createdAt: "2026-09-06T00:00:00Z",
  user: { id: "user-1", displayName: "Mai" }
}
const metadata: InstanceMetadata = {
  protocol: "atape.instance.v1",
  instanceOrigin: "https://atape.net",
  webOrigin: "https://atape.net",
  apiOrigin: "https://api.atape.net",
  protocols: ["atape.cli-authorization.v1", "atape.canonical.v1"],
  releaseVersion: "0.2.0",
  authEpoch: "auth-v1",
  minimumCliVersion: "0.2.0"
}

const fixture = (options: {
  readonly stored?: StoredCLICredential
  readonly metadata?: InstanceMetadata
  readonly device?: import("@atape/domain").CLIDeviceMetadata
  readonly fetch?: typeof fetch
} = {}) => {
  let discoveries = 0
  const logs: unknown[] = []
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
  const layer = makeAuthenticatedHTTPClientLayer(options.fetch ?? fetchImplementation, false, options.device === undefined ? undefined : Effect.succeed(options.device)).pipe(Layer.provide(dependencies))
  return {
    discoveries: () => discoveries,
    fetches,
    logs,
    run: <A, E>(effect: Effect.Effect<A, E, AuthenticatedHTTPClient>) =>
      effect.pipe(Effect.provide(layer), Effect.provide(Logger.layer([Logger.make(options => { logs.push(options.message) })])), Effect.runPromise)
  }
}

describe("authenticated CLI HTTP boundary", () => {
  it.each([
    [new DOMException("private message", "TimeoutError"), "timeout", "TimeoutError"],
    [new TypeError("private URL", { cause: Object.assign(new Error("private address"), { code: "ENOTFOUND" }) }), "dns", "ENOTFOUND"],
    [new TypeError("private payload", { cause: new AggregateError([Object.assign(new Error("private IP"), { code: "ECONNRESET" })]) }), "connection", "ECONNRESET"],
    [Object.assign(new Error("private certificate"), { code: "CERT_HAS_EXPIRED" }), "tls", "CERT_HAS_EXPIRED"],
    [Object.assign(new Error("private exception"), { code: "private-code" }), "unknown", undefined]
  ] as const)("retains bounded network diagnostics without leaking exception data (%#)", async (cause, kind, code) => {
    const client = fixture({ fetch: (async () => { throw cause }) as typeof fetch })
    await expect(client.run(AuthenticatedHTTPClient.use(http => http.request({
      instanceOrigin: credential.instanceOrigin, path: "/api/v1/project-matches", method: "POST", body: { secret: "private-body" }
    })))).rejects.toMatchObject({ reason: "network", networkKind: kind,
      ...(code ? { networkCode: code } : {}), message: expect.stringContaining("project_match") })
    const logs = JSON.stringify(client.logs)
    expect(logs).toContain('"networkKind":"' + kind + '"')
    expect(logs).toContain('"elapsedMs":')
    expect(logs).not.toMatch(/private|Bearer|https:|secret/)
  })

  it("reports Unicode device names and Adapter state without local paths or credentials", async () => {
    const device = { name: "Mai 的 Mac", platform: "darwin arm64", version: "0.4.5", adapters: [{ id: "codex", version: "0.4.5", enabled: false }] }
    const client = fixture({ device })
    await client.run(AuthenticatedHTTPClient.use((http) => http.request({ instanceOrigin: credential.instanceOrigin, path: "/api/v1/workspace", method: "GET" })))
    const header = new Headers(client.fetches[0]?.init?.headers).get("X-Atape-Device")!
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual(device)
    expect(header.length).toBeLessThanOrEqual(8192)
  })

  it("verifies pinned discovery once, checks User scope, and rejects redirects", async () => {
    const client = fixture()
    await client.run(Effect.gen(function*() {
      const http = yield* AuthenticatedHTTPClient
      yield* http.request({
        instanceOrigin: "https://atape.net",
        expectedUserId: "user-1",
        path: "/api/v1/workspace",
        method: "GET"
      })
      yield* http.request({
        instanceOrigin: "https://atape.net",
        expectedUserId: "user-1",
        path: "/api/v1/workspace",
        method: "GET"
      })
    }))

    expect(client.discoveries()).toBe(1)
    expect(client.fetches).toHaveLength(2)
    expect(client.fetches[0]?.url).toBe("https://api.atape.net/api/v1/workspace")
    expect(new Headers(client.fetches[0]?.init?.headers).get("authorization"))
      .toBe("Bearer atc_v1_private-fixture")
    expect(client.fetches[0]?.init?.redirect).toBe("error")
  })

  it("fails before a credentialed request when discovery drifts", async () => {
    const client = fixture({ metadata: { ...metadata, apiOrigin: "https://new-api.atape.net" } })
    await expect(client.run(AuthenticatedHTTPClient.use((http) => http.request({
      instanceOrigin: "https://atape.net", path: "/api/v1/workspace", method: "GET"
    })))).rejects.toMatchObject({ reason: "metadata_drift" })
    expect(client.fetches).toEqual([])
  })

  it("fails before HTTP when the local Project belongs to another User", async () => {
    const client = fixture()
    await expect(client.run(AuthenticatedHTTPClient.use((http) => http.request({
      instanceOrigin: "https://atape.net",
      expectedUserId: "user-2",
      path: "/api/v1/workspace",
      method: "GET"
    })))).rejects.toMatchObject({ reason: "identity_changed" })
    expect(client.discoveries()).toBe(0)
    expect(client.fetches).toEqual([])
  })
})
