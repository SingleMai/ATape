import {
  applyProjectSetup,
  decideProjectSetup,
  setClientLocale,
  inspectClient,
  inspectManagedCollector,
  installAdapter,
  pruneAdapterPackages,
  loginCLI,
  logoutCLI,
  planProjectSetup,
  removeProject,
  runCollector,
  runManagedCollector,
  setActiveInstance,
  selectInstanceOrigin,
  startManagedCollector,
  stopManagedCollector,
  upgradeAdapters,
  upgradeCLI,
  inspectTools, planToolChange, applyToolChange,
  type ClientSnapshot,
  type AdapterPruneSlot,
  type CollectionCycleReport,
  type ManagedCollectorStatus,
  type ProjectSetupPlan,
  type ProjectSetupSelection,
  type ProjectSetupIntent
} from "@atape/application"
import { SUPPORTED_LOCALES, isLocale } from "@atape/i18n"
import { createInterface } from "node:readline/promises"
import { Effect } from "effect"
import { cliVersion } from "./version.ts"
import { supportsInteractiveExperience } from "./interactiveEligibility.ts"
import { currentCliLocale, t } from "./i18n/index.ts"

import { CLIInputError, type ParsedCLI, type CommandOptions } from "./commandInput.ts"
export { CLIInputError, parseCLI, type ParsedCLI } from "./commandInput.ts"

export const runCommand = Effect.fn("CLI.command")(function*(cli: ParsedCLI) {
  switch (cli.kind) {
    case "interactive":
    case "help": return yield* print(helpText())
    case "version": return yield* print(`ATape ${cliVersion}`)
    case "upgrade":
      return yield* (cli.options.json ? Effect.void : print(t("cli.upgrade.checking", "Checking for an ATape update…"))).pipe(
        Effect.andThen(upgradeCLI(cliVersion)), Effect.flatMap(result => cli.options.json ? printJSON(result) : print(
          result.updated ? result.resumed
            ? t("cli.upgrade.updatedResumed", "Updated ATape to {version}. Background sync resumed.", { version: result.version })
            : t("cli.upgrade.updated", "Updated ATape to {version}.", { version: result.version })
            : t("cli.upgrade.upToDate", "ATape {version} is up to date.", { version: result.version }))))
    case "login": return yield* loginCommand(cli.options)
    case "logout": return yield* logoutCommand(cli.options)
    case "setup": return yield* setupCommand(cli.directory, cli.options)
    case "projects.list": return yield* listProjects(cli.options.json === true)
    case "projects.remove": return yield* removeProjectCommand(cli.projectId, cli.options.json === true)
    case "adapters.list": return yield* listAdapters(cli.options.json === true)
    case "adapters.install": return yield* installAdapterCommand(cli.packageSpec, cli.options.json === true)
    case "adapters.upgrade": return yield* upgradeAdaptersCommand(cli.target, cli.options.json === true)
    case "adapters.prune": return yield* pruneAdaptersCommand(cli.options)
    case "tools.list":
      return yield* inspectTools().pipe(Effect.flatMap(result => cli.options.json ? printJSON({ configured: result.configured,
        tools: result.choices, projectCount: result.config.projects.length }) : print(
        result.choices.map(choice => `${choice.label}: ${result.configured && choice.selected
          ? t("cli.tools.enabled", "enabled") : t("cli.tools.notEnabled", "not enabled")}${choice.installed ? t("cli.tools.ready", " · ready") : ""}`).join("\n"))))
    case "tools.configure":
      return yield* planToolChange(cli.adapterIds).pipe(Effect.flatMap(plan => {
        if (cli.options.apply) {
          return applyToolChange(plan).pipe(Effect.flatMap(config => cli.options.json
            ? printJSON(config) : print(t("cli.tools.saved", "Global tools saved for all connected projects."))))
        }
        if (cli.options.json) return printJSON(plan)
        const tools = plan.ids.length === 0 ? t("cli.common.none", "none") : plan.ids.join(", ")
        return print([
          t("cli.tools.previewSummary", "Tools: {tools} · {projects} projects", { tools, projects: plan.projects.length }),
          ...plan.projects.map(change => t("cli.tools.previewProject", "{name} ({instance}): +[{added}] -[{removed}]", {
            name: change.project.name, instance: change.project.instanceOrigin,
            added: change.added.join(", "), removed: change.removed.join(", ")
          })),
          t("cli.tools.previewNotice", "Added tools import existing history. Disabled tools retain captured history. Add --apply to confirm.")
        ].join("\n"))
      }))
    case "collect": return yield* collectCommand(cli.options)
    case "start": return yield* startCommand(cli.options)
    case "stop": return yield* stopCommand(cli.options.json === true)
    case "status": return yield* statusCommand(cli.options.json === true)
    case "language": return yield* languageCommand(cli.locale, cli.options)
    case "__collector-daemon": return yield* daemonCommand(cli.options)
  }
})

