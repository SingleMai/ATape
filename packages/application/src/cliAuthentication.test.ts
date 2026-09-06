import type {
  CLIDeviceAuthorization,
  InstanceMetadata,
  IssuedCLICredential,
  StoredCLICredential
} from "@atape/domain"
import { Effect, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import {
  CLIAuthenticationError,
  CLIAuthenticationGateway,
  CLIAuthenticationInteraction,
  CLICredentialStore,
  CLICredentialStoreError,
  loginCLI,
  logoutCLI,
  nextTransportRetryDelay,
  selectInstanceOrigin,
  type CLIPollResult
} from "./cliAuthentication.ts"

const metadata: InstanceMetadata = {
  protocol: "atape.instance.v1",
  instanceOrigin: "https://atape.dev",
  webOrigin: "https://atape.dev",
  apiOrigin: "https://api.atape.dev",
  protocols: ["atape.cli-authorization.v1"],
  releaseVersion: "0.2.0",
  authEpoch: "auth-v1",
  minimumCliVersion: "0.2.0"
}
const authorization: CLIDeviceAuthorization = {
  protocol: "atape.cli-authorization.v1",
  deviceCode: "atd_v1_device-secret",
  userCode: "Q7KM4W",
  verificationUri: "https://atape.dev/cli/authorize",
  verificationUriComplete: "https://atape.dev/cli/authorize?user_code=Q7KM4W",
  expiresInSeconds: 60,
  intervalSeconds: 1
}
const issued: IssuedCLICredential = {
  tokenType: "Bearer",
  credential: "atc_v1_new-secret",
  credentialId: "credential-new",
  capabilityVersion: "atape-cli.v1",
  createdAt: "2026-09-06T00:00:00Z",
  user: { id: "user-1", displayName: "Mai" }
}

const oldCredential: StoredCLICredential = {
  version: 1,
  instanceOrigin: "https://atape.dev",
  apiOrigin: "https://api.atape.dev",
  credential: "atc_v1_old-secret",
  credentialId: "credential-old",
  capabilityVersion: "atape-cli.v1",
  createdAt: "2026-09-05T00:00:00Z",
  user: { id: "user-1", displayName: "Mai" }
}

const fixture = async (options: {
  readonly previous?: StoredCLICredential
  readonly authorization?: CLIDeviceAuthorization
  readonly polls?: ReadonlyArray<
    "pending" | "slow_down" | "transport" | "denied" | "expired" | "authorized"
  >
  readonly browserOpened?: boolean
  readonly readFailure?: boolean
  readonly saveFailure?: boolean
  readonly revokeFailureIds?: ReadonlyArray<string>
} = {}) => {
  const current = await Effect.runPromise(Ref.make<StoredCLICredential | undefined>(options.previous))
  const events: Array<unknown> = []
  let pollIndex = 0
  const polls = options.polls ?? ["authorized"]
  const gateway = CLIAuthenticationGateway.of({
    discover: (origin) => Effect.sync(() => {
      events.push(["discover", origin])
      return metadata
    }),
    createDeviceAuthorization: () => Effect.sync(() => {
      events.push(["create"])
      return options.authorization ?? authorization
    }),
    pollDeviceAuthorization: (_instance, deviceCode) => Effect.suspend(
      (): Effect.Effect<CLIPollResult, CLIAuthenticationError> => {
      events.push(["poll", deviceCode])
      const next = polls[Math.min(pollIndex++, polls.length - 1)]
      switch (next) {
        case "pending": return Effect.succeed({ _tag: "Pending" as const, retryAfterSeconds: 1 })
        case "slow_down": return Effect.fail(new CLIAuthenticationError({
          reason: "slow_down", message: "Wait.", retryAfterSeconds: 1
        }))
        case "transport": return Effect.fail(new CLIAuthenticationError({
          reason: "transport", message: "Offline."
        }))
        case "denied": return Effect.fail(new CLIAuthenticationError({
          reason: "authorization_denied", message: "Denied."
        }))
        case "expired": return Effect.fail(new CLIAuthenticationError({
          reason: "authorization_expired", message: "Expired."
        }))
        default: return Effect.succeed({ _tag: "Authorized" as const, credential: issued })
      }
      }
    ),
    revokeCredential: (credential) => Effect.suspend(() => {
      events.push(["revoke", credential.credentialId])
      return options.revokeFailureIds?.includes(credential.credentialId)
        ? Effect.fail(new CLIAuthenticationError({ reason: "transport", message: "Offline." }))
        : Effect.void
    })
  })
  const store = CLICredentialStore.of({
    read: () => options.readFailure
      ? Effect.fail(new CLICredentialStoreError({ reason: "unsafe", message: "Unsafe credential directory." }))
      : Ref.get(current),
    replace: ({ expectedCredentialId, credential }) => Effect.gen(function*() {
      events.push(["replace", expectedCredentialId, credential.credentialId])
      if (options.saveFailure) {
        return yield* new CLICredentialStoreError({ reason: "io", message: "Credential file could not be saved." })
      }
      const before = yield* Ref.get(current)
      if (before?.credentialId !== expectedCredentialId) {
        return yield* new CLICredentialStoreError({ reason: "conflict", message: "Credential changed." })
      }
      yield* Ref.set(current, credential)
    }),
    remove: ({ expectedCredentialId }) => Effect.gen(function*() {
      events.push(["remove", expectedCredentialId])
      const before = yield* Ref.get(current)
      if (before?.credentialId !== expectedCredentialId) return false
      yield* Ref.set(current, undefined)
      return true
    })
  })
  const interaction = CLIAuthenticationInteraction.of({
    presentChallenge: (challenge) => Effect.sync(() => { events.push(["present", challenge]) }),
    openBrowser: (uri) => Effect.sync(() => {
      events.push(["browser", uri])
      return options.browserOpened ?? true
    })
  })
  const layer = Layer.mergeAll(
    Layer.succeed(CLIAuthenticationGateway, gateway),
    Layer.succeed(CLICredentialStore, store),
    Layer.succeed(CLIAuthenticationInteraction, interaction)
  )
  return {
    current,
    events,
    layer,
    run: <A, E>(effect: Effect.Effect<A, E, CLIAuthenticationGateway | CLICredentialStore | CLIAuthenticationInteraction>) =>
      effect.pipe(Effect.provide(layer), Effect.runPromise)
  }
}

describe("CLI authentication Module", () => {
  it("applies the explicit Instance precedence and production policy", async () => {
    await expect(Effect.runPromise(selectInstanceOrigin({
      commandLine: "https://flag.example",
      environment: "https://environment.example",
      savedActive: "https://saved.example"
    }))).resolves.toBe("https://flag.example")
    await expect(Effect.runPromise(selectInstanceOrigin({ environment: "http://atape.dev" })))
      .rejects.toMatchObject({ reason: "invalid_instance" })
  })

  it("keeps the secret inside the workflow and rotates the previous credential after durable replacement", async () => {
    const client = await fixture({ previous: oldCredential })
    const result = await client.run(loginCLI({ instanceOrigin: "https://atape.dev" }))

    expect(result).toMatchObject({
      instanceOrigin: "https://atape.dev",
      apiOrigin: "https://api.atape.dev",
      credentialId: "credential-new",
      replacedCredentialId: "credential-old",
      browserOpened: true
    })
    expect(JSON.stringify(result)).not.toContain("atc_v1_")
    expect((await Effect.runPromise(Ref.get(client.current)))?.credential).toBe("atc_v1_new-secret")
    expect(client.events).toContainEqual(["replace", "credential-old", "credential-new"])
    expect(client.events).toContainEqual(["revoke", "credential-old"])
    expect(client.events.findIndex((event) => Array.isArray(event) && event[0] === "replace"))
      .toBeLessThan(client.events.findIndex((event) => Array.isArray(event) && event[0] === "revoke"))
  })

  it.each([
    ["denied", "authorization_denied"],
    ["expired", "authorization_expired"]
  ] as const)("propagates a %s browser decision without persisting authority", async (poll, reason) => {
    const client = await fixture({ polls: [poll] })
    const failure = await Effect.gen(function*() {
      const fiber = yield* Effect.flip(loginCLI({
        instanceOrigin: "https://atape.dev", openBrowser: false
      })).pipe(Effect.forkChild)
      yield* TestClock.adjust("2 seconds")
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(client.layer), Effect.provide(TestClock.layer()), Effect.runPromise)

    expect(failure).toMatchObject({ reason })
    expect(await Effect.runPromise(Ref.get(client.current))).toBeUndefined()
  })

  it("continues when the browser cannot be opened and survives slow-down plus response loss", async () => {
    const client = await fixture({
      polls: ["slow_down", "transport", "authorized"],
      browserOpened: false
    })
    const result = await Effect.gen(function*() {
      const fiber = yield* loginCLI({ instanceOrigin: "https://atape.dev" }).pipe(Effect.forkChild)
      yield* TestClock.adjust("20 seconds")
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(client.layer), Effect.provide(TestClock.layer()), Effect.runPromise)

    expect(result).toMatchObject({ browserOpened: false, credentialId: "credential-new" })
    expect(client.events.filter((event) => Array.isArray(event) && event[0] === "poll")).toHaveLength(3)
  })

  it("cancels a pending login without polling again or persisting a credential", async () => {
    const client = await fixture({ polls: ["pending"] })
    await Effect.gen(function*() {
      const fiber = yield* loginCLI({
        instanceOrigin: "https://atape.dev", openBrowser: false
      }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.provide(client.layer), Effect.provide(TestClock.layer()), Effect.runPromise)

    expect(client.events.some((event) => Array.isArray(event) && event[0] === "replace")).toBe(false)
    expect(await Effect.runPromise(Ref.get(client.current))).toBeUndefined()
  })

  it("expires locally at the grant deadline without making a late poll", async () => {
    const client = await fixture({
      authorization: { ...authorization, expiresInSeconds: 1, intervalSeconds: 1 },
      polls: ["authorized"]
    })
    await expect(client.run(loginCLI({
      instanceOrigin: "https://atape.dev", openBrowser: false
    }))).rejects.toMatchObject({ reason: "authorization_expired" })
    expect(client.events.some((event) => Array.isArray(event) && event[0] === "poll")).toBe(false)
  })

  it("revokes a newly issued credential when durable storage fails", async () => {
    const client = await fixture({ saveFailure: true })
    await expect(client.run(loginCLI({ instanceOrigin: "https://atape.dev", openBrowser: false })))
      .rejects.toMatchObject({ reason: "credential_store" })
    expect(client.events).toContainEqual(["revoke", "credential-new"])
    expect(await Effect.runPromise(Ref.get(client.current))).toBeUndefined()
  })

  it("refuses an unsafe local store before asking the server to issue authority", async () => {
    const client = await fixture({ readFailure: true })
    await expect(client.run(loginCLI({ instanceOrigin: "https://atape.dev" })))
      .rejects.toMatchObject({ reason: "credential_store" })
    expect(client.events).toEqual([])
  })

  it("reports an orphan without ever returning its bearer when save and cleanup both fail", async () => {
    const client = await fixture({ saveFailure: true, revokeFailureIds: ["credential-new"] })
    await expect(client.run(loginCLI({ instanceOrigin: "https://atape.dev", openBrowser: false })))
      .rejects.toMatchObject({ reason: "credential_store", orphanedCredential: true })
  })

  it("removes local authority even when offline logout cannot confirm remote revocation", async () => {
    const client = await fixture({ previous: oldCredential, revokeFailureIds: ["credential-old"] })
    const result = await client.run(logoutCLI({ instanceOrigin: "https://atape.dev" }))
    expect(result).toMatchObject({ signedOut: true })
    expect(result.warnings).toHaveLength(1)
    expect(await Effect.runPromise(Ref.get(client.current))).toBeUndefined()
  })

  it("never removes a concurrently replaced credential", async () => {
    const client = await fixture({ previous: oldCredential })
    const newer = { ...oldCredential, credentialId: "credential-concurrent", credential: "atc_v1_concurrent" }
    const hostileLayer = Layer.succeed(CLIAuthenticationGateway, CLIAuthenticationGateway.of({
      discover: () => Effect.succeed(metadata),
      createDeviceAuthorization: () => Effect.succeed(authorization),
      pollDeviceAuthorization: () => Effect.succeed({ _tag: "Authorized", credential: issued }),
      revokeCredential: () => Ref.set(client.current, newer)
    }))
    await expect(logoutCLI({ instanceOrigin: "https://atape.dev" }).pipe(
      Effect.provide(hostileLayer),
      Effect.provide(Layer.succeed(CLICredentialStore, CLICredentialStore.of({
        read: () => Ref.get(client.current),
        replace: () => Effect.void,
        remove: ({ expectedCredentialId }) => Effect.gen(function*() {
          const before = yield* Ref.get(client.current)
          if (before?.credentialId !== expectedCredentialId) return false
          yield* Ref.set(client.current, undefined)
          return true
        })
      }))),
      Effect.runPromise
    )).rejects.toMatchObject({ reason: "credential_conflict" })
    expect((await Effect.runPromise(Ref.get(client.current)))?.credentialId).toBe("credential-concurrent")
  })

  it("bounds jittered transport backoff but honors a longer Retry-After", () => {
    expect(nextTransportRetryDelay({ previousSeconds: 5, minimumSeconds: 5, random: 0 })).toBe(8)
    expect(nextTransportRetryDelay({ previousSeconds: 20, minimumSeconds: 5, random: 1 })).toBe(30)
    expect(nextTransportRetryDelay({
      previousSeconds: 20, minimumSeconds: 5, retryAfterSeconds: 45, random: 0.5
    })).toBe(45)
  })
})
