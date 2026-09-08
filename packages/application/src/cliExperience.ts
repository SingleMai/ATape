import type { AdapterInstallation, ClientConfig, LocalProject } from "@atape/domain"
import { Clock, Context, Effect, Schema } from "effect"
import {
  ClientConfigStore, inspectClient, installAdapter, removeProject, upgradeAdapters
} from "./clientManagement.ts"
import {
  applyProjectSetup, planProjectSetup, ProjectSetupGateway,
  type ProjectSetupPlan, type ProjectSetupSelection
} from "./projectSetup.ts"
import { inspectManagedCollector, startManagedCollector, stopManagedCollector, type ManagedCollectorJobStatus, type ManagedCollectorStatus } from "./collectorDaemon.ts"
import { CollectorStateStore } from "./collector.ts"
import { CLIAuthenticationGateway } from "./cliAuthentication.ts"
import { normalizeInstanceTopology } from "@atape/domain"

export class CLIExperienceError extends Schema.TaggedError<CLIExperienceError>()("CLIExperienceError", {
  reason: Schema.Literals(["io", "changed", "selection", "upgrade", "unauthenticated"]),
  message: Schema.String,
  instanceOrigin: Schema.optionalKey(Schema.String)
}) {}

export const officialSources = [
  { id: "codex", label: "Codex", packageName: "@atape/adapter-codex" },
  { id: "claude", label: "Claude Code", packageName: "@atape/adapter-claude" }
] as const

export type DirectorySuggestion = {
  readonly path: string
  // A local .git entry is a browsing hint, not repository identity or authorization.
  readonly git: boolean
  readonly parent?: true
}

// Local filesystem/package inspection is a real Adapter Seam. It never reads
// conversation bodies. Creation keys survive interruption before local commit.
export class CLISetupPlatform extends Context.Service<CLISetupPlatform, {
  detectSources(): Effect.Effect<ReadonlyArray<string>, CLIExperienceError>
  suggestDirectories(input: string): Effect.Effect<ReadonlyArray<DirectorySuggestion>, CLIExperienceError>
  supportsGit(adapter: AdapterInstallation): Effect.Effect<boolean, CLIExperienceError>
  creationKey(scope: { readonly instanceOrigin: string; readonly userId: string; readonly teamId: string; readonly path: string; readonly name: string }): Effect.Effect<string, CLIExperienceError>
}>()("atape/application/CLISetupPlatform") {}

export type SourceChoice = {
  readonly id: string
  readonly label: string
  readonly detected: boolean
  readonly installed: boolean
  readonly selected: boolean
}
export type GuidedSetupPlan = {
  readonly project: ProjectSetupPlan
  readonly config: ClientConfig
  readonly detected: ReadonlyArray<string>
  readonly existingDirectory?: LocalProject
}
export const prepareGuidedSetup = Effect.fn("CLIExperience.prepare")(function*(input: {
  readonly instanceOrigin: string; readonly path: string
}) {
  const platform = yield* CLISetupPlatform
  const [project, config, detected] = yield* Effect.all([
    planProjectSetup(input), inspectClient(), platform.detectSources()
  ])
  const existingDirectory = config.projects.find(item => item.type === "directory" &&
    item.path === project.local.path && item.instanceOrigin === project.instanceOrigin && item.userId === project.user.id)
  const owner = config.projects.find(item => item.path === project.local.path)
  if (owner && !existingDirectory && !(owner.instanceOrigin === project.instanceOrigin && owner.userId === project.user.id &&
    project.exactMatches.some(match => match.project.id === owner.id))) {
    return yield* changed("This directory is already connected with a different Project or account. Remove its local capture before reconnecting.")
  }
  return { project, config, detected, ...(existingDirectory ? { existingDirectory } : {}) } satisfies GuidedSetupPlan
})

