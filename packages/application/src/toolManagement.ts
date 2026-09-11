import type { ClientConfig, LocalProject } from "@atape/domain"
import { Effect } from "effect"
import { ClientConfigStore, effectiveClientConfig, inspectClient, installAdapter, upgradeAdapters } from "./clientManagement.ts"
import { CLIExperienceError, CLISetupPlatform } from "./cliSetupPlatform.ts"
import { currentProject, verifyProjectAccount, startExperienceCollector } from "./projectAccess.ts"
import { inspectManagedCollector } from "./collectorDaemon.ts"
import { officialSources } from "@atape/adapter-catalog"

export type SourceChoice = {
  readonly id: string
  readonly label: string
  readonly detected: boolean
  readonly installed: boolean
  readonly selected: boolean
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
export const sourceChoices = (config: ClientConfig, detected: ReadonlyArray<string>): ReadonlyArray<SourceChoice> => [
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
export const validateSources = (ids: ReadonlyArray<string>, choices: ReadonlyArray<SourceChoice>) => {
  const selected = [...new Set(ids)]
  return selected.length > 0 && selected.every(id => choices.some(choice => choice.id === id))
    ? Effect.succeed(selected)
    : Effect.fail(new CLIExperienceError({ reason: "selection", message: "Select at least one available source." }))
}

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

const changed = (message: string) => new CLIExperienceError({ reason: "changed", message })
