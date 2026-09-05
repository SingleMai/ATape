import type {
  CLICredential,
  CLIDeviceGrantView,
  ExternalIdentity,
  InstanceMetadata,
  ProviderRegistration,
  AuthenticatedSession,
  Team,
  TeamMember,
  WebSession
} from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  AccessError,
  AuthenticationGateway,
  TeamAccessGateway,
  beginDefaultReauthentication,
  beginFederatedSignIn,
  createTeam,
  loadAccountSecurity,
  loadTeamAccess,
  removeTeamMember,
  rotateTeamJoinCode,
  resolveCLIDeviceGrant
} from "./access.ts"

const user = { id: "user-1", displayName: "Mai", avatarUrl: "" }
const session: WebSession = {
  id: "session-1",
  createdAt: "2026-09-05T00:00:00Z",
  lastUsedAt: "2026-09-05T00:00:00Z",
  reauthenticatedAt: "2026-09-05T00:00:00Z",
  absoluteExpiresAt: "2027-03-04T00:00:00Z",
  current: true
}
const bootstrap: AuthenticatedSession = { user, webSession: session }
const instance: InstanceMetadata = {
  protocol: "atape.instance.v1",
  instanceOrigin: "https://atape.dev",
  webOrigin: "https://atape.dev",
  apiOrigin: "https://atape.dev",
  protocols: ["atape.cli-authorization.v1"],
  releaseVersion: "0.2.0",
  authEpoch: "auth-v1",
  minimumCliVersion: "0.2.0"
}
const providers: ReadonlyArray<ProviderRegistration> = [{ id: "provider-a", label: "Provider A" }]
const identity: ExternalIdentity = {
  id: "identity-1",
  providerRegistrationId: "provider-a",
  displayName: "mai",
  avatarUrl: "",
  createdAt: "2026-09-05T00:00:00Z",
  lastVerifiedAt: "2026-09-05T00:00:00Z"
}
const credential: CLICredential = {
  id: "credential-1",
  capability: "atape-cli.v1",
  createdAt: "2026-09-05T00:00:00Z",
  lastUsedAt: "2026-09-05T00:00:00Z"
}
const grant: CLIDeviceGrantView = {
  grantViewId: "grant-1",
  userCode: "Q7KM4W",
  instanceOrigin: "https://atape.dev",
  clientLabel: "atape-cli",
  capabilityVersion: "atape-cli.v1",
  permissionSummary: "Read and sync this account's ATape projects.",
  expiresAt: "2026-09-05T00:15:00Z",
  status: "pending"
}

const authenticationFixture = (overrides: Partial<AuthenticationGateway["Service"]> = {}) => {
  const calls: Array<unknown> = []
  const service = AuthenticationGateway.of({
    restoreSession: () => Effect.succeed(bootstrap),
    loadInstance: () => Effect.succeed(instance),
    listProviderRegistrations: () => Effect.succeed(providers),
    beginSignIn: (input) => Effect.sync(() => {
      calls.push(["sign-in", input])
      return "https://provider.example/authorize?state=opaque"
    }),
    beginReauthentication: (input) => Effect.sync(() => {
      calls.push(["reauthenticate", input])
      return "https://provider.example/authorize?state=opaque"
    }),
    logout: () => Effect.void,
    listExternalIdentities: () => Effect.succeed([identity]),
    listWebSessions: () => Effect.succeed([session]),
    revokeWebSession: () => Effect.void,
    revokeAllWebSessions: () => Effect.void,
    listCLICredentials: () => Effect.succeed([credential]),
    revokeCLICredential: () => Effect.void,
    revokeAllCLICredentials: () => Effect.void,
    resolveCLIDeviceGrant: (code) => Effect.sync(() => {
      calls.push(["resolve", code])
      return grant
    }),
    decideCLIDeviceGrant: () => Effect.void,
    ...overrides
  })
  const layer = Layer.succeed(AuthenticationGateway, service)
  const run = <A, E>(effect: Effect.Effect<A, E, AuthenticationGateway>) =>
    effect.pipe(Effect.provide(layer), Effect.runPromise)
  return { calls, run }
}

describe("Authentication application Module", () => {
  it("normalizes local returns and validates Provider navigation", async () => {
    const fixture = authenticationFixture()
    const target = await fixture.run(beginFederatedSignIn({
      providerRegistrationId: "provider-a",
      returnTo: "/settings/account?from=login"
    }))

    expect(target).toBe("https://provider.example/authorize?state=opaque")
    expect(fixture.calls).toEqual([[
      "sign-in",
      { providerRegistrationId: "provider-a", returnTo: "/settings/account?from=login" }
    ]])
    await expect(fixture.run(beginFederatedSignIn({
      providerRegistrationId: "provider-a",
      returnTo: "//attacker.example/collect"
    }))).rejects.toMatchObject({ reason: "invalid_input" })
    expect(fixture.calls).toHaveLength(1)
  })

  it("selects an enabled Provider without leaking its identity to callers", async () => {
    const fixture = authenticationFixture()
    await fixture.run(beginDefaultReauthentication("/teams/team-a/settings/access"))
    expect(fixture.calls).toEqual([[
      "reauthenticate",
      { providerRegistrationId: "provider-a", returnTo: "/teams/team-a/settings/access" }
    ]])
  })

  it("preserves independently recoverable account sections", async () => {
    const fixture = authenticationFixture({
      listWebSessions: () => Effect.fail(new AccessError({
        reason: "unavailable",
        code: "service_unavailable",
        message: "Sessions are temporarily unavailable."
      }))
    })
    const result = await fixture.run(loadAccountSecurity())

    expect(result.identities).toMatchObject({ _tag: "Ready", value: [identity] })
    expect(result.webSessions).toMatchObject({
      _tag: "Failed",
      error: { code: "service_unavailable" }
    })
    expect(result.cliCredentials).toMatchObject({ _tag: "Ready", value: [credential] })
  })

  it("normalizes the CLI code before crossing the Gateway Seam", async () => {
    const fixture = authenticationFixture()
    await fixture.run(resolveCLIDeviceGrant("q7 km4w"))
    expect(fixture.calls).toEqual([["resolve", "Q7KM4W"]])

    await expect(fixture.run(resolveCLIDeviceGrant("Q7KMIW")))
      .rejects.toMatchObject({ reason: "invalid_input" })
    expect(fixture.calls).toHaveLength(1)
  })
})

