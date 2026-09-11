import type { AdapterInstallation, ClientConfig, LocalProject } from "@atape/domain"
import { Clock, Context, Effect, Schema } from "effect"
import {
  ClientConfigStore, effectiveClientConfig, type ClientSnapshot, inspectClient, installAdapter, removeProject, upgradeAdapters
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
  instanceOrigin: Schema.optionalKey(Schema.String),
  adapterId: Schema.optionalKey(Schema.String)
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
  suggestDirectories(input: string, query?: string): Effect.Effect<ReadonlyArray<DirectorySuggestion>, CLIExperienceError>
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
  readonly config: ClientSnapshot
  readonly detected: ReadonlyArray<string>
  readonly existingDirectory?: LocalProject
}

export const inspectTools = Effect.fn("CLIExperience.tools")(function*() {
  const config = yield* inspectClient()
  const detected = yield* (yield* CLISetupPlatform).detectSources()
  const selected = config.toolsConfigured ? config.enabledAdapterIds : detected
  return { configured: config.toolsConfigured,
    choices: sourceChoices(config, detected).map(choice => ({ ...choice, selected: selected.includes(choice.id),
      version: config.adapters.find(adapter => adapter.adapterId === choice.id)?.version })), config }
})
const toolScope = (config: ClientConfig) => JSON.stringify({ version: config.version,
  configured: config.toolsConfigured, enabled: config.enabledAdapterIds, projects: effectiveClientConfig(config).projects })
export const planToolChange = Effect.fn("CLIExperience.planTools")(function*(sourceIds: ReadonlyArray<string>) {
  const { config, choices } = yield* inspectTools()
  const ids = [...new Set(sourceIds)].sort()
  if (ids.some(id => !choices.some(choice => choice.id === id))) return yield* changed("The available tools changed. Review your selection again.")
  return { ids, scope: toolScope(config), projects: config.projects.map(project => ({
    project, added: ids.filter(id => !project.adapterIds.includes(id)), removed: project.adapterIds.filter(id => !ids.includes(id))
  })) }
})
export type ToolChangePlan = Effect.Success<ReturnType<typeof planToolChange>>
export const applyToolChange = Effect.fn("CLIExperience.applyTools")(function*(plan: ToolChangePlan) {
  const config = yield* inspectClient()
  if (toolScope(config) !== plan.scope) return yield* changed("Projects or tools changed. Review the impact again.")
  const ids = [...new Set(plan.ids)].sort()
  for (const project of config.projects.filter(project => ids.some(id => !project.adapterIds.includes(id)))) {
    yield* verifyProjectAccount(project)
  }
  yield* ensureSources(ids, config.projects.some(project => project.type === "git"))
  const store = yield* ClientConfigStore
  const saved = yield* store.transact(current => Effect.gen(function*() {
    if (toolScope(current) !== plan.scope || ids.some(id => !current.adapters.some(adapter => adapter.adapterId === id))) {
      return yield* changed("Projects or tools changed during installation. Review the impact again.")
    }
    const next: ClientConfig = { ...current, toolsConfigured: true, enabledAdapterIds: ids }
    return { value: next, config: next }
  }))
  return saved
})
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

const sourceChoices = (config: ClientConfig, detected: ReadonlyArray<string>): ReadonlyArray<SourceChoice> => [
  ...officialSources.map(source => ({
    id: source.id, label: source.label, detected: detected.includes(source.id),
    installed: config.adapters.some(adapter => adapter.adapterId === source.id),
    selected: config.toolsConfigured ? config.enabledAdapterIds.includes(source.id) : detected.includes(source.id)
  })),
  ...config.adapters.filter(adapter => !officialSources.some(source => source.id === adapter.adapterId)).map(adapter => ({
    id: adapter.adapterId, label: adapter.displayName, detected: false, installed: true,
    selected: config.enabledAdapterIds.includes(adapter.adapterId)
  }))
]
export type SetupProgress = "Connecting Project" | "Starting background sync" | "Waiting for first sync"

