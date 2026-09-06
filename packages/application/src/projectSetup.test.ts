import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { emptyClientConfig, type ClientConfig } from "@atape/domain"
import {
  ClientConfigStore,
  ProjectLocator
} from "./clientManagement.ts"
import {
  ProjectSetupError,
  ProjectSetupGateway,
  applyProjectSetup,
  planProjectSetup
} from "./projectSetup.ts"

const now = "2026-09-06T00:00:00Z"

const fixture = (options: { readonly exact?: boolean; readonly remote?: string } = {}) => {
  let config: ClientConfig = emptyClientConfig()
  const calls: Array<unknown> = []
  const team = { id: "team-1", slug: "acme", displayName: "Acme", role: "owner" as const }
  const project = {
    id: "project-1",
    teamId: team.id,
    type: "git" as const,
    name: "Payments",
    state: "active" as const,
    repositoryLinkState: "linked" as const,
    repositoryIdentity: "github.com/acme/payments",
    createdAt: now,
    updatedAt: now
  }
  const layer = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, ClientConfigStore.of({
      transact: (change) => change(structuredClone(config)).pipe(
        Effect.tap((result) => Effect.sync(() => {
          if (result.config !== undefined) config = structuredClone(result.config)
        })),
        Effect.map((result) => result.value)
      )
    })),
    Layer.succeed(ProjectLocator, ProjectLocator.of({
      locate: () => Effect.succeed({
        path: "/work/payments",
        name: "payments",
        type: "git",
        ...(options.remote === "missing" ? {} : { repositoryRemote: options.remote ?? "git@github.com:acme/payments.git" })
      })
    })),
    Layer.succeed(ProjectSetupGateway, ProjectSetupGateway.of({
      loadWorkspace: () => Effect.succeed({
        user: { id: "user-1", displayName: "Mai" },
        teams: [team],
        projects: options.exact ? [project] : []
      }),
      matchGitProject: (_instance, teamId, remote) => Effect.sync(() => {
        calls.push(["match", teamId, remote])
        return options.exact
          ? { status: "exact" as const, project }
          : { status: "none" as const }
      }),
      createProject: (_instance, teamSlug, spec) => Effect.sync(() => {
        calls.push(["create", teamSlug, spec])
        return project
      })
    }))
  )
  return {
    calls,
    read: () => config,
    run: <A, E>(effect: Effect.Effect<A, E, ProjectLocator | ProjectSetupGateway | ClientConfigStore>) =>
      effect.pipe(Effect.provide(layer), Effect.runPromise)
  }
}

describe("Project setup Module", () => {
  it("attaches an exact Git match without sending the local path to the server", async () => {
    const client = fixture({ exact: true })
    const plan = await client.run(planProjectSetup({
      instanceOrigin: "https://atape.net", path: "/work/payments"
    }))
    const result = await client.run(applyProjectSetup(plan, {
      mode: "exact", teamId: "team-1", projectId: "project-1"
    }))

    expect(result).toMatchObject({ createdLocally: true, createdRemotely: false })
    expect(client.read().projects[0]).toMatchObject({
      id: "project-1", instanceOrigin: "https://atape.net", userId: "user-1", path: "/work/payments"
    })
    expect(JSON.stringify(client.calls)).not.toContain("/work/payments")
  })

  it("creates a missing Git Project only after an explicit create selection", async () => {
    const client = fixture()
    const plan = await client.run(planProjectSetup({
      instanceOrigin: "https://atape.net", path: "/work/payments"
    }))
    expect(plan.exactMatches).toEqual([])
    const result = await client.run(applyProjectSetup(plan, {
      mode: "create", teamId: "team-1"
    }))
    expect(result.createdRemotely).toBe(true)
    expect(client.calls).toContainEqual([
      "create", "acme", { type: "git", remote: "git@github.com:acme/payments.git" }
    ])
  })

  it("fails before HTTP matching when a Git repository has no origin", async () => {
    const client = fixture({ remote: "missing" })
    await expect(client.run(planProjectSetup({
      instanceOrigin: "https://atape.net", path: "/work/payments"
    }))).rejects.toBeInstanceOf(ProjectSetupError)
    expect(client.calls).toEqual([])
  })
})