const languageCommand = (locale: string | undefined, options: CommandOptions<"language">) => Effect.gen(function*() {
  if (locale === undefined) {
    const current = currentCliLocale()
    if (options.json) return yield* printJSON({ locale: current })
    return yield* print(t("cli.language.current", "Current language: {locale}", { locale: current }))
  }
  if (!isLocale(locale)) {
    return yield* failUsage(t("cli.language.unsupported", "Unsupported language: {locale}. Supported: {locales}.",
      { locale, locales: SUPPORTED_LOCALES.join(", ") }))
  }
  yield* setClientLocale(locale)
  if (options.json) return yield* printJSON({ locale })
  return yield* print(t("cli.language.set", "Language set to {locale}. It applies to the next ATape command.", { locale }))
})

const setupCommand = (path: string | undefined, options: CommandOptions<"setup">) => Effect.gen(function*() {
  const instanceOrigin = yield* resolveInstance(options, yield* inspectClient())
  const type = yield* setupType(options.type)
  const plan = yield* planProjectSetup({
    instanceOrigin,
    path: path ?? process.cwd(),
    ...(type === undefined ? {} : { type })
  })
  const selection = yield* resolveProjectSetupSelection(plan, options)
  const result = yield* applyProjectSetup(plan, selection)
  if (options.json) {
    yield* printJSON(result)
    return
  }
  const adapters = result.project.adapterIds.length === 0
    ? t("cli.setup.noneYet", "none yet") : result.project.adapterIds.join(", ")
  yield* print([
    result.createdLocally ? t("cli.setup.createdLocally", "Configured local capture Project.") : result.updatedLocally
      ? t("cli.setup.updatedLocally", "Updated the existing Project locator and selected sources; capture progress was retained.")
      : t("cli.setup.unchanged", "Project was already configured; nothing changed."),
    `  ${result.project.id} · ${result.project.type}`,
    `  ${result.project.path}`,
    `  ${t("cli.setup.team", "Team: {name} ({slug})", { name: result.project.teamName, slug: result.project.teamSlug })}`,
    `  ${t("cli.setup.instance", "Instance: {origin}", { origin: result.project.instanceOrigin })}`,
    result.createdRemotely
      ? `  ${t("cli.setup.createdRemotely", "Created the matching server Project.")}`
      : `  ${t("cli.setup.attachedRemotely", "Attached the existing server Project.")}`,
    `  ${t("cli.setup.adapters", "Adapters: {adapters}", { adapters })}`
  ].join("\n"))
})

const loginCommand = (options: CommandOptions<"login">) => Effect.gen(function*() {
  const current = yield* inspectClient()
  const instanceOrigin = yield* resolveInstance(options, current)
  const result = yield* loginCLI({
    instanceOrigin,
    allowLoopbackHttp: developmentHTTPEnabled(),
    openBrowser: options.noBrowser !== true
  })
  yield* setActiveInstance(instanceOrigin)
  if (options.json) {
    yield* printJSON(result)
    return
  }
  yield* print([
    t("cli.login.signedIn", "Signed in to {origin} as {name}.", { origin: result.instanceOrigin, name: result.user.displayName }),
    t("cli.login.credential", "Credential: {id}", { id: result.credentialId }),
    ...result.warnings.map((warning) => t("cli.common.warning", "Warning: {message}", { message: warning }))
  ].join("\n"))
})