const team: Team = {
  id: "team-id",
  slug: "team-a",
  displayName: "Team A",
  membership: { role: "owner" },
  createdAt: "2026-09-05T00:00:00Z",
  updatedAt: "2026-09-05T00:00:00Z"
}

const member: TeamMember = {
  userId: "user-1",
  displayName: "Mai",
  avatarUrl: "",
  role: "owner",
  joinedAt: "2026-09-05T00:00:00Z",
  updatedAt: "2026-09-05T00:00:00Z"
}

describe("Team access application Module", () => {
  it("validates and normalizes Team creation before the Gateway", async () => {
    const calls: Array<unknown> = []
    const layer = Layer.succeed(TeamAccessGateway, TeamAccessGateway.of({
      createTeam: (input) => Effect.sync(() => {
        calls.push(input)
        return team
      }),
      joinTeam: () => Effect.succeed(team),
      openTeam: () => Effect.succeed(team),
      listMembers: () => Effect.succeed([member]),
      readJoinCodeStatus: () => Effect.succeed({ enabled: false, generation: 0, updatedAt: team.updatedAt }),
      rotateJoinCode: () => Effect.succeed({ code: "ABC123", generation: 1, rotatedAt: team.updatedAt }),
      disableJoinCode: () => Effect.void,
      setMemberRole: () => Effect.void,
      removeMember: () => Effect.void,
      leaveTeam: () => Effect.void
    }))
    const run = <A, E>(effect: Effect.Effect<A, E, TeamAccessGateway>) =>
      effect.pipe(Effect.provide(layer), Effect.runPromise)

    await run(createTeam({ slug: "team-a", displayName: "  Team A  " }))
    expect(calls).toEqual([{ slug: "team-a", displayName: "Team A" }])
    await expect(run(createTeam({ slug: "A", displayName: "Team A" })))
      .rejects.toMatchObject({ reason: "invalid_input" })
    expect(calls).toHaveLength(1)
  })

  it("keeps owner-only join-code reads behind the Team Module", async () => {
    let joinCodeReads = 0
    const memberTeam: Team = { ...team, membership: { role: "member" } }
    const layer = Layer.succeed(TeamAccessGateway, TeamAccessGateway.of({
      createTeam: () => Effect.succeed(memberTeam),
      joinTeam: () => Effect.succeed(memberTeam),
      openTeam: () => Effect.succeed(memberTeam),
      listMembers: () => Effect.succeed([{ ...member, role: "member" }]),
      readJoinCodeStatus: () => Effect.sync(() => {
        joinCodeReads++
        return { enabled: true, generation: 1, updatedAt: team.updatedAt }
      }),
      rotateJoinCode: () => Effect.succeed({ code: "ABC234", generation: 1, rotatedAt: team.updatedAt }),
      disableJoinCode: () => Effect.void,
      setMemberRole: () => Effect.void,
      removeMember: () => Effect.void,
      leaveTeam: () => Effect.void
    }))

    const result = await loadTeamAccess("team-a").pipe(Effect.provide(layer), Effect.runPromise)
    expect(result.joinCode).toBeUndefined()
    expect(joinCodeReads).toBe(0)
  })

  it("rejects invalid mutation targets before crossing the Gateway Seam", async () => {
    let mutations = 0
    const layer = Layer.succeed(TeamAccessGateway, TeamAccessGateway.of({
      createTeam: () => Effect.succeed(team),
      joinTeam: () => Effect.succeed(team),
      openTeam: () => Effect.succeed(team),
      listMembers: () => Effect.succeed([member]),
      readJoinCodeStatus: () => Effect.succeed({ enabled: true, generation: 1, updatedAt: team.updatedAt }),
      rotateJoinCode: () => Effect.sync(() => {
        mutations++
        return { code: "ABC234", generation: 1, rotatedAt: team.updatedAt }
      }),
      disableJoinCode: () => Effect.void,
      setMemberRole: () => Effect.void,
      removeMember: () => Effect.sync(() => { mutations++ }),
      leaveTeam: () => Effect.void
    }))
    const run = <A, E>(effect: Effect.Effect<A, E, TeamAccessGateway>) =>
      effect.pipe(Effect.provide(layer), Effect.runPromise)

    await expect(run(rotateTeamJoinCode("INVALID"))).rejects.toMatchObject({ reason: "invalid_input" })
    await expect(run(removeTeamMember({ teamSlug: "team-a", userId: "bad\nuser" })))
      .rejects.toMatchObject({ reason: "invalid_input" })
    expect(mutations).toBe(0)
  })
})