export const guidedSourceChoices = (plan: GuidedSetupPlan, teamId: string): ReadonlyArray<SourceChoice> => {
  const matchingId = plan.project.exactMatches.find(match => match.team.id === teamId)?.project.id
  const existing = plan.existingDirectory ?? plan.config.projects.find(item =>
    item.instanceOrigin === plan.project.instanceOrigin && item.id === matchingId && item.userId === plan.project.user.id)
  return sourceChoices(plan.config, plan.detected, existing)
}
const sourceChoices = (config: ClientConfig, detected: ReadonlyArray<string>, project?: LocalProject): ReadonlyArray<SourceChoice> => [
  ...officialSources.map(source => ({
    id: source.id, label: source.label, detected: detected.includes(source.id),
    installed: config.adapters.some(adapter => adapter.adapterId === source.id),
    selected: project ? project.adapterIds.includes(source.id) : detected.includes(source.id)
  })),
  ...config.adapters.filter(adapter => !officialSources.some(source => source.id === adapter.adapterId)).map(adapter => ({
    id: adapter.adapterId, label: adapter.displayName, detected: false, installed: true,
    selected: project?.adapterIds.includes(adapter.adapterId) ?? false
  }))
]
export type SetupProgress = "Installing selected sources" | "Connecting Project" | "Starting background sync" | "Waiting for first sync"

export const completeGuidedSetup = Effect.fn("CLIExperience.complete")(function*(input: {
  readonly plan: GuidedSetupPlan
  readonly teamId: string
  readonly name?: string
  readonly sourceIds: ReadonlyArray<string>
  readonly progress: (stage: SetupProgress) => Effect.Effect<void>
}) {
  const { plan } = input
  const sourceIds = yield* validateSources(input.sourceIds, guidedSourceChoices(plan, input.teamId))
  const gateway = yield* ProjectSetupGateway
  const workspace = yield* gateway.loadWorkspace(plan.project.instanceOrigin)
  if (workspace.user.id !== plan.project.user.id || !workspace.teams.some(team => team.id === input.teamId)) {
    return yield* changed("The account or Team changed. Review setup again.")
  }
  yield* input.progress("Installing selected sources")
  yield* ensureSources(sourceIds, plan.project.local.type === "git")
  yield* input.progress("Connecting Project")
  let project: LocalProject
  if (plan.existingDirectory) {
    if (plan.existingDirectory.teamId !== input.teamId) return yield* changed("This directory is already connected to another Team.")
    project = yield* currentProject(plan.existingDirectory)
    yield* verifyProjectAccount(project)
    project = yield* replaceSourceSelection(project, sourceIds)
  } else {
    const exact = plan.project.exactMatches.find(match => match.team.id === input.teamId)
    const platform = yield* CLISetupPlatform
    const name = input.name?.trim() || plan.project.local.name
    const selection: ProjectSetupSelection = exact
      ? { mode: "exact", teamId: input.teamId, projectId: exact.project.id, adapterIds: sourceIds }
      : { mode: "create", teamId: input.teamId, name, adapterIds: sourceIds,
          idempotencyKey: yield* platform.creationKey({
            instanceOrigin: plan.project.instanceOrigin, userId: plan.project.user.id,
            teamId: input.teamId, path: plan.project.local.path, name
          }) }
    project = (yield* applyProjectSetup(plan.project, selection)).project
    project = yield* replaceSourceSelection(project, sourceIds)
  }
  yield* input.progress("Starting background sync")
  yield* startExperienceCollector()
  yield* input.progress("Waiting for first sync")
  return project
})

const ensureSources = Effect.fn("CLIExperience.ensureSources")(function*(ids: ReadonlyArray<string>, git: boolean) {
  const platform = yield* CLISetupPlatform
  for (const id of ids) {
    const config = yield* inspectClient()
    let installed = config.adapters.find(adapter => adapter.adapterId === id)
    const official = officialSources.find(source => source.id === id)
    if (!installed) {
      if (!official) return yield* new CLIExperienceError({ reason: "selection", message: `Source ${id} is no longer installed.` })
      installed = (yield* installAdapter(official.packageName)).adapter
    }
    if (git && !(yield* platform.supportsGit(installed))) {
      if (!official || installed.packageName !== official.packageName) {
        return yield* new CLIExperienceError({ reason: "upgrade", message: `Upgrade ${installed.displayName} to support shared Git attribution, then retry.` })
      }
      installed = (yield* upgradeAdapters(id))[0]!
      if (!(yield* platform.supportsGit(installed))) {
        return yield* new CLIExperienceError({ reason: "upgrade", message: `The installed ${installed.displayName} package still lacks shared Git attribution. Install a compatible package and retry.` })
      }
    }
  }
})
const validateSources = (ids: ReadonlyArray<string>, choices: ReadonlyArray<SourceChoice>) => {
  const selected = [...new Set(ids)]
  return selected.length > 0 && selected.every(id => choices.some(choice => choice.id === id))
    ? Effect.succeed(selected)
    : Effect.fail(new CLIExperienceError({ reason: "selection", message: "Select at least one available source." }))
}