const logoutCommand = (options: CommandOptions<"logout">) => Effect.gen(function*() {
  const current = yield* inspectClient()
  const instanceOrigin = yield* resolveInstance(options, current)
  const result = yield* logoutCLI({
    instanceOrigin,
    allowLoopbackHttp: developmentHTTPEnabled()
  })
  if (options.json) {
    yield* printJSON(result)
    return
  }
  yield* print([
    result.signedOut
      ? t("cli.logout.signedOut", "Signed out from {origin}; the local credential was removed.", { origin: instanceOrigin })
      : t("cli.logout.noCredential", "No local credential exists for {origin}.", { origin: instanceOrigin }),
    ...result.warnings.map((warning) => t("cli.common.warning", "Warning: {message}", { message: warning }))
  ].join("\n"))
})

const resolveInstance = (options: { readonly instance?: string }, config: ClientSnapshot) => selectInstanceOrigin({
  ...(options.instance === undefined ? {} : { commandLine: options.instance }),
  ...(process.env.ATAPE_INSTANCE_URL === undefined ? {} : { environment: process.env.ATAPE_INSTANCE_URL }),
  ...(config.activeInstanceOrigin === undefined ? {} : { savedActive: config.activeInstanceOrigin }),
  allowLoopbackHttp: developmentHTTPEnabled()
})

const developmentHTTPEnabled = () => process.env.ATAPE_DEVELOPMENT_ALLOW_HTTP === "true"

const setupType = (
  value: string | undefined
): Effect.Effect<"auto" | "git" | "directory" | undefined, CLIInputError> => {
  if (value === undefined) return Effect.succeed(undefined)
  return value === "auto" || value === "git" || value === "directory"
    ? Effect.succeed(value)
    : Effect.fail(new CLIInputError(t("cli.error.invalidType", "--type must be auto, git, or directory.")))
}

const resolveProjectSetupSelection = (
  plan: ProjectSetupPlan,
  options: CommandOptions<"setup">
): Effect.Effect<ProjectSetupSelection, CLIInputError> => Effect.tryPromise({
  try: async () => {
    const interactive = supportsInteractiveExperience() && options.json !== true
    let intent: ProjectSetupIntent = {
      ...(options.team === undefined ? {} : { team: options.team }),
      ...(options.create === true ? { mode: "create" as const } : {}),
      ...(options.name === undefined ? {} : { name: options.name })
    }
    while (true) {
      const decision = decideProjectSetup(plan, intent)
      switch (decision.kind) {
        case "ready": return decision.selection
        case "invalid":
          switch (decision.reason) {
            case "team_unavailable": throw new CLIInputError(t("cli.setup.teamUnavailable", "Team {team} is not available to the signed-in account.", { team: intent.team ?? "" }))
            case "no_team": throw new CLIInputError(t("cli.setup.noTeam", "No Team is available to the signed-in account."))
            case "exact_match_exists": throw new CLIInputError(t("cli.setup.exactMatchCreateConflict", "This repository already has an exact Project match; omit --create to attach it."))
          }
        case "needs_team": {
          if (!interactive) throw new CLIInputError(t("cli.setup.teamRequired", "--team <slug> is required when more than one Team is available."))
          const prompt = createInterface({ input: process.stdin, output: process.stdout })
          try {
            process.stdout.write([t("cli.setup.chooseTeam", "Choose a Team:"), ...decision.teams.map(team =>
              `  ${team.slug} · ${team.displayName}`)].join("\n") + "\n")
            intent = { ...intent, team: await ask(prompt, t("cli.setup.teamSlugPrompt", "Team slug")) }
          } finally { prompt.close() }
          break
        }
        case "needs_creation_confirmation": {
          if (!interactive) throw new CLIInputError(t("cli.setup.createRequired", "No exact Project match exists; pass --create to create one explicitly."))
          const prompt = createInterface({ input: process.stdin, output: process.stdout })
          try {
            const approved = await confirm(prompt, t("cli.setup.confirmCreate", "Create a Project in {team}?", { team: decision.team.displayName }))
            if (!approved) throw new CLIInputError(t("cli.setup.cancelled", "Setup cancelled before creating a server Project."))
            intent = { ...intent, team: decision.team.id, creationApproved: true }
          } finally { prompt.close() }
          break
        }
      }
    }
  },
  catch: (cause) => cause instanceof CLIInputError
    ? cause
    : new CLIInputError(cause instanceof Error ? cause.message : String(cause))
})

