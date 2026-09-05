import {
  CLIAuthenticationGateway,
  CLICredentialStore,
  type CLIPollResult
} from "@atape/application"
import type { StoredCLICredential } from "@atape/domain"
import { createHash } from "node:crypto"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import {
  makeCredentialStoreLayer,
  makeHTTPAuthenticationGatewayLayer
} from "./authenticationLayers.ts"

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const credential: StoredCLICredential = {
  version: 1,
  instanceOrigin: "https://atape.dev",
  apiOrigin: "https://api.atape.dev",
  credential: "atc_v1_fixture-secret",
  credentialId: "credential-1",
  capabilityVersion: "atape-cli.v1",
  createdAt: "2026-09-06T00:00:00Z",
  user: { id: "user-1", displayName: "Mai" }
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(
  JSON.stringify(value),
  { status, headers: { "content-type": "application/json", ...headers } }
)

describe("Node CLI authentication HTTP Adapter", () => {
  it("translates the snake-case protocol and sends bearer authority only for revocation", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const responses = [
      json({
        protocol: "atape.instance.v1",
        instance_origin: "https://atape.dev",
        web_origin: "https://atape.dev",
        api_origin: "https://api.atape.dev",
        protocols: ["atape.cli-authorization.v1"]
      }),
      json({
        protocol: "atape.cli-authorization.v1",
        device_code: "atd_v1_device-secret",
        user_code: "Q7KM-4WDP",
        verification_uri: "https://atape.dev/cli/authorize",
        verification_uri_complete: "https://atape.dev/cli/authorize?user_code=Q7KM-4WDP",
        expires_in: 900,
        interval: 5
      }, 201),
      json({ status: "authorization_pending", retry_after: 5 }, 202),
      json({
        token_type: "Bearer",
        credential: "atc_v1_fixture-secret",
        credential_id: "credential-1",
        capability_version: "atape-cli.v1",
        created_at: "2026-09-06T00:00:00Z",
        user: { id: "user-1", display_name: "Mai" }
      }),
      new Response(null, { status: 204 })
    ]
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), ...(init === undefined ? {} : { init }) })
      const response = responses.shift()
      if (response === undefined) throw new Error("Unexpected request")
      return response
    }) as typeof fetch
    const layer = makeHTTPAuthenticationGatewayLayer(fetchImplementation)
    const result = await Effect.gen(function*() {
      const gateway = yield* CLIAuthenticationGateway
      const metadata = yield* gateway.discover("https://atape.dev")
      const grant = yield* gateway.createDeviceAuthorization(metadata)
      const pending = yield* gateway.pollDeviceAuthorization(metadata, grant.deviceCode)
      const authorized = yield* gateway.pollDeviceAuthorization(metadata, grant.deviceCode)
      yield* gateway.revokeCredential(credential)
      return { metadata, grant, pending, authorized }
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(result.metadata).toMatchObject({
      instanceOrigin: "https://atape.dev", apiOrigin: "https://api.atape.dev"
    })
    expect(result.grant).toMatchObject({ deviceCode: "atd_v1_device-secret", expiresInSeconds: 900 })
    expect(result.pending).toEqual({ _tag: "Pending", retryAfterSeconds: 5 })
    expect((result.authorized as Extract<CLIPollResult, { _tag: "Authorized" }>).credential.user)
      .toEqual({ id: "user-1", displayName: "Mai" })
    expect(requests.every((request) => request.init?.redirect === "error")).toBe(true)
    expect(requests.slice(0, 4).every((request) =>
      new Headers(request.init?.headers).get("authorization") === null)).toBe(true)
    expect(new Headers(requests[4]?.init?.headers).get("authorization"))
      .toBe("Bearer atc_v1_fixture-secret")
  })

  it("maps slow-down without reflecting a malicious response body or Device Code", async () => {
    const fetchImplementation = (async () => json({
      status: 429,
      code: "slow_down",
      detail: "echo atd_v1_do-not-reflect"
    }, 429, { "retry-after": "11" })) as typeof fetch
    const layer = makeHTTPAuthenticationGatewayLayer(fetchImplementation)
    const metadata = {
      protocol: "atape.instance.v1" as const,
      instanceOrigin: "https://atape.dev",
      webOrigin: "https://atape.dev",
      apiOrigin: "https://api.atape.dev",
      protocols: ["atape.cli-authorization.v1"]
    }
    const failure = await Effect.gen(function*() {
      return yield* (yield* CLIAuthenticationGateway)
        .pollDeviceAuthorization(metadata, "atd_v1_do-not-reflect")
    }).pipe(Effect.provide(layer), Effect.flip, Effect.runPromise)

    expect(failure).toMatchObject({ reason: "slow_down", retryAfterSeconds: 11 })
    expect(JSON.stringify(failure)).not.toContain("atd_v1_do-not-reflect")
  })

  it("rejects an oversized response before decoding it", async () => {
    const fetchImplementation = (async () => new Response("x", {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "999999" }
    })) as typeof fetch
    const layer = makeHTTPAuthenticationGatewayLayer(fetchImplementation)
    const failure = await Effect.gen(function*() {
      return yield* (yield* CLIAuthenticationGateway).discover("https://atape.dev")
    }).pipe(Effect.provide(layer), Effect.flip, Effect.runPromise)
    expect(failure).toMatchObject({ reason: "decode" })
  })
})

