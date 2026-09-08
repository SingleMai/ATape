import { emptyClientConfig, AdapterProtocolVersion, type ClientConfig, type CollectorCheckpoint, type CollectorRunState } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { AdapterPackages, ClientConfigStore, ProjectLocator } from "./clientManagement.ts"
import { CollectorDaemonProcess, CollectorRunStatusStore } from "./collectorDaemon.ts"
import { CollectorStateStore } from "./collector.ts"
import { ProjectSetupGateway, type SetupRemoteProject } from "./projectSetup.ts"
import {
  CLISetupPlatform, changeProjectSources, completeGuidedSetup, guidedSourceChoices,
  inspectCLIExperience, prepareGuidedSetup, removeExperienceProject, startExperienceCollector, stopExperienceCollector
} from "./cliExperience.ts"

const date = "2026-09-08T00:00:00Z"
const fixture = () => {
  let config: ClientConfig = emptyClientConfig()
  let userId = "user-1"
  let failInstall = false
  let running = false
  let starts = 0
  let creations = 0
  let runState: CollectorRunState = { version: 1, jobs: [] }
  let checkpoint: CollectorCheckpoint | undefined
  const packages: string[] = []
  const projects: SetupRemoteProject[] = []
  const keys: string[] = []
  const team = { id: "team-1", slug: "acme", displayName: "Acme", role: "owner" as const }
  const layer = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, ClientConfigStore.of({ transact: change => change(structuredClone(config)).pipe(
      Effect.tap(result => Effect.sync(() => { if (result.config) config = structuredClone(result.config) })), Effect.map(result => result.value)
    ) })),
    Layer.succeed(ProjectLocator, ProjectLocator.of({ locate: path => Effect.succeed({ path, name: "Payments", type: "directory" }) })),
    Layer.succeed(CLISetupPlatform, CLISetupPlatform.of({
      detectSources: () => Effect.succeed(["codex"]), suggestDirectories: () => Effect.succeed([]),
      supportsGit: () => Effect.succeed(true), creationKey: () => Effect.succeed("stable-request")
    })),
    Layer.succeed(AdapterPackages, AdapterPackages.of({ install: spec => Effect.sync(() => {
      packages.push(spec)
      if (failInstall) throw new Error("offline")
      const id = spec.includes("claude") ? "claude" : "codex"
      return { packageName: `@atape/adapter-${id}`, upgradeSpec: spec, version: "1.0.0", manifest: {
        protocolVersion: AdapterProtocolVersion, adapterId: id, displayName: id, entry: "./index.js", harnesses: [id]
      } }
    }) })),
    Layer.succeed(ProjectSetupGateway, ProjectSetupGateway.of({
      loadWorkspace: () => Effect.succeed({ user: { id: userId, displayName: "Mai" }, teams: [team], projects }),
      matchGitProject: () => Effect.succeed({ status: "none" }),
      createProject: (_instance, _team, spec, options) => Effect.sync(() => {
        keys.push(options?.idempotencyKey ?? "missing")
        expect(options?.expectedUserId).toBe("user-1")
        let project = projects[0]
        if (!project) {
          creations++
          project = { id: "project-1", teamId: team.id, type: "folder", name: spec.type === "folder" ? spec.name : "Git",
            state: "active", repositoryLinkState: "not_applicable", createdAt: date, updatedAt: date }
          projects.push(project)
        }
        return project
      })
    })),
    Layer.succeed(CollectorDaemonProcess, CollectorDaemonProcess.of({
      inspect: () => Effect.succeed(running ? { pid: 10, startedAt: date, intervalMs: 30000, concurrency: 4, logFile: "/logs/collector" } : undefined),
      start: options => Effect.sync(() => { starts++; running = true; return { ...options, pid: 10, startedAt: date, logFile: "/logs/collector", created: true } }),
      stop: () => Effect.sync(() => { const was = running; running = false; return was })
    })),
    Layer.succeed(CollectorRunStatusStore, CollectorRunStatusStore.of({
      read: () => Effect.succeed(runState), recordCycle: () => Effect.void, recordCollectorFailure: () => Effect.void
    })),
    Layer.succeed(CollectorStateStore, CollectorStateStore.of({ snapshot: () => Effect.succeed({ installationId: "install-1", ...(checkpoint ? { checkpoint } : {}) }), commit: () => Effect.void }))
  )
  return {
    run: <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>, signal?: AbortSignal) => Effect.runPromise(effect.pipe(Effect.provide(layer)), signal ? { signal } : undefined),
    config: () => config, changeUser: () => { userId = "different-user" },
    failInstall: (value: boolean) => { failInstall = value },
    record: (state: CollectorRunState, progress?: CollectorCheckpoint) => { runState = state; checkpoint = progress },
    packages, keys, creations: () => creations, starts: () => starts,
    edit: (change: (config: ClientConfig) => ClientConfig) => { config = change(config) }
  }
}
const input = { instanceOrigin: "https://atape.net", path: "/work/payments" }
const progress = () => Effect.void