const listProjects = (json: boolean) => inspectClient().pipe(
  Effect.flatMap((config) => json
    ? printJSON({ activeInstanceOrigin: config.activeInstanceOrigin, projects: config.projects })
    : printProjects(config))
)

const printProjects = (config: ClientSnapshot) => {
  if (config.projects.length === 0) return print(t("cli.projects.empty", "No local capture Projects. Run `atape setup`."))
  return print([
    config.activeInstanceOrigin
      ? t("cli.projects.headerActive", "Local capture Projects · active {origin}", { origin: config.activeInstanceOrigin })
      : t("cli.projects.header", "Local capture Projects"),
    ...config.projects.map((project) => {
      const adapters = project.adapterIds.length === 0 ? t("cli.common.none", "none") : project.adapterIds.join(", ")
      return [
        `- ${project.id} · ${project.type} · ${project.teamName}`,
        `  ${project.path} · ${project.instanceOrigin}`,
        `  ${t("cli.projects.adapters", "Adapters: {adapters}", { adapters })}`
      ].join("\n")
    })
  ].join("\n"))
}

const removeProjectCommand = (projectId: string, json: boolean) => removeProject(projectId).pipe(
  Effect.flatMap(() => json
    ? printJSON({ projectId, removedLocally: true, serverHistoryDeleted: false })
    : print(t("cli.projects.removed", "Removed local Project {projectId}. Captured ATape server history was not deleted.", { projectId })))
)

const installAdapterCommand = (packageSpec: string, json: boolean) =>
  installAdapter(packageSpec).pipe(Effect.flatMap((result) => json
        ? printJSON(result)
        : print([
          result.created
            ? t("cli.adapters.installed", "Installed {name} ({id}) v{version}.", { name: result.adapter.displayName, id: result.adapter.adapterId, version: result.adapter.version })
            : t("cli.adapters.updated", "Updated {name} ({id}) v{version}.", { name: result.adapter.displayName, id: result.adapter.adapterId, version: result.adapter.version }),
          t("cli.adapters.installNotice", "No sync was enabled. Open Tools to configure it for your projects.")
        ].join("\n"))))

const upgradeAdaptersCommand = (target: string, json: boolean) =>
  upgradeAdapters(target).pipe(Effect.flatMap((adapters) => json
        ? printJSON({ adapters })
        : print(adapters.length === 0
          ? t("cli.adapters.noneInstalled", "No Adapters are installed.")
          : [t("cli.adapters.upgradeComplete", "Adapter upgrades complete:"),
            ...adapters.map((adapter) => `- ${adapter.adapterId} · v${adapter.version}`)].join("\n"))))

const pruneAdaptersCommand = (options: CommandOptions<"adapters.prune">) => Effect.gen(function*() {
  const keep = yield* parseIntegerOption(options.keep, "--keep")
  const result = yield* pruneAdapterPackages({ apply: options.apply === true, ...(keep === undefined ? {} : { keep }) })
  if (options.json) return yield* printJSON(result)
  return yield* print([
    ...result.slots.map(slot => `${slot.slot}: ${pruneStateLabel(slot.state)}${slot.packageName ? ` · ${slot.packageName} ${slot.version}` : ""}`),
    result.applied ? t("cli.adapters.prune.complete", "Removed {count} unused Adapter installations.", { count: result.removed })
      : t("cli.adapters.prune.preview", "Preview only. Add --apply to remove eligible installations."),
    ...(!result.applied ? [t("cli.adapters.prune.oldReaders", "Before applying, stop older CLI or Collector processes that do not support installation leases.")] : []),
    ...(result.more ? [t("cli.adapters.prune.more", "More eligible installations remain; run again to continue.")] : [])
  ].join("\n"))
})

