import { emptyClientConfig, AdapterProtocolVersion, type ClientConfig, type CollectorCheckpoint, type CollectorRunState } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { AdapterPackages, ClientConfigStore, ProjectLocator, inspectClient, installAdapter, setupProject } from "./clientManagement.ts"
import { CollectorDaemonProcess, CollectorRunStatusStore } from "./collectorDaemon.ts"
import { CollectorStateStore } from "./collector.ts"
import { ProjectSetupGateway, type SetupRemoteProject } from "./projectSetup.ts"
import {
  CLISetupPlatform, completeGuidedSetup,
  inspectCLIExperience, prepareGuidedSetup, removeExperienceProject, startExperienceCollector, stopExperienceCollector,
  inspectTools, planToolChange, applyToolChange, updateSyncReader
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
  let onInstall: (() => void) | undefined
  const packages: string[] = []
  const projects: SetupRemoteProject[] = []
  const keys: string[] = []
  const team = { id: "team-1", slug: "acme", displayName: "Acme", role: "owner" as const }
  const layer = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, ClientConfigStore.of({ transact: change => change(structuredClone(config)).pipe(
      Effect.tap(result => Effect.sync(() => {
        if (result.config) {
          const installed = result.config.adapters.length > config.adapters.length
          config = structuredClone(result.config)
          if (installed) onInstall?.()
        }
      })), Effect.map(result => result.value)
    ) })),
    Layer.succeed(ProjectLocator, ProjectLocator.of({ locate: path => Effect.succeed({ path, name: "Payments", type: "directory" }) })),
    Layer.succeed(CLISetupPlatform, CLISetupPlatform.of({
      detectSources: () => Effect.succeed(["codex"]), suggestDirectories: () => Effect.succeed([]),
      supportsGit: () => Effect.succeed(true), creationKey: () => Effect.succeed("stable-request")
    })),
    Layer.succeed(AdapterPackages, AdapterPackages.of({ prune: () => Effect.die("Unexpected package maintenance"), install: spec => Effect.sleep(10).pipe(Effect.andThen(Effect.sync(() => {
      packages.push(spec)
      if (failInstall) throw new Error("offline")
      const id = spec.includes("opencode") ? "opencode" : spec.includes("claude") ? "claude" : "codex"
      return { packageName: `@atape/adapter-${id}`, upgradeSpec: spec, version: "1.0.0", manifest: {
        protocolVersion: AdapterProtocolVersion, adapterId: id, displayName: id, entry: "./index.js", harnesses: [id]
      } }
    }))) })),
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
      refresh: () => Effect.succeed(false),
      inspect: () => Effect.succeed(running ? { pid: 10, startedAt: date, intervalMs: 30000, concurrency: 4, logFile: "/logs/collector" } : undefined),
      start: options => Effect.sync(() => { starts++; running = true; return { ...options, pid: 10, startedAt: date, logFile: "/logs/collector", created: true } }),
      stop: () => Effect.sync(() => { const was = running; running = false; return was })
    })),
    Layer.succeed(CollectorRunStatusStore, CollectorRunStatusStore.of({
      read: () => Effect.succeed(runState), recordCycle: () => Effect.void, recordCollectorFailure: () => Effect.void
    })),
    Layer.succeed(CollectorStateStore, CollectorStateStore.of({
      capturedScopes: () => Effect.succeed(checkpoint && (checkpoint.canonicalPublished || checkpoint.rawObjects.length) ? [checkpoint] : []),
      snapshot: () => Effect.succeed({ installationId: "install-1", ...(checkpoint ? { checkpoint } : {}) }), commit: () => Effect.void }))
  )
  return {
    run: <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>, signal?: AbortSignal) => Effect.runPromise(effect.pipe(Effect.provide(layer)), signal ? { signal } : undefined),
    config: () => config, changeUser: () => { userId = "different-user" },
    failInstall: (value: boolean) => { failInstall = value },
    record: (state: CollectorRunState, progress?: CollectorCheckpoint) => { runState = state; checkpoint = progress },
    packages, keys, creations: () => creations, starts: () => starts,
    edit: (change: (config: ClientConfig) => ClientConfig) => { config = change(config) },
    remoteProjects: projects, duringInstall: (callback: () => void) => { onInstall = callback }
  }
}
const input = { instanceOrigin: "https://atape.net", path: "/work/payments" }
const progress = () => Effect.void

