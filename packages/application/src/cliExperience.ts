import type { LocalProject } from "@atape/domain"
import { normalizeInstanceTopology } from "@atape/domain"
import { Clock, Effect } from "effect"
import { type ClientSnapshot, inspectClient, removeProject } from "./clientManagement.ts"
import { applyProjectSetup, planProjectSetup, decideProjectSetup, ProjectSetupGateway,
  type ProjectSetupPlan, type ProjectSetupSelection } from "./projectSetup.ts"
import { inspectManagedCollector, type ManagedCollectorJobStatus, type ManagedCollectorStatus } from "./collectorDaemon.ts"
import { CollectorStateStore } from "./collectorContracts.ts"
import { CLIAuthenticationGateway } from "./cliAuthentication.ts"
import { officialSources } from "@atape/adapter-catalog"
import { CLIExperienceError, CLISetupPlatform } from "./cliSetupPlatform.ts"
import { currentProject, verifyProjectAccount, startExperienceCollector } from "./projectAccess.ts"
import { sourceChoices, validateSources } from "./toolManagement.ts"

export { officialSources } from "@atape/adapter-catalog"
export { CLIExperienceError, CLISetupPlatform, type DirectorySuggestion } from "./cliSetupPlatform.ts"
export { inspectTools, planToolChange, applyToolChange, updateSyncReader, type ToolChangePlan, type SourceChoice } from "./toolManagement.ts"
export { verifyProjectAccount, startExperienceCollector, stopExperienceCollector } from "./projectAccess.ts"

export type GuidedSetupPlan = {
  readonly project: ProjectSetupPlan
  readonly config: ClientSnapshot
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
    const platform = yield* CLISetupPlatform
    const name = input.name?.trim() || plan.project.local.name
    const decision = decideProjectSetup(plan.project, { team: input.teamId, creationApproved: true, name })
    if (decision.kind !== "ready") return yield* changed("The Project selection changed. Review setup again.")
    const selection: ProjectSetupSelection = { ...decision.selection, expectedToolIds: sourceIds,
      ...(decision.selection.mode === "create" ? { idempotencyKey: yield* platform.creationKey({
        instanceOrigin: plan.project.instanceOrigin, userId: plan.project.user.id,
        teamId: input.teamId, path: plan.project.local.path, name
      }) } : {}) }
    project = (yield* applyProjectSetup(plan.project, selection)).project
  }
  yield* input.progress("Starting background sync")
  yield* startExperienceCollector()
  yield* input.progress("Waiting for first sync")
  return project
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
  const capturedScopes = new Set((config.projects.some(project => project.adapterIds.length > 0)
    ? yield* store.capturedScopes() : []).map(scope => JSON.stringify([
    scope.instanceOrigin, scope.userId, scope.projectId, scope.projectCreatedAt, scope.adapterId
  ])))
  const projects: Array<ConsoleProject> = []
  for (const project of config.projects) {
    const jobs = collector.jobs.filter(job => job.projectId === project.id)
    const captured = project.adapterIds.some(adapterId => capturedScopes.has(JSON.stringify([
      project.instanceOrigin, project.userId, project.id, project.createdAt, adapterId
    ])))
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