const currentProject = Effect.fn("CLIExperience.currentProject")(function*(expected: LocalProject) {
  const config = yield* inspectClient()
  const project = config.projects.find(item => item.instanceOrigin === expected.instanceOrigin && item.id === expected.id)
  if (!project || project.userId !== expected.userId || project.teamId !== expected.teamId || project.createdAt !== expected.createdAt) {
    return yield* changed("This Project's local registration changed. Refresh the Project list.")
  }
  return project
})
export const verifyProjectAccount = Effect.fn("CLIExperience.verifyAccount")(function*(project: LocalProject) {
  const gateway = yield* ProjectSetupGateway
  const workspace = yield* gateway.loadWorkspace(project.instanceOrigin).pipe(Effect.mapError(error =>
    error.reason === "unauthenticated"
      ? new CLIExperienceError({ reason: "unauthenticated", message: error.message, instanceOrigin: project.instanceOrigin })
      : error))
  if (workspace.user.id !== project.userId || !workspace.teams.some(team => team.id === project.teamId) ||
    !workspace.projects.some(item => item.id === project.id && item.teamId === project.teamId && item.state === "active")) {
    return yield* new CLIExperienceError({ reason: "changed", instanceOrigin: project.instanceOrigin,
      message: `Sign in to ${project.instanceOrigin} with the account that connected ${project.name} and ensure it still belongs to your Team.` })
  }
})
// Start is global. Verify every enabled registration before resuming after login.
export const startExperienceCollector = Effect.fn("CLIExperience.start")(function*() {
  const config = yield* inspectClient()
  for (const project of config.projects.filter(project => project.adapterIds.length > 0)) yield* verifyProjectAccount(project)
  return yield* startManagedCollector()
})
export const stopExperienceCollector = stopManagedCollector

export const inspectProjectSources = Effect.fn("CLIExperience.sources")(function*(expected: LocalProject) {
  const project = yield* currentProject(expected)
  const platform = yield* CLISetupPlatform
  return sourceChoices(yield* inspectClient(), yield* platform.detectSources(), project)
})
export const changeProjectSources = Effect.fn("CLIExperience.changeSources")(function*(expected: LocalProject, sourceIds: ReadonlyArray<string>) {
  const project = yield* currentProject(expected)
  yield* verifyProjectAccount(project)
  const ids = [...new Set(sourceIds)]
  const choices = yield* inspectProjectSources(project)
  if (ids.some(id => !choices.some(choice => choice.id === id))) return yield* changed("The available sources changed. Review the selection again.")
  yield* ensureSources(ids, project.type === "git")
  return yield* replaceSourceSelection(project, ids)
})
const replaceSourceSelection = Effect.fn("CLIExperience.replaceSources")(function*(project: LocalProject, ids: ReadonlyArray<string>) {
  const store = yield* ClientConfigStore
  return yield* store.transact((config) => Effect.gen(function*() {
    const current = config.projects.find(item => item.instanceOrigin === project.instanceOrigin && item.id === project.id)
    if (!current || current.userId !== project.userId || current.createdAt !== project.createdAt ||
      JSON.stringify(current.adapterIds) !== JSON.stringify(project.adapterIds) ||
      ids.some(id => !config.adapters.some(adapter => adapter.adapterId === id))) {
      return yield* changed("The Project's sources changed during this operation. Refresh and review them again.")
    }
    const updated = { ...current, adapterIds: [...ids].sort() }
    return { value: updated, config: { ...config, projects: config.projects.map(item => item === current ? updated : item) } }
  }))
})
export const removeExperienceProject = Effect.fn("CLIExperience.remove")(function*(project: LocalProject) {
  yield* currentProject(project)
  yield* removeProject(project.id)
})

export type ProjectSyncState = "no_sources" | "stopped" | "waiting" | "syncing" | "queued" | "up_to_date" | "partial" | "failed"
// Describes the existing Collector recovery behavior; presentation must not
// infer a retry schedule or restart collection merely to refresh its status.
export type ProjectRecovery =
  | { readonly kind: "sources" | "sign_in" | "resume" | "automatic_retry" | "repair" | "partial" | "none" }
  | { readonly kind: "sign_in_elsewhere"; readonly project: LocalProject }