const pruneStateLabel = (state: AdapterPruneSlot["state"]) => {
  switch (state) {
    case "current": return t("cli.adapters.prune.current", "current")
    case "in_use": return t("cli.adapters.prune.inUse", "in use")
    case "retained": return t("cli.adapters.prune.retained", "retained backup")
    case "eligible": return t("cli.adapters.prune.eligible", "eligible for removal")
    case "removed": return t("cli.adapters.prune.removed", "removed")
    case "unmanaged": return t("cli.adapters.prune.unmanaged", "untracked; retained")
  }
}

const listAdapters = (json: boolean) => inspectClient().pipe(
  Effect.flatMap((config) => json ? printJSON(adapterList(config)) : printAdapters(config))
)

const adapterList = (config: ClientSnapshot) => config.adapters.map((adapter) => ({
  ...adapter,
  projectIds: config.projects
    .filter((project) => project.adapterIds.includes(adapter.adapterId))
    .map((project) => project.id)
}))

const printAdapters = (config: ClientSnapshot) => {
  const adapters = adapterList(config)
  if (adapters.length === 0) return print(t("cli.adapters.empty", "No Adapters installed."))
  return print([
    t("cli.adapters.header", "Installed Adapters"),
    ...adapters.map((adapter) => {
      const projects = adapter.projectIds.length === 0 ? t("cli.common.none", "none") : adapter.projectIds.join(", ")
      return [
        `- ${adapter.adapterId} · ${adapter.displayName} · v${adapter.version}`,
        `  ${adapter.packageName}`,
        `  ${t("cli.adapters.projects", "Projects: {projects}", { projects })}`
      ].join("\n")
    })
  ].join("\n"))
}

const collectCommand = (options: CommandOptions<"collect">) => Effect.gen(function*() {
  const concurrency = yield* parseIntegerOption(options.concurrency, "--concurrency")
  const intervalSeconds = yield* parseIntegerOption(options.interval, "--interval")
  if (!options.once) {
    yield* print(t("cli.collect.running", "ATape collector is running; idle/retry interval {seconds}s. Press Ctrl+C to stop.", { seconds: intervalSeconds ?? 30 }))
  }
  const report = yield* runCollector({
    once: options.once === true,
    ...(options.project ? { projectId: options.project } : {}),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(intervalSeconds === undefined ? {} : { intervalMs: intervalSeconds * 1_000 })
  })
  yield* options.json ? printJSON(report) : printCollectionReport(report)
  if (report.failures.length > 0) {
    return yield* Effect.fail(new CLIInputError(t("cli.collect.failures", "{total} collection job(s) failed.", { total: report.failures.length })))
  }
  if (report.jobs.some(job => job.sourceFailures?.length || job.sourceFailuresTruncated)) {
    return yield* Effect.fail(new CLIInputError(t("cli.collect.partial", "Collection is partial: some sources could not be captured; see source diagnostics.")))
  }
})

const startCommand = (options: CommandOptions<"start">) => Effect.gen(function*() {
  const concurrency = yield* parseIntegerOption(options.concurrency, "--concurrency")
  const intervalSeconds = yield* parseIntegerOption(options.interval, "--interval")
  const started = yield* startManagedCollector({
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(intervalSeconds === undefined ? {} : { intervalMs: intervalSeconds * 1_000 })
  })
  if (options.json) {
    yield* printJSON(started)
    return
  }
  yield* print([
    started.created
      ? t("cli.start.started", "ATape Collector started.")
      : t("cli.start.alreadyRunning", "ATape Collector is already running."),
    `  ${t("cli.start.pid", "PID: {pid}", { pid: started.pid })}`,
    `  ${t("cli.start.interval", "Idle/retry interval {seconds}s · concurrency {concurrency}", { seconds: started.intervalMs / 1_000, concurrency: started.concurrency })}`,
    `  ${t("cli.start.logs", "Logs: {path}", { path: started.logFile })}`
  ].join("\n"))
})