const credentialFixture = async () => {
  const parent = await mkdtemp(join(tmpdir(), "atape-credential-test-"))
  temporaryDirectories.push(parent)
  const home = join(parent, ".atape")
  const directory = join(home, "credentials")
  const layer = makeCredentialStoreLayer(home, directory)
  const run = <A, E>(effect: Effect.Effect<A, E, CLICredentialStore>) =>
    effect.pipe(Effect.provide(layer), Effect.runPromise)
  return { parent, home, directory, layer, run }
}

describe("Node CLI Credential store Adapter", () => {
  it("uses an opaque per-Instance filename and durable owner-only storage", async () => {
    const fixture = await credentialFixture()
    await fixture.run(Effect.gen(function*() {
      const store = yield* CLICredentialStore
      yield* store.replace({ credential })
    }))

    const expectedName = `${createHash("sha256").update("https://atape.dev").digest("hex")}.json`
    expect(await readdir(fixture.directory)).toEqual([expectedName])
    expect((await lstat(fixture.home)).mode & 0o777).toBe(0o700)
    expect((await lstat(fixture.directory)).mode & 0o777).toBe(0o700)
    expect((await lstat(join(fixture.directory, expectedName))).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(join(fixture.directory, expectedName), "utf8")))
      .toMatchObject({ credentialId: "credential-1" })
    const restored = await fixture.run(Effect.gen(function*() {
      return yield* (yield* CLICredentialStore).read("https://atape.dev")
    }))
    expect(restored).toEqual(credential)
  })

  it("rejects symlink, non-regular, and broadly readable credential targets", async () => {
    const fixture = await credentialFixture()
    await fixture.run(Effect.gen(function*() {
      yield* (yield* CLICredentialStore).read("https://atape.dev")
    }))
    const filename = `${createHash("sha256").update("https://atape.dev").digest("hex")}.json`
    const target = join(fixture.directory, filename)
    const outside = join(fixture.parent, "outside.json")
    await writeFile(outside, JSON.stringify(credential), { mode: 0o600 })
    await symlink(outside, target)
    await expect(fixture.run(Effect.gen(function*() {
      return yield* (yield* CLICredentialStore).read("https://atape.dev")
    }))).rejects.toMatchObject({ reason: "unsafe" })

    await rm(target)
    await mkdir(target)
    await expect(fixture.run(Effect.gen(function*() {
      return yield* (yield* CLICredentialStore).read("https://atape.dev")
    }))).rejects.toMatchObject({ reason: "unsafe" })

    await rm(target, { recursive: true })
    await writeFile(target, JSON.stringify(credential), { mode: 0o600 })
    await chmod(target, 0o644)
    await expect(fixture.run(Effect.gen(function*() {
      return yield* (yield* CLICredentialStore).read("https://atape.dev")
    }))).rejects.toMatchObject({ reason: "unsafe" })
  })

  it("fails closed when the credential directory itself is a symlink", async () => {
    const fixture = await credentialFixture()
    await mkdir(fixture.home, { mode: 0o700 })
    const outside = join(fixture.parent, "outside")
    await mkdir(outside, { mode: 0o700 })
    await symlink(outside, fixture.directory)

    await expect(fixture.run(Effect.gen(function*() {
      return yield* (yield* CLICredentialStore).read("https://atape.dev")
    }))).rejects.toMatchObject({ reason: "unsafe" })
  })

  it("enforces compare-and-swap replacement and removal", async () => {
    const fixture = await credentialFixture()
    await fixture.run(Effect.gen(function*() {
      yield* (yield* CLICredentialStore).replace({ credential })
    }))
    const second = { ...credential, credentialId: "credential-2", credential: "atc_v1_second-secret" }
    await expect(fixture.run(Effect.gen(function*() {
      yield* (yield* CLICredentialStore).replace({ credential: second })
    }))).rejects.toMatchObject({ reason: "conflict" })

    const removed = await fixture.run(Effect.gen(function*() {
      return yield* (yield* CLICredentialStore).remove({
        instanceOrigin: "https://atape.dev", expectedCredentialId: "credential-1"
      })
    }))
    expect(removed).toBe(true)
    expect(await readdir(fixture.directory)).toEqual([])
  })
})