describe("CLI experience application Interface", () => {
  it("plans without installing/enabling/starting, then applies only the explicit selection", async () => {
    const client = fixture()
    const plan = await client.run(prepareGuidedSetup(input))
    expect(guidedSourceChoices(plan, "team-1").map(choice => [choice.id, choice.selected])).toEqual([["codex", true], ["claude", false]])
    expect(client.config().projects).toEqual([])
    expect(client.packages).toEqual([])
    expect(client.starts()).toBe(0)
    const project = await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["claude"], progress }))
    expect(client.packages).toEqual(["@atape/adapter-claude"])
    expect(project.adapterIds).toEqual(["claude"])
    expect(client.keys).toEqual(["stable-request"])
    expect(client.starts()).toBe(1)
    expect((await client.run(inspectCLIExperience())).projects[0]?.state).toBe("syncing")
  })
  it("resumes an existing directory registration and preserves unselected history on local removal", async () => {
    const client = fixture()
    const first = await client.run(prepareGuidedSetup(input))
    const project = await client.run(completeGuidedSetup({ plan: first, teamId: "team-1", sourceIds: ["codex"], progress }))
    const resumed = await client.run(prepareGuidedSetup(input))
    expect(resumed.existingDirectory?.id).toBe(project.id)
    await client.run(completeGuidedSetup({ plan: resumed, teamId: "team-1", sourceIds: ["codex"], progress }))
    expect(client.creations()).toBe(1)
    expect(client.packages).toEqual(["@atape/adapter-codex"])
    await client.run(removeExperienceProject(project))
    expect(client.config().projects).toEqual([])
    expect(client.creations()).toBe(1)
  })
  it("does not enable sources or start after installation fails or confirmation is cancelled", async () => {
    const client = fixture()
    const plan = await client.run(prepareGuidedSetup(input))
    client.failInstall(true)
    await expect(client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress }))).rejects.toThrow("offline")
    expect(client.config().projects).toEqual([])
    expect(client.creations()).toBe(0)
    expect(client.starts()).toBe(0)
    client.failInstall(false)
    const cancellation = new AbortController()
    const pending = client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress: () => Effect.sleep(10_000) }), cancellation.signal)
    cancellation.abort()
    await expect(pending).rejects.toBeDefined()
    expect(client.config().projects).toEqual([])
    await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress }))
    expect(client.creations()).toBe(1)
  })
  it("rejects changed accounts before setup side effects and before global resume", async () => {
    const client = fixture()
    const plan = await client.run(prepareGuidedSetup(input))
    const project = await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress }))
    client.changeUser()
    await expect(client.run(startExperienceCollector())).rejects.toMatchObject({ reason: "changed" })
    await expect(client.run(changeProjectSources(project, ["claude"]))).rejects.toMatchObject({ reason: "changed" })
    await expect(client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["claude"], progress }))).rejects.toMatchObject({ reason: "changed" })
    expect(client.packages).toEqual(["@atape/adapter-codex"])
    expect(client.starts()).toBe(1)
    expect(client.config().projects[0]?.userId).toBe("user-1")
  })
  it("keeps an already captured Project up to date after an empty cycle, instead of returning to first-conversation waiting", async () => {
    const client = fixture()
    const plan = await client.run(prepareGuidedSetup(input))
    const project = await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress }))
    const state: CollectorRunState = { version: 1, jobs: [{
      projectId: project.id, adapterId: "codex", lastAttemptAt: date, lastSuccessAt: date,
      canonicalBatches: 0, observations: 0, hasMore: false
    }] }
    client.record(state)
    expect((await client.run(inspectCLIExperience())).projects[0]?.state).toBe("waiting")
    client.record(state, { instanceOrigin: project.instanceOrigin, userId: project.userId, projectId: project.id,
      projectCreatedAt: project.createdAt, adapterId: "codex", adapterVersion: "1.0.0", revision: 2,
      cursor: "committed", updatedAt: date, rawObjects: [{ sourceSessionId: "session-1", sourceObjectId: "object-1",
        sourceName: "session.jsonl", mediaType: "application/x-ndjson", sourceGeneration: "generation-1",
        sourceOffset: 100, serverGeneration: 1, serverOffset: 100, finalized: true }] })
    expect((await client.run(inspectCLIExperience())).projects[0]?.state).toBe("up_to_date")
  })
  it("allows an explicit empty source selection without removing the Project", async () => {
    const client = fixture()
    const plan = await client.run(prepareGuidedSetup(input))
    const project = await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress }))
    const changed = await client.run(changeProjectSources(project, []))
    expect(changed.adapterIds).toEqual([])
    expect(client.config().projects).toHaveLength(1)
    expect((await client.run(inspectCLIExperience())).projects[0]?.state).toBe("no_sources")
  })
  it("distinguishes automatic retry, required repair and stopped sync without starting jobs on inspection", async () => {
    const client = fixture()
    const plan = await client.run(prepareGuidedSetup(input))
    const project = await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress }))
    const failure = { projectId: project.id, adapterId: "codex", lastAttemptAt: date,
      lastFailureAt: date, failureReason: "transport" as const, failureMessage: "Server unavailable", retryable: true }
    client.record({ version: 1, jobs: [failure] })
    expect((await client.run(inspectCLIExperience())).projects[0]?.recovery.kind).toBe("automatic_retry")
    client.record({ version: 1, jobs: [{ ...failure, retryable: false }] })
    expect((await client.run(inspectCLIExperience())).projects[0]?.recovery.kind).toBe("repair")
    client.record({ version: 1, jobs: [failure], collectorFailure: { occurredAt: date, message: "Cannot read configuration" } })
    expect((await client.run(inspectCLIExperience())).projects[0]?.recovery.kind).toBe("repair")
    client.record({ version: 1, jobs: [failure] })
    await client.run(stopExperienceCollector())
    expect((await client.run(inspectCLIExperience())).projects[0]?.recovery.kind).toBe("resume")
    expect(client.starts()).toBe(1)
  })

  it("routes global authentication blocks to the affected Project, including while the process is stopping", async () => {
    const client = fixture()
    const plan = await client.run(prepareGuidedSetup(input))
    const project = await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress }))
    const other = { ...project, id: "other-project", path: "/work/other", name: "Other", instanceOrigin: "https://other.example" }
    client.edit(config => ({ ...config, projects: [...config.projects, other] }))
    client.record({ version: 1, jobs: [{ projectId: other.id, adapterId: "codex", lastAttemptAt: date,
      failureReason: "unauthenticated", failureMessage: "Expired credential", retryable: false }] })
    const snapshot = await client.run(inspectCLIExperience())
    expect(snapshot.projects[0]?.recovery).toEqual({ kind: "sign_in_elsewhere", project: other })
    expect(snapshot.projects[1]?.recovery.kind).toBe("sign_in")
    expect(client.starts()).toBe(1)
  })

  it("keeps partial coverage distinct from failures and clears recovery after a healthy cycle", async () => {
    const client = fixture()
    const plan = await client.run(prepareGuidedSetup(input))
    const project = await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress }))
    const job = { projectId: project.id, adapterId: "codex", lastAttemptAt: date, lastSuccessAt: date, canonicalBatches: 1 }
    client.record({ version: 1, jobs: [{ ...job, sourceFailures: [{ source: "old-session", reason: "attribution" }] }] })
    expect((await client.run(inspectCLIExperience())).projects[0]?.recovery.kind).toBe("partial")
    client.record({ version: 1, jobs: [job] })
    expect((await client.run(inspectCLIExperience())).projects[0]).toMatchObject({ state: "up_to_date", recovery: { kind: "none" } })
  })

})
