import { PublicationTransport } from "@atape/application"
import { PublicationTargetProfile3, type PublicationBinding } from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AuthenticatedHTTPClient, type AuthenticatedHTTPRequest } from "./authenticatedHTTPClient.ts"
import { makePublicationTransportLayer } from "./publicationTransport.ts"

const binding: PublicationBinding = {
  instanceOrigin: "https://atape.net", userId: "user-1", installationId: "installation-1"
}
const legacyCapabilities = {
  protocol: "atape.publication.v1", targetProfile: "atape.publication-target.v1",
  targetProfiles: ["atape.publication-target.v1", "atape.publication-target.v2"], legacyAdoption: true,
  limits: {
    partBytes: 4 * 1024 * 1024, targetBytes: 1024 * 1024 * 1024, userPendingBytes: 16 * 1024 * 1024 * 1024,
    parts: 4096, reservations: 128, reservationLifetimeMs: 24 * 60 * 60 * 1000, leaseLifetimeMs: 60 * 60 * 1000
  },
  statusPageSize: 100, reclaimPageSize: 32
}

// Frozen from f67ad67, before v3. Do not derive this compatibility decoder
// from the current schema: an old installed Host cannot accept new literals.
const oldCount = (maximum: number, minimum = 1) => Schema.Number.check(
  Schema.isInt(), Schema.isGreaterThanOrEqualTo(minimum), Schema.isLessThanOrEqualTo(maximum))
const FrozenOldPublicationCapabilities = Schema.Struct({
  protocol: Schema.Literal("atape.publication.v1"), targetProfile: Schema.Literal("atape.publication-target.v1"),
  targetProfiles: Schema.optionalKey(Schema.Array(Schema.Literals([
    "atape.publication-target.v1", "atape.publication-target.v2"
  ])).check(Schema.isMaxLength(2))),
  legacyAdoption: Schema.optionalKey(Schema.Boolean),
  limits: Schema.Struct({
    partBytes: oldCount(4 * 1024 * 1024), targetBytes: oldCount(1024 * 1024 * 1024),
    userPendingBytes: oldCount(16 * 1024 * 1024 * 1024), parts: oldCount(4096), reservations: oldCount(128),
    reservationLifetimeMs: oldCount(24 * 60 * 60 * 1000), leaseLifetimeMs: oldCount(60 * 60 * 1000)
  }),
  statusPageSize: Schema.Literal(100), reclaimPageSize: Schema.Literal(32)
})

const fixture = (body: unknown) => {
  const requests: AuthenticatedHTTPRequest[] = []
  const layer = makePublicationTransportLayer().pipe(Layer.provide(Layer.succeed(AuthenticatedHTTPClient,
    AuthenticatedHTTPClient.of({ request: input => Effect.sync(() => {
      requests.push(input)
      return { status: 200, body }
    }) }))))
  return {
    requests,
    capabilities: () => PublicationTransport.use(transport => transport.capabilities(binding)).pipe(
      Effect.provide(layer), Effect.runPromise)
  }
}

describe("publication capability negotiation", () => {
  it("explicitly accepts v3 while retaining the authenticated binding", async () => {
    const body = { ...legacyCapabilities, targetProfiles: [...legacyCapabilities.targetProfiles, PublicationTargetProfile3] }
    const client = fixture(body)
    expect(await client.capabilities()).toEqual(body)
    expect(client.requests).toEqual([{
      instanceOrigin: binding.instanceOrigin, expectedUserId: binding.userId, method: "GET",
      path: "/api/v1/publications/capabilities", acceptPublicationTarget: PublicationTargetProfile3
    }])
  })

  it("continues to decode an older Server that ignores the opt-in", async () => {
    expect(await fixture(legacyCapabilities).capabilities()).toEqual(legacyCapabilities)
  })

  it("keeps the default capability shape readable by the frozen old Host decoder", async () => {
    expect(await Effect.runPromise(Schema.decodeUnknownEffect(FrozenOldPublicationCapabilities)(legacyCapabilities)))
      .toEqual(legacyCapabilities)
    await expect(Effect.runPromise(Schema.decodeUnknownEffect(FrozenOldPublicationCapabilities)({
      ...legacyCapabilities, targetProfiles: [...legacyCapabilities.targetProfiles, PublicationTargetProfile3]
    }))).rejects.toBeDefined()
  })
})
