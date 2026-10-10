import { PublicationTransport } from "@atape/application"
import { PublicationTargetProfile3, type PublicationBinding } from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AuthenticatedHTTPClient, type AuthenticatedHTTPRequest } from "./authenticatedHTTPClient.ts"
import { makePublicationTransportLayer } from "./publicationTransport.ts"
import { FrozenOldPublicationCapabilities } from "./fixtures/frozen-publication-v2.ts"

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