export type ConsoleProject = {
  readonly project: LocalProject
  readonly state: ProjectSyncState
  readonly recovery: ProjectRecovery
  readonly jobs: ReadonlyArray<ManagedCollectorJobStatus>
}
export const inspectCLIExperience = Effect.fn("CLIExperience.inspect")(function*() {
  const [config, collector] = yield* Effect.all([inspectClient(), inspectManagedCollector()])
  const store = yield* CollectorStateStore
  const projects: Array<ConsoleProject> = []
  for (const project of config.projects) {
    const jobs = collector.jobs.filter(job => job.projectId === project.id)
    let captured = false
    for (const adapterId of project.adapterIds) {
      const snapshot = yield* store.snapshot(project.instanceOrigin, project.userId, project.id, adapterId)
      if (snapshot.checkpoint?.projectCreatedAt === project.createdAt && snapshot.checkpoint.rawObjects.length > 0) captured = true
    }
    const state: ProjectSyncState = project.adapterIds.length === 0 ? "no_sources"
      : jobs.some(job => job.state === "failed") ? "failed"
      : !collector.running ? "stopped"
      : jobs.some(job => job.state === "partial") ? "partial"
      : jobs.some(job => job.hasMore) ? "queued"
      : jobs.some(job => job.state === "pending") ? "syncing"
      : captured || jobs.some(job => (job.canonicalBatches ?? 0) > 0) ? "up_to_date" : "waiting"
    projects.push({ project, state, jobs, recovery: projectRecovery(project, jobs, collector, config.projects) })
  }
  return { projects, collector, activeInstanceOrigin: config.activeInstanceOrigin }
})
const projectRecovery = (project: LocalProject, jobs: ReadonlyArray<ManagedCollectorJobStatus>, collector: ManagedCollectorStatus, projects: ReadonlyArray<LocalProject>): ProjectRecovery => {
  if (project.adapterIds.length === 0) return { kind: "sources" }
  if (jobs.some(job => job.failureReason === "unauthenticated")) return { kind: "sign_in" }
  // One expired credential stops the global Collector, including healthy jobs.
  const blockedBy = projects.find(candidate => collector.jobs.some(job => job.projectId === candidate.id && job.failureReason === "unauthenticated"))
  if (blockedBy) return { kind: "sign_in_elsewhere", project: blockedBy }
  const failures = jobs.filter(job => job.state === "failed")
  if (collector.collectorFailure || failures.some(job => job.retryable !== true)) return { kind: "repair" }
  if (!collector.running) return { kind: "resume" }
  if (failures.length > 0) return { kind: "automatic_retry" }
  if (jobs.some(job => job.state === "partial")) return { kind: "partial" }
  return { kind: "none" }
}
export type CLIExperienceSnapshot = Effect.Success<ReturnType<typeof inspectCLIExperience>>

export const observeInitialSync = Effect.fn("CLIExperience.firstSync")(function*(project: LocalProject) {
  const deadline = (yield* Clock.currentTimeMillis) + 15_000
  while (true) {
    const snapshot = yield* inspectCLIExperience()
    const result = snapshot.projects.find(item => item.project.instanceOrigin === project.instanceOrigin && item.project.id === project.id)
    if (!result || result.state !== "syncing" || (yield* Clock.currentTimeMillis) >= deadline) return snapshot
    yield* Effect.sleep(1_000)
  }
})
const changed = (message: string) => new CLIExperienceError({ reason: "changed", message })

export const experienceWebURL = Effect.fn("CLIExperience.webURL")(function*(
  instanceOrigin: string, project?: LocalProject, allowLoopbackHttp = false
) {
  const gateway = yield* CLIAuthenticationGateway
  const topology = normalizeInstanceTopology(yield* gateway.discover(instanceOrigin), { allowLoopbackHttp })
  if (!topology || topology.instanceOrigin !== instanceOrigin) return yield* changed("The Instance returned a different Web destination. Check its public origins.")
  const route = project
    ? `/teams/${encodeURIComponent(project.teamId)}/projects/${encodeURIComponent(project.id)}`
    : "/onboarding"
  return new URL(route, topology.webOrigin).href
})