describe("CLI experience application Interface", () => {
  it.each(["codex", "opencode"])("configures %s tools once, connects subsequent Projects with the same selection and rejects scoped overrides", async sourceId => {
    const client = fixture()
    expect((await client.run(inspectTools())).configured).toBe(false)
    const tools = await client.run(planToolChange([sourceId]))
    expect(client.packages).toEqual([])
    await client.run(applyToolChange(tools))
    expect(client.config()).toMatchObject({ version: 3, enabledAdapterIds: [sourceId], projects: [] })
    expect(client.starts()).toBe(0)
    const plan = await client.run(prepareGuidedSetup(input))
    const first = await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: [sourceId], progress }))
    const { adapterIds, ...identity } = first
    const second = await client.run(setupProject({ ...identity, path: "/work/second", projectId: "second", name: "Second" }))
    expect(second.project.adapterIds).toEqual([sourceId])
    expect(client.packages).toEqual([`@atape/adapter-${sourceId}`])
    expect((await client.run(inspectCLIExperience())).projects).toHaveLength(2)
    await expect(client.run(setupProject({ ...identity, path: "/work/third", projectId: "third", expectedToolIds: [] }))).rejects.toMatchObject({ reason: "conflict" })
    expect(client.config().projects.every(project => !("adapterIds" in project))).toBe(true)
    expect((await client.run(inspectClient())).projects.every(project => project.adapterIds.join() === sourceId)).toBe(true)
  })

  it("previews changes without enabling anything, then applies one global selection to every Project", async () => {
    const client = fixture()
    await client.run(applyToolChange(await client.run(planToolChange(["codex"]))))
    const setup = await client.run(prepareGuidedSetup(input))
    const first = await client.run(completeGuidedSetup({ plan: setup, teamId: "team-1", sourceIds: ["codex"], progress }))
    await client.run(installAdapter("@atape/adapter-claude"))
    await client.run(setupProject({ ...first, path: "/work/second", projectId: "second", name: "Second" }))
    client.remoteProjects.push({ ...client.remoteProjects[0]!, id: "second", name: "Second" })
    const before = structuredClone(client.config())
    const inspection = await client.run(inspectTools())
    expect(inspection).toMatchObject({ configured: true })
    expect(inspection.choices.filter(choice => choice.selected).map(choice => choice.id).sort()).toEqual(["codex"])
    const plan = await client.run(planToolChange(["codex", "claude"]))
    expect(plan.projects.map(change => ({ id: change.project.id, added: change.added }))).toEqual([
      { id: "project-1", added: ["claude"] }, { id: "second", added: ["claude"] }
    ])
    expect(client.config()).toEqual(before)
    await client.run(applyToolChange(plan))
    expect((await client.run(inspectClient())).projects.map(project => project.adapterIds)).toEqual([["claude", "codex"], ["claude", "codex"]])
    expect(client.config().projects).toEqual(before.projects)
    expect(client.starts()).toBe(1)
    const disabled = await client.run(planToolChange([]))
    await client.run(applyToolChange(disabled))
    expect((await client.run(inspectCLIExperience())).projects.every(project => project.state === "no_sources")).toBe(true)
    expect(client.config().projects).toHaveLength(2)
  })

  it("keeps authorization unchanged on install failure, cancellation and stale impact plans", async () => {
    const client = fixture()
    await client.run(applyToolChange(await client.run(planToolChange(["codex"]))))
    const before = structuredClone(client.config())
    const plan = await client.run(planToolChange(["codex", "claude"]))
    client.failInstall(true)
    await expect(client.run(applyToolChange(plan))).rejects.toThrow("offline")
    expect(client.config()).toEqual(before)
    client.failInstall(false)
    const cancellation = new AbortController()
    cancellation.abort()
    await expect(client.run(applyToolChange(plan), cancellation.signal)).rejects.toBeDefined()
    expect(client.config()).toEqual(before)
    client.duringInstall(() => client.edit(config => ({ ...config, version: 3, enabledAdapterIds: [] })))
    await expect(client.run(applyToolChange(plan))).rejects.toMatchObject({ reason: "changed" })
    expect(client.config()).toMatchObject({ version: 3, enabledAdapterIds: [] })
    const count = client.packages.length
    await expect(client.run(applyToolChange(plan))).rejects.toMatchObject({ reason: "changed" })
    expect(client.packages).toHaveLength(count)
  })

  it("invalidates a Project review when global tools change and preserves acknowledged progress across selection changes", async () => {
    const client = fixture()
    await client.run(applyToolChange(await client.run(planToolChange(["codex"]))))
    const stale = await client.run(prepareGuidedSetup(input))
    await client.run(applyToolChange(await client.run(planToolChange(["claude"]))))
    await expect(client.run(completeGuidedSetup({ plan: stale, teamId: "team-1", sourceIds: ["codex"], progress }))).rejects.toMatchObject({ reason: "changed" })
    expect(client.creations()).toBe(0)
    const plan = await client.run(prepareGuidedSetup(input))
    const project = await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["claude"], progress }))
    const checkpoint: CollectorCheckpoint = { instanceOrigin: project.instanceOrigin, userId: project.userId, projectId: project.id,
      projectCreatedAt: project.createdAt, adapterId: "claude", adapterVersion: "1.0.0", revision: 7, cursor: "acknowledged",
      updatedAt: date, rawObjects: [] }
    client.record({ version: 1, jobs: [] }, checkpoint)
    await client.run(applyToolChange(await client.run(planToolChange([]))))
    await client.run(applyToolChange(await client.run(planToolChange(["claude"]))))
    const saved = await client.run(Effect.flatMap(CollectorStateStore, store => store.snapshot(project.instanceOrigin, project.userId, project.id, "claude")))
    expect(saved.checkpoint).toEqual(checkpoint)
    expect(client.creations()).toBe(1)
  })

  it("plans without installing/enabling/starting, then applies only the explicit selection", async () => {
    const client = fixture()
    const plan = await client.run(prepareGuidedSetup(input))
    expect((await client.run(inspectTools())).choices.map(choice => [choice.id, choice.selected])).toEqual([["codex", true], ["claude", false], ["codebuddy", false], ["opencode", false]])
    expect(client.config().projects).toEqual([])
    expect(client.packages).toEqual([])
    expect(client.starts()).toBe(0)
    await client.run(applyToolChange(await client.run(planToolChange(["claude"]))))
    const project = await client.run(completeGuidedSetup({ plan: await client.run(prepareGuidedSetup(input)), teamId: "team-1", sourceIds: ["claude"], progress }))
    expect(client.packages).toEqual(["@atape/adapter-claude"])
    expect(project.adapterIds).toEqual(["claude"])
    expect(client.keys).toEqual(["stable-request"])
    expect(client.starts()).toBe(1)
    expect((await client.run(inspectCLIExperience())).projects[0]?.state).toBe("syncing")
  })
  it("resumes an existing directory registration and preserves unselected history on local removal", async () => {
    const client = fixture()
    await client.run(applyToolChange(await client.run(planToolChange(["codex"]))))
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
  it("does not connect or start when Project confirmation is cancelled", async () => {
    const client = fixture()
    await client.run(applyToolChange(await client.run(planToolChange(["codex"]))))
    const plan = await client.run(prepareGuidedSetup(input))
    const cancellation = new AbortController()
    const pending = client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress: () => Effect.sleep(10_000) }), cancellation.signal)
    cancellation.abort()
    await expect(pending).rejects.toBeDefined()
    expect(client.config().projects).toEqual([])
    expect(client.creations()).toBe(0)
    expect(client.starts()).toBe(0)
    await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress }))
    expect(client.creations()).toBe(1)
  })
  it("rejects changed accounts before setup side effects and before global resume", async () => {
    const client = fixture()
    await client.run(applyToolChange(await client.run(planToolChange(["codex"]))))
    const plan = await client.run(prepareGuidedSetup(input))
    const project = await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress }))
    client.changeUser()
    await expect(client.run(startExperienceCollector())).rejects.toMatchObject({ reason: "changed" })
    await expect(client.run(applyToolChange(await client.run(planToolChange(["claude"]))))).rejects.toMatchObject({ reason: "changed" })
    await expect(client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["claude"], progress }))).rejects.toMatchObject({ reason: "changed" })
    expect(client.packages).toEqual(["@atape/adapter-codex"])
    expect(client.starts()).toBe(1)
    expect(client.config().projects[0]?.userId).toBe("user-1")
  })
  it("keeps an already captured Project up to date after an empty cycle, instead of returning to first-conversation waiting", async () => {
    const client = fixture()
    await client.run(applyToolChange(await client.run(planToolChange(["codex"]))))
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
  it("uses confirmed Canonical progress without parsing source cursors or hiding later failures", async () => {
    const client = fixture()
    await client.run(applyToolChange(await client.run(planToolChange(["codex"]))))
    const plan = await client.run(prepareGuidedSetup(input))
    const project = await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress }))
    const job = { projectId: project.id, adapterId: "codex", lastAttemptAt: date, lastSuccessAt: date,
      canonicalBatches: 0, observations: 0, hasMore: false }
    const state: CollectorRunState = { version: 1, jobs: [job] }
    const checkpoint: CollectorCheckpoint = { instanceOrigin: project.instanceOrigin, userId: project.userId, projectId: project.id,
      projectCreatedAt: project.createdAt, adapterId: "codex", adapterVersion: "1.0.0", revision: 7,
      cursor: "opaque discovery progress", updatedAt: date, rawObjects: [] }
    client.record(state, checkpoint)
    expect((await client.run(inspectCLIExperience())).projects[0]?.state).toBe("waiting")
    const published = { ...checkpoint, canonicalPublished: true }
    client.record(state, published)
    expect((await client.run(inspectCLIExperience())).projects[0]?.state).toBe("up_to_date")
    client.record(state, { ...published, projectCreatedAt: "older-registration" })
    expect((await client.run(inspectCLIExperience())).projects[0]?.state).toBe("waiting")
    for (const wrongScope of [{ userId: "other-user" }, { instanceOrigin: "https://elsewhere.example" }, { projectId: "other-project" }, { adapterId: "disabled-adapter" }]) {
      client.record(state, { ...published, ...wrongScope })
      expect((await client.run(inspectCLIExperience())).projects[0]?.state).toBe("waiting")
    }
    client.record(state, { ...published, canonicalPublished: false })
    expect((await client.run(inspectCLIExperience())).projects[0]?.state).toBe("waiting")
    client.record({ version: 1, jobs: [{ ...job, lastFailureAt: date, failureReason: "transport", failureMessage: "Offline", retryable: true }] }, published)
    expect((await client.run(inspectCLIExperience())).projects[0]?.state).toBe("failed")
    client.record(state, published)
    await client.run(stopExperienceCollector())
    expect((await client.run(inspectCLIExperience())).projects[0]?.state).toBe("stopped")
  })
  it("allows an explicit empty source selection without removing the Project", async () => {
    const client = fixture()
    await client.run(applyToolChange(await client.run(planToolChange(["codex"]))))
    const plan = await client.run(prepareGuidedSetup(input))
    const project = await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress }))
    const changed = await client.run(applyToolChange(await client.run(planToolChange([]))))
    expect(changed.enabledAdapterIds).toEqual([])
    expect(client.config().projects).toHaveLength(1)
    expect((await client.run(inspectCLIExperience())).projects[0]?.state).toBe("no_sources")
  })
  it("distinguishes automatic retry, required repair and stopped sync without starting jobs on inspection", async () => {
    const client = fixture()
    await client.run(applyToolChange(await client.run(planToolChange(["codex"]))))
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
    await client.run(applyToolChange(await client.run(planToolChange(["codex"]))))
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

  it("distinguishes missing readers, incompatible output and ordinary read failures", async () => {
    const client = fixture()
    await client.run(applyToolChange(await client.run(planToolChange(["codex"]))))
    const plan = await client.run(prepareGuidedSetup(input))
    const project = await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress }))
    const job = { projectId: project.id, adapterId: "codex", lastAttemptAt: date, failureMessage: "Read failed", retryable: false }
    client.record({ version: 1, jobs: [{ ...job, failureReason: "adapter" }] })
    expect((await client.run(inspectCLIExperience())).projects[0]?.recovery.kind).toBe("repair")
    client.record({ version: 1, jobs: [{ ...job, failureReason: "adapter", retryable: true }] })
    expect((await client.run(inspectCLIExperience())).projects[0]?.recovery.kind).toBe("automatic_retry")
    client.record({ version: 1, jobs: [{ ...job, failureReason: "contract" }] })
    expect((await client.run(inspectCLIExperience())).projects[0]?.recovery).toEqual({ kind: "tool", adapterId: "codex", action: "update" })
    client.edit(config => ({ ...config, adapters: [] }))
    expect((await client.run(inspectCLIExperience())).projects[0]?.recovery).toEqual({ kind: "tool", adapterId: "codex", action: "install" })
    client.record({ version: 1, jobs: [{ ...job, failureReason: "unauthenticated" }] })
    expect((await client.run(inspectCLIExperience())).projects[0]?.recovery.kind).toBe("sign_in")
  })

  it("updates a reader directly without restarting running sync or claiming the recorded failure is resolved", async () => {
    const client = fixture()
    await client.run(applyToolChange(await client.run(planToolChange(["codex"]))))
    const plan = await client.run(prepareGuidedSetup(input))
    const project = await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress }))
    client.record({ version: 1, jobs: [{ projectId: project.id, adapterId: "codex", lastAttemptAt: date,
      failureReason: "contract", failureMessage: "Incompatible output", retryable: false }] })
    const registrations = structuredClone(client.config().projects)
    client.edit(config => ({ ...config, adapters: config.adapters.map(adapter => ({ ...adapter, upgradeSpec: "file:/old/codex" })) }))
    await client.run(updateSyncReader("codex", project))
    expect(client.packages).toEqual(["@atape/adapter-codex", "@atape/adapter-codex@latest"])
    expect(client.starts()).toBe(1)
    expect(client.config().enabledAdapterIds).toEqual(["codex"])
    expect(client.config().projects).toEqual(registrations)
    expect(client.config().adapters[0]?.upgradeSpec).toBe("@atape/adapter-codex@latest")
    expect((await client.run(inspectCLIExperience())).projects[0]?.state).toBe("failed")
    await client.run(stopExperienceCollector())
    client.edit(config => ({ ...config, adapters: [] }))
    await client.run(updateSyncReader("codex", project))
    expect(client.config().adapters[0]?.adapterId).toBe("codex")
    expect(client.starts()).toBe(2)
  })

  it("rejects stale or unauthorized reader recovery and leaves sync stopped on an installation failure", async () => {
    const client = fixture()
    await client.run(applyToolChange(await client.run(planToolChange(["codex"]))))
    const plan = await client.run(prepareGuidedSetup(input))
    const project = await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress }))
    await client.run(stopExperienceCollector())
    await expect(client.run(updateSyncReader("claude", project))).rejects.toMatchObject({ reason: "changed" })
    await expect(client.run(updateSyncReader("codex", { ...project, createdAt: "different" }))).rejects.toMatchObject({ reason: "changed" })
    client.failInstall(true)
    await expect(client.run(updateSyncReader("codex", project))).rejects.toThrow("offline")
    expect(client.starts()).toBe(1)
    client.changeUser()
    const attempts = client.packages.length
    await expect(client.run(updateSyncReader("codex", project))).rejects.toMatchObject({ reason: "changed" })
    expect(client.packages).toHaveLength(attempts)
    expect(client.starts()).toBe(1)
  })

  it("keeps partial coverage distinct from failures and clears recovery after a healthy cycle", async () => {
    const client = fixture()
    await client.run(applyToolChange(await client.run(planToolChange(["codex"]))))
    const plan = await client.run(prepareGuidedSetup(input))
    const project = await client.run(completeGuidedSetup({ plan, teamId: "team-1", sourceIds: ["codex"], progress }))
    const job = { projectId: project.id, adapterId: "codex", lastAttemptAt: date, lastSuccessAt: date, canonicalBatches: 1 }
    client.record({ version: 1, jobs: [{ ...job, sourceFailures: [{ source: "old-session", reason: "attribution" }] }] })
    expect((await client.run(inspectCLIExperience())).projects[0]?.recovery.kind).toBe("partial")
    client.record({ version: 1, jobs: [job] })
    expect((await client.run(inspectCLIExperience())).projects[0]).toMatchObject({ state: "up_to_date", recovery: { kind: "none" } })
  })

})