export const completeGuidedSetup = Effect.fn("CLIExperience.complete")(function*(input: {
  readonly plan: GuidedSetupPlan
  readonly teamId: string
  readonly name?: string
  readonly sourceIds: ReadonlyArray<string>
  readonly progress: (stage: SetupProgress) => Effect.Effect<void>
}) {
  const { plan } = input
  const sourceIds = yield* validateSources(input.sourceIds, sourceChoices(plan.config, plan.detected))
  const currentConfig = yield* inspectClient()
  if (JSON.stringify([...currentConfig.enabledAdapterIds].sort()) !== JSON.stringify([...sourceIds].sort())) {
    return yield* changed("Global tools changed. Review the Project again.")
  }
  const gateway = yield* ProjectSetupGateway
  const workspace = yield* gateway.loadWorkspace(plan.project.instanceOrigin)
  if (workspace.user.id !== plan.project.user.id || !workspace.teams.some(team => team.id === input.teamId)) {
    return yield* changed("The account or Team changed. Review setup again.")
  }
  {
    const platform = yield* CLISetupPlatform
    for (const id of sourceIds) {
      const installed = currentConfig.adapters.find(adapter => adapter.adapterId === id)
      if (!installed || plan.project.local.type === "git" && !(yield* platform.supportsGit(installed))) {
        return yield* new CLIExperienceError({ reason: "upgrade", adapterId: id,
          message: `ATape needs an updated ${officialSources.find(source => source.id === id)?.label ?? id} reader before this project can connect.` })
      }
    }
  }
  yield* input.progress("Connecting Project")
  let project: LocalProject
  if (plan.existingDirectory) {
    if (plan.existingDirectory.teamId !== input.teamId) return yield* changed("This directory is already connected to another Team.")
    project = yield* currentProject(plan.existingDirectory)
    yield* verifyProjectAccount(project)
  } else {
    const exact = plan.project.exactMatches.find(match => match.team.id === input.teamId)
    const platform = yield* CLISetupPlatform
    const name = input.name?.trim() || plan.project.local.name
    const selection: ProjectSetupSelection = exact
      ? { mode: "exact", teamId: input.teamId, projectId: exact.project.id, expectedToolIds: sourceIds }
      : { mode: "create", teamId: input.teamId, name, expectedToolIds: sourceIds,
          idempotencyKey: yield* platform.creationKey({
            instanceOrigin: plan.project.instanceOrigin, userId: plan.project.user.id,
            teamId: input.teamId, path: plan.project.local.path, name
          }) }
    project = (yield* applyProjectSetup(plan.project, selection)).project
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
      installed = (yield* installAdapter(`${official.packageName}@latest`, { installation: installed })).adapter
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

// Package maintenance is global; keep selection and capture checkpoints intact.
// A running Collector loads the replacement on a later cycle, without a restart.
export const updateSyncReader = Effect.fn("CLIExperience.updateSyncReader")(function*(id: string, project?: LocalProject) {
  const config = yield* inspectClient()
  if (!config.enabledAdapterIds.includes(id)) return yield* changed("The selected tools changed. Review your selection again.")
  if (project) yield* currentProject(project)
  for (const connected of config.projects.filter(item => item.adapterIds.length > 0)) yield* verifyProjectAccount(connected)
  const installed = config.adapters.find(adapter => adapter.adapterId === id)
  const source = officialSources.find(source => source.id === id)
  if (installed && source?.packageName === installed.packageName) {
    yield* installAdapter(`${source.packageName}@latest`, { installation: installed })
  }
  else if (installed) yield* upgradeAdapters(id)
  else {
    if (!source) return yield* new CLIExperienceError({ reason: "selection", message: `The ${id} reader is no longer available. Choose another tool to sync.` })
    yield* installAdapter(source.packageName)
  }
  const current = yield* inspectClient()
  if (toolScope(current) !== toolScope(config)) return yield* changed("Projects or tools changed during the update. Review the project again.")
  if (project) {
    yield* currentProject(project)
    if (!(yield* inspectManagedCollector()).running) yield* startExperienceCollector()
  }
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
  | { readonly kind: "tool"; readonly adapterId: string; readonly action: "install" | "update" }
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
      if (snapshot.checkpoint?.projectCreatedAt === project.createdAt &&
        (snapshot.checkpoint.canonicalPublished === true || snapshot.checkpoint.rawObjects.length > 0)) captured = true
    }
    const state: ProjectSyncState = project.adapterIds.length === 0 ? "no_sources"
      : jobs.some(job => job.state === "failed") ? "failed"
      : !collector.running ? "stopped"
      : jobs.some(job => job.state === "partial") ? "partial"
      : jobs.some(job => job.hasMore) ? "queued"
      : jobs.some(job => job.state === "pending") ? "syncing"
      : captured || jobs.some(job => (job.canonicalBatches ?? 0) > 0) ? "up_to_date" : "waiting"
    const missing = project.adapterIds.find(id => !config.adapters.some(adapter => adapter.adapterId === id))
    const broken = jobs.find(job => job.state === "failed" && job.failureReason === "contract" && job.retryable !== true)
    const recovery = projectRecovery(project, jobs, collector, config.projects)
    projects.push({ project, state: missing ? "failed" : state, jobs,
      recovery: recovery.kind === "sign_in" || recovery.kind === "sign_in_elsewhere" ? recovery
        : missing ? { kind: "tool", adapterId: missing, action: "install" }
        : broken ? { kind: "tool", adapterId: broken.adapterId, action: "update" } : recovery })
  }
  return { projects, collector, activeInstanceOrigin: config.activeInstanceOrigin,
    toolsConfigured: config.toolsConfigured, enabledTools: config.enabledAdapterIds,
    needsAttention: projects.filter(item => ["sign_in", "sign_in_elsewhere", "repair", "partial", "tool"].includes(item.recovery.kind)).length }
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

export const experienceOnboardingURL = Effect.fn("CLIExperience.onboardingURL")(function*(
  instanceOrigin: string, allowLoopbackHttp = false
) {
  const gateway = yield* CLIAuthenticationGateway
  const topology = normalizeInstanceTopology(yield* gateway.discover(instanceOrigin), { allowLoopbackHttp })
  if (!topology || topology.instanceOrigin !== instanceOrigin) return yield* changed("The Instance returned a different Web destination. Check its public origins.")
  return new URL("/onboarding", topology.webOrigin).href
})