const stopCommand = (json: boolean) => stopManagedCollector().pipe(
  Effect.flatMap((stopped) => json
    ? printJSON({ stopped })
    : print(stopped
      ? t("cli.stop.stopped", "ATape Collector stopped. Its last Project/Adapter status was retained.")
      : t("cli.stop.notRunning", "ATape Collector is not running.")))
)

const statusCommand = (json: boolean) => inspectManagedCollector().pipe(
  Effect.flatMap((status) => json ? printJSON(status) : printCollectorStatus(status))
)

const daemonCommand = (options: CommandOptions<"__collector-daemon">) => Effect.gen(function*() {
  const concurrency = yield* parseIntegerOption(options.concurrency, "--concurrency")
  const intervalSeconds = yield* parseIntegerOption(options.interval, "--interval")
  yield* runManagedCollector({
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(intervalSeconds === undefined ? {} : { intervalMs: intervalSeconds * 1_000 })
  })
})

const collectorStateLabel = (state: "pending" | "healthy" | "partial" | "failed") => {
  switch (state) {
    case "pending": return t("cli.status.statePending", "pending")
    case "healthy": return t("cli.status.stateHealthy", "healthy")
    case "partial": return t("cli.status.statePartial", "partial")
    case "failed": return t("cli.status.stateFailed", "failed")
  }
}

const printCollectorStatus = (status: ManagedCollectorStatus) => {
  const lines = [
    status.running
      ? t("cli.status.running", "ATape Collector is running · PID {pid} · started {age}", { pid: status.pid ?? 0, age: formatAge(status.startedAt) })
      : t("cli.status.stopped", "ATape Collector is stopped."),
    ...(status.running
      ? [t("cli.status.interval", "Idle/retry interval {seconds}s · concurrency {concurrency}", { seconds: (status.intervalMs ?? 0) / 1_000, concurrency: status.concurrency ?? 0 }),
        t("cli.start.logs", "Logs: {path}", { path: status.logFile ?? "" })]
      : []),
    ...(status.collectorFailure === undefined
      ? []
      : [t("cli.status.collectorFailure", "Collector failure {age}: {message}", { age: formatAge(status.collectorFailure.occurredAt), message: status.collectorFailure.message })])
  ]
  if (status.jobs.length === 0) {
    lines.push(t("cli.status.noJobs", "No configured Project/Adapter jobs."))
    return print(lines.join("\n"))
  }
  lines.push(t("cli.status.header", "Project/Adapter status"))
  for (const job of status.jobs) {
    if (job.state === "pending") {
      lines.push(t("cli.status.jobPending", "- {project}/{adapter} · waiting for first cycle", { project: job.projectId, adapter: job.adapterId }))
      continue
    }
    if (job.state === "failed") {
      const reason = job.failureReason === "unauthenticated" ? t("cli.status.unauthenticated", " · unauthenticated")
        : job.retryable ? t("cli.status.retryable", " · retryable") : ""
      lines.push(
        t("cli.status.jobFailed", "- {project}/{adapter} · failed {age}{reason}", {
          project: job.projectId, adapter: job.adapterId, age: formatAge(job.lastFailureAt), reason
        }),
        `  ${job.failureMessage}`,
        ...(job.lastSuccessAt ? [t("cli.status.lastSuccess", "  Last success {age}", { age: formatAge(job.lastSuccessAt) })] : [])
      )
      continue
    }
    const progressLines: Array<string> = []
    if (job.progress !== undefined) {
      const pending = job.progress.pendingCanonicalSessions ?? t("cli.common.unknown", "unknown")
      const backlog = job.progress.pendingRawBytes === undefined
        ? t("cli.common.unknown", "unknown") : `${(job.progress.pendingRawBytes / 1048576).toFixed(1)} MiB`
      progressLines.push(t("cli.status.progress", "  {sources} sources · {pending} Sessions pending · Raw backlog estimate {backlog}", {
        sources: job.progress.sourceFiles, pending, backlog
      }))
    }
    lines.push(
      t("cli.status.jobCompleted", "- {project}/{adapter} · {state} · last completed cycle {age}", {
        project: job.projectId, adapter: job.adapterId, state: collectorStateLabel(job.state), age: formatAge(job.lastSuccessAt)
      }),
      t("cli.status.jobCounts", "  {observations} observations · {rawChunks} Raw chunks · {redactions} redactions", {
        observations: job.observations ?? 0, rawChunks: job.rawChunks ?? 0, redactions: job.redactions ?? 0
      }),
      ...(job.canonicalEvents === undefined ? [] : [t("cli.status.lastCycle", "  Last cycle: {events} events acknowledged · {raw} MiB Raw · {seconds}s", {
        events: job.canonicalEvents, raw: ((job.rawBytes ?? 0) / 1048576).toFixed(1), seconds: ((job.durationMs ?? 0) / 1000).toFixed(1)
      })]),
      ...progressLines,
      ...sourceDiagnosticLines(job)
    )
  }
  return print(lines.join("\n"))
}

