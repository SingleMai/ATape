import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { CanonicalCapabilitiesProtocol, CanonicalProfileVersion, CanonicalProfileVersion3, CanonicalProfileVersion4,
  CanonicalProfileVersion5, PublicationTargetProfile, PublicationTargetProfile2, PublicationTargetProfile3,
  PublicationTargetProfile4, PublicationTargetProfile5 } from "@atape/domain"
import { ensureCanonicalProfile } from "./canonicalProfileAdmission.ts"
import { AuthenticatedHTTPClient, type AuthenticatedHTTPRequest, type AuthenticatedHTTPResponse } from "./authenticatedHTTPClient.ts"
import { capabilities } from "./fixtures/publication-test-support.ts"

const binding = { instanceOrigin: "https://atape.test", userId: "user" }
const modern = [CanonicalProfileVersion, CanonicalProfileVersion3, CanonicalProfileVersion4]
const run = (replies: AuthenticatedHTTPResponse[], profile: typeof CanonicalProfileVersion3 | typeof CanonicalProfileVersion5 = CanonicalProfileVersion5) => {
  const requests: AuthenticatedHTTPRequest[] = []
  const http = AuthenticatedHTTPClient.of({ request: input => Effect.sync(() => {
    requests.push(input)
    const response = replies[requests.length - 1]
    if (!response) throw new Error("Unexpected extra admission request")
    return response
  }) })
  return { requests, result: Effect.runPromise(ensureCanonicalProfile(http, binding, profile)) }
}

describe("explicit stable tool profile admission", () => {
  it("opts into v5 before accepting affirmative direct admission", async () => {
    const f = run([{ status: 200, body: { protocol: CanonicalCapabilitiesProtocol, canonicalProfiles: [...modern, CanonicalProfileVersion5] } }])
    await f.result
    expect(f.requests).toEqual([{ instanceOrigin: binding.instanceOrigin, expectedUserId: binding.userId, method: "GET",
      path: "/api/v1/ingestion/canonical/capabilities", acceptCanonicalProfile: CanonicalProfileVersion5 }])
  })
  it("retains the released v3 discovery request without a v5 opt-in", async () => {
    const f = run([{ status: 200, body: { protocol: CanonicalCapabilitiesProtocol, canonicalProfiles: modern } }], CanonicalProfileVersion3)
    await f.result
    expect(f.requests[0]).not.toHaveProperty("acceptCanonicalProfile")
  })
  it.each([404, 405, 501])("uses affirmative target-v5 support only when direct discovery is absent (%s)", async status => {
    const f = run([{ status }, { status: 200, body: { ...capabilities,
      targetProfiles: [PublicationTargetProfile, PublicationTargetProfile2, PublicationTargetProfile3, PublicationTargetProfile4, PublicationTargetProfile5] } }])
    await f.result
    expect(f.requests[1]).toMatchObject({ path: "/api/v1/publications/capabilities", acceptPublicationTarget: PublicationTargetProfile5 })
  })
  it.each([
    { status: 200, body: { protocol: CanonicalCapabilitiesProtocol, canonicalProfiles: modern } },
    { status: 200, body: { protocol: CanonicalCapabilitiesProtocol, canonicalProfiles: [CanonicalProfileVersion5, CanonicalProfileVersion5] } },
    { status: 200, body: { protocol: CanonicalCapabilitiesProtocol, canonicalProfiles: ["unsupported"] } },
    { status: 401 }, { status: 403 }, { status: 429 }, { status: 500 }
  ])("does not downgrade authoritative negative or invalid discovery %#", async response => {
    const f = run([response])
    await expect(f.result).rejects.toMatchObject({ _tag: "CollectionTransportError" })
    expect(f.requests).toHaveLength(1)
  })
  it("does not substitute target-v4 support for v5 when the direct route is absent", async () => {
    const f = run([{ status: 404 }, { status: 200, body: { ...capabilities,
      targetProfiles: [PublicationTargetProfile, PublicationTargetProfile2, PublicationTargetProfile3, PublicationTargetProfile4] } }])
    await expect(f.result).rejects.toMatchObject({ reason: "rejected", retryable: false })
    expect(f.requests).toHaveLength(2)
  })
})