const formatAge = (value: string | undefined) => {
  if (value === undefined) return t("cli.status.ageUnknown", "at an unknown time")
  const elapsed = Math.max(0, Date.now() - Date.parse(value))
  if (!Number.isFinite(elapsed)) return value
  if (elapsed < 5_000) return t("cli.status.ageJustNow", "just now")
  const seconds = Math.floor(elapsed / 1_000)
  if (seconds < 60) return t("cli.status.ageSeconds", "{seconds}s ago", { seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t("cli.status.ageMinutes", "{minutes}m ago", { minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t("cli.status.ageHours", "{hours}h ago", { hours })
  return t("cli.status.ageDays", "{days}d ago", { days: Math.floor(hours / 24) })
}

const sourceDiagnosticLines = (job: { readonly sourceFailures?: ReadonlyArray<{ readonly source: string; readonly reason: string }>; readonly sourceFailuresTruncated?: boolean }) => [
  ...(job.sourceFailures ?? []).map(failure => t("cli.status.sourceSkipped", "  Source skipped ({reason}): {source}", { reason: failure.reason, source: JSON.stringify(failure.source) })),
  ...(job.sourceFailuresTruncated ? [t("cli.status.sourceFailuresTruncated", "  Additional source failures omitted (diagnostic limit reached).")] : [])
]

const printCollectionReport = (report: CollectionCycleReport) => print([
  t("cli.collect.reportSummary", "Collection cycle completed · {succeeded} succeeded · {failed} failed", { succeeded: report.jobs.length, failed: report.failures.length }),
  ...report.jobs.flatMap((job) => {
    const more = job.hasMore ? t("cli.collect.moreQueued", " · more queued") : ""
    return [
      t("cli.collect.reportJob", "- {project}/{adapter}: {observations} observations, {rawChunks} Raw chunks, {redactions} redactions{more}", {
        project: job.projectId, adapter: job.adapterId, observations: job.observations, rawChunks: job.rawChunks, redactions: job.redactions, more
      }),
      ...sourceDiagnosticLines(job)
    ]
  }),
  ...report.failures.map((failure) => {
    const retryable = failure.retryable ? t("cli.status.retryable", " · retryable") : ""
    return t("cli.collect.reportFailure", "- {project}/{adapter}: {message}{retryable}", {
      project: failure.projectId, adapter: failure.adapterId, message: failure.message, retryable
    })
  })
].join("\n"))

const parseIntegerOption = (
  value: string | undefined,
  name: string
): Effect.Effect<number | undefined, CLIInputError> => {
  if (value === undefined) return Effect.succeed(undefined)
  const parsed = Number(value)
  return Number.isSafeInteger(parsed)
    ? Effect.succeed(parsed)
    : Effect.fail(new CLIInputError(t("cli.error.integerOption", "{name} must be a whole number.", { name })))
}

const ask = async (
  prompt: ReturnType<typeof createInterface>,
  label: string,
  defaultValue?: string
) => {
  const answer = (await prompt.question(`${label}${defaultValue ? ` [${defaultValue}]` : ""}: `)).trim()
  const value = answer || defaultValue
  if (!value) throw new CLIInputError(t("cli.error.required", "{label} is required.", { label }))
  return value
}

const confirm = async (prompt: ReturnType<typeof createInterface>, label: string) => {
  const answer = (await prompt.question(`${label} [y/N]: `)).trim().toLowerCase()
  return answer === "y" || answer === "yes"
}

const print = (value: string) => Effect.sync(() => { process.stdout.write(`${value}\n`) })
const printJSON = (value: unknown) => print(JSON.stringify(value, null, 2))
const failUsage = (message: string): Effect.Effect<never, CLIInputError> =>
  Effect.fail(new CLIInputError(`${message}\n\n${helpText()}`))

const helpText = (): string => t("cli.help", `ATape CLI

Usage:
  atape --version
  atape upgrade
  atape login [--instance <origin>] [--no-browser]
  atape logout [--instance <origin>]
  atape                              Guided setup or Project console
  atape setup [directory]             Guided setup in an interactive terminal
  atape setup [directory] [--team <slug>] [--create] [options]
  atape projects list [--json]
  atape projects remove <project-id> [--json]
  atape tools list [--json]
  atape tools configure --adapter <id> [--adapter <id>] [--apply] [--json]
  atape tools configure --none [--apply] [--json]
  atape adapters list [--json]
  atape adapters install <package-or-source> [--json]
  atape adapters upgrade <adapter-id>
  atape adapters upgrade --all
  atape adapters prune [--keep <count>] [--apply] [--json]
  atape collect [--once] [--project <project-id>] [options]
  atape start [--interval <seconds>] [--concurrency <count>]
  atape stop
  atape status [--json]
  atape language [<locale>] [--json]

Setup options:
  --instance <origin>   Instance for login/setup/logout
  --team <slug>         Select one of the signed-in account's Teams
  --create              Explicitly create when no exact Project match exists
  --name <name>         Name for a newly created directory Project
  --type <mode>         auto (default), git, or directory (outside Git only)

Login options:
  --no-browser          Print the URL and code without opening a browser

Collector options:
  --once                Run one bounded collection cycle and exit
  --project <id>        Collect only one configured Project
  --interval <seconds>  Idle/retry interval from 10 to 3600 (default: 30)
  --concurrency <count> Project/Adapter jobs from 1 to 8 (default: 4)

Background Collector:
  start                    Run collection after this terminal closes
  stop                     Gracefully stop the managed Collector
  status                   Show each Project/Adapter's latest result

Language:
  atape language [<locale>]  Show or persist the interface language (en, zh-CN)
  --lang <locale>            Use a language for one command only

Environment:
  ATAPE_HOME                 Local ATape root (default: ~/.atape)
  ATAPE_INSTANCE_URL         Instance used when --instance is absent
  ATAPE_LANG                 Interface language (en, zh-CN)
  ATAPE_DEVELOPMENT_ALLOW_HTTP=true
                             Allow an all-loopback HTTP development topology
  ATAPE_CONFIG_FILE          Override the local client configuration file
  ATAPE_COLLECTOR_STATE_FILE Override opaque cursors and Raw progress state
  ATAPE_COLLECTOR_PROCESS_FILE Override managed process metadata
  ATAPE_COLLECTOR_STATUS_FILE  Override Project/Adapter run status
  ATAPE_COLLECTOR_LOG_FILE     Override background Collector logs
  ATAPE_ADAPTER_DIRECTORY    Override the isolated Adapter npm directory
  ATAPE_REDACT_VALUES        JSON array of exact secret values to redact`)
