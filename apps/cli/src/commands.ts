import {
  AdapterRuntimes,
  CollectorDaemonProcess,
  CollectorRunStatusStore,
  CollectorStateStore,
  CollectorTransport,
  CLIAuthenticationGateway,
  CLIAuthenticationInteraction,
  CLICredentialStore,
  ProjectSetupGateway,
  applyProjectSetup,
  SecretRedactor,
  inspectClient,
  inspectManagedCollector,
  installAdapter,
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
  upgradeCLI, type CLIUpgradePlatform,
  inspectTools, planToolChange, applyToolChange,
  type CLISetupPlatform,
  type AdapterPackages,
  type ClientConfigStore,
  type ClientSnapshot,
  type CollectionCycleReport,
  type ManagedCollectorStatus,
  type ProjectLocator,
  type ProjectSetupPlan,
  type ProjectSetupSelection,
  type SetupTeam
} from "@atape/application"
import { SUPPORTED_LOCALES, isLocale } from "@atape/i18n"
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"
import { Effect } from "effect"
import { cliVersion } from "./version.ts"
import { supportsInteractiveExperience } from "./interactiveEligibility.ts"
import { currentCliLocale, t } from "./i18n/index.ts"
import { defaultNodeClientPaths, setClientConfigLocale } from "./runtime/clientLayers.ts"

type CLIOptions = {
  readonly help?: boolean
  readonly version?: boolean
  readonly json?: boolean
  readonly lang?: string
  readonly instance?: string
  readonly noBrowser?: boolean
  readonly team?: string
  readonly create?: boolean
  readonly apply?: boolean
  readonly none?: boolean
  readonly name?: string
  readonly type?: string
  readonly adapter?: ReadonlyArray<string>
  readonly project?: string
  readonly all?: boolean
  readonly once?: boolean
  readonly interval?: string
  readonly concurrency?: string
  readonly daemonToken?: string
}

export type ParsedCLI = {
  readonly positionals: ReadonlyArray<string>
  readonly options: CLIOptions
}

export class CLIInputError extends Error {}

export const parseCLI = (args: ReadonlyArray<string>): ParsedCLI => {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      json: { type: "boolean" },
      lang: { type: "string" },
      instance: { type: "string" },
      "no-browser": { type: "boolean" },
      team: { type: "string" },
      create: { type: "boolean" },
      apply: { type: "boolean" },
      none: { type: "boolean" },
      name: { type: "string" },
      type: { type: "string" },
      adapter: { type: "string", multiple: true },
      project: { type: "string" },
      all: { type: "boolean" },
      once: { type: "boolean" },
      interval: { type: "string" },
      concurrency: { type: "string" },
      "daemon-token": { type: "string" }
    }
  })
  return {
    positionals: parsed.positionals,
    options: {
      ...(parsed.values.help === true ? { help: true } : {}),
      ...(parsed.values.version === true ? { version: true } : {}),
      ...(parsed.values.json === true ? { json: true } : {}),
      ...(parsed.values.lang ? { lang: parsed.values.lang } : {}),
      ...(parsed.values.instance ? { instance: parsed.values.instance } : {}),
      ...(parsed.values["no-browser"] === true ? { noBrowser: true } : {}),
      ...(parsed.values.team ? { team: parsed.values.team } : {}),
      ...(parsed.values.create === true ? { create: true } : {}),
      ...(parsed.values.apply === true ? { apply: true } : {}),
      ...(parsed.values.none === true ? { none: true } : {}),
      ...(parsed.values.name ? { name: parsed.values.name } : {}),
      ...(parsed.values.type ? { type: parsed.values.type } : {}),
      ...(parsed.values.adapter ? { adapter: parsed.values.adapter } : {}),
      ...(parsed.values.project ? { project: parsed.values.project } : {}),
      ...(parsed.values.all === true ? { all: true } : {}),
      ...(parsed.values.once === true ? { once: true } : {}),
      ...(parsed.values.interval ? { interval: parsed.values.interval } : {}),
      ...(parsed.values.concurrency ? { concurrency: parsed.values.concurrency } : {}),
      ...(parsed.values["daemon-token"] ? { daemonToken: parsed.values["daemon-token"] } : {})
    }
  }
}

export const runCommand = (cli: ParsedCLI): Effect.Effect<
  void,
  unknown,
  ClientConfigStore | ProjectLocator | AdapterPackages |
    CollectorStateStore | AdapterRuntimes | CollectorTransport | SecretRedactor |
    CollectorDaemonProcess | CollectorRunStatusStore |
    CLIAuthenticationGateway | CLICredentialStore | CLIAuthenticationInteraction | ProjectSetupGateway |
    CLISetupPlatform | CLIUpgradePlatform
> => {
  const [command, action, argument, extra] = cli.positionals
  if (cli.options.version) {
    return cli.positionals.length === 0 ? print(`ATape ${cliVersion}`) : failUsage(t("cli.error.versionNoCommand", "--version accepts no command."))
  }
  if (cli.options.help || command === undefined || command === "help") {
    if (action !== undefined && command !== "help") return failUsage(t("cli.error.tooManyHelp", "Too many arguments for help."))
    return print(helpText())
  }
  if (extra !== undefined) return failUsage(t("cli.error.tooManyPositionals", "Too many positional arguments."))

  switch (command) {
    case "upgrade":
      if (action !== undefined) return failUsage(t("cli.error.upgradeNoPositional", "upgrade accepts no positional arguments."))
      return (cli.options.json ? Effect.void : print(t("cli.upgrade.checking", "Checking for an ATape update…"))).pipe(
        Effect.andThen(upgradeCLI(cliVersion)), Effect.flatMap(result => cli.options.json ? printJSON(result) : print(
          result.updated ? result.resumed
            ? t("cli.upgrade.updatedResumed", "Updated ATape to {version}. Background sync resumed.", { version: result.version })
            : t("cli.upgrade.updated", "Updated ATape to {version}.", { version: result.version })
            : t("cli.upgrade.upToDate", "ATape {version} is up to date.", { version: result.version }))))
    case "login":
      if (action !== undefined) return failUsage(t("cli.error.loginNoPositional", "login accepts no positional arguments."))
      return loginCommand(cli.options)
    case "logout":
      if (action !== undefined) return failUsage(t("cli.error.logoutNoPositional", "logout accepts no positional arguments."))
      return logoutCommand(cli.options)
    case "setup":
      if (argument !== undefined) return failUsage(t("cli.error.setupTooManyDirectories", "setup accepts at most one directory."))
      return setupCommand(action, cli.options)
    case "projects":
      if (action === "list" && argument === undefined) return listProjects(cli.options.json === true)
      if (action === "remove" && argument !== undefined) return removeProjectCommand(argument, cli.options.json === true)
      return failUsage(t("cli.error.projectsUsage", "Use `atape projects list` or `atape projects remove <project-id>`."))
    case "adapters":
      return adapterCommand(action, argument, cli.options)
    case "tools":
      if (argument !== undefined) return failUsage(t("cli.error.toolsNoExtraArguments", "tools accepts no extra arguments."))
      if (action === "list") return inspectTools().pipe(Effect.flatMap(result => cli.options.json ? printJSON({ configured: result.configured,
        tools: result.choices, projectCount: result.config.projects.length }) : print(
        result.choices.map(choice => `${choice.label}: ${result.configured && choice.selected
          ? t("cli.tools.enabled", "enabled") : t("cli.tools.notEnabled", "not enabled")}${choice.installed ? t("cli.tools.ready", " · ready") : ""}`).join("\n"))))
      if (action !== "configure" || cli.options.project || Boolean(cli.options.none) === Boolean(cli.options.adapter?.length)) {
        return failUsage(t("cli.error.toolsConfigureUsage", "Use atape tools configure --adapter <id> [--adapter <id>] or --none. Preview first; add --apply to save globally."))
      }
      return planToolChange(cli.options.adapter ?? []).pipe(Effect.flatMap(plan => {
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
    case "collect":
      if (action !== undefined) return failUsage(t("cli.error.collectNoPositional", "collect accepts no positional arguments."))
      return collectCommand(cli.options)
    case "start":
      if (action !== undefined) return failUsage(t("cli.error.startNoPositional", "start accepts no positional arguments."))
      return startCommand(cli.options)
    case "stop":
      if (action !== undefined) return failUsage(t("cli.error.stopNoPositional", "stop accepts no positional arguments."))
      return stopCommand(cli.options.json === true)
    case "status":
      if (action !== undefined) return failUsage(t("cli.error.statusNoPositional", "status accepts no positional arguments."))
      return statusCommand(cli.options.json === true)
    case "language":
      return languageCommand(action, cli.options)
    case "__collector-daemon":
      if (action !== undefined || cli.options.daemonToken === undefined) {
        return failUsage(t("cli.error.invalidCollectorInvocation", "Invalid internal Collector invocation."))
      }
      return daemonCommand(cli.options)
    default:
      return failUsage(t("cli.error.unknownCommand", "Unknown command: {command}", { command }))
  }
}

const languageCommand = (locale: string | undefined, options: CLIOptions) => Effect.gen(function*() {
  if (locale === undefined) {
    const current = currentCliLocale()
    if (options.json) return yield* printJSON({ locale: current })
    return yield* print(t("cli.language.current", "Current language: {locale}", { locale: current }))
  }
  if (!isLocale(locale)) {
    return yield* failUsage(t("cli.language.unsupported", "Unsupported language: {locale}. Supported: {locales}.",
      { locale, locales: SUPPORTED_LOCALES.join(", ") }))
  }
  yield* setClientConfigLocale(defaultNodeClientPaths().configFile, locale)
  if (options.json) return yield* printJSON({ locale })
  return yield* print(t("cli.language.set", "Language set to {locale}. It applies to the next ATape command.", { locale }))
})

const setupCommand = (path: string | undefined, options: CLIOptions) => Effect.gen(function*() {
  if (options.adapter !== undefined) return yield* failUsage(t("cli.error.toolsAreGlobal", "Tools are global. Omit --adapter for Project setup; use atape tools configure to change tools."))
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

const loginCommand = (options: CLIOptions) => Effect.gen(function*() {
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

const logoutCommand = (options: CLIOptions) => Effect.gen(function*() {
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

const resolveInstance = (options: CLIOptions, config: ClientSnapshot) => selectInstanceOrigin({
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
  options: CLIOptions
): Effect.Effect<ProjectSetupSelection, CLIInputError> => Effect.tryPromise({
  try: async () => {
    const interactive = supportsInteractiveExperience() && options.json !== true
    let team = options.team === undefined ? undefined : findTeam(plan.teams, options.team)
    if (options.team !== undefined && team === undefined) {
      throw new CLIInputError(t("cli.setup.teamUnavailable", "Team {team} is not available to the signed-in account.", { team: options.team }))
    }

    if (team === undefined && options.create !== true && plan.exactMatches.length === 1) {
      const exact = plan.exactMatches[0]
      if (exact === undefined) throw new CLIInputError(t("cli.setup.exactMatchDisappeared", "The exact Project match disappeared."))
      return {
        mode: "exact",
        teamId: exact.team.id,
        projectId: exact.project.id,
      }
    }

    if (team === undefined) {
      if (plan.teams.length === 1) {
        team = plan.teams[0]
      } else if (!interactive) {
        throw new CLIInputError(t("cli.setup.teamRequired", "--team <slug> is required when more than one Team is available."))
      } else {
        const prompt = createInterface({ input: process.stdin, output: process.stdout })
        try {
          process.stdout.write([t("cli.setup.chooseTeam", "Choose a Team:"), ...plan.teams.map((item) =>
            `  ${item.slug} · ${item.displayName}`)].join("\n") + "\n")
          team = findTeam(plan.teams, await ask(prompt, t("cli.setup.teamSlugPrompt", "Team slug")))
        } finally {
          prompt.close()
        }
        if (team === undefined) throw new CLIInputError(t("cli.setup.selectedTeamUnavailable", "The selected Team is not available."))
      }
    }
    if (team === undefined) throw new CLIInputError(t("cli.setup.noTeam", "No Team is available to the signed-in account."))

    const exact = plan.exactMatches.find((match) => match.team.id === team.id)
    if (exact !== undefined) {
      if (options.create === true) {
        throw new CLIInputError(t("cli.setup.exactMatchCreateConflict", "This repository already has an exact Project match; omit --create to attach it."))
      }
      return {
        mode: "exact",
        teamId: team.id,
        projectId: exact.project.id,
      }
    }

    if (options.create !== true) {
      if (!interactive) {
        throw new CLIInputError(t("cli.setup.createRequired", "No exact Project match exists; pass --create to create one explicitly."))
      }
      const prompt = createInterface({ input: process.stdin, output: process.stdout })
      try {
        const approved = await confirm(prompt, t("cli.setup.confirmCreate", "Create a Project in {team}?", { team: team.displayName }))
        if (!approved) throw new CLIInputError(t("cli.setup.cancelled", "Setup cancelled before creating a server Project."))
      } finally {
        prompt.close()
      }
    }
    return {
      mode: "create",
      teamId: team.id,
      ...(options.name === undefined ? {} : { name: options.name }),
    }
  },
  catch: (cause) => cause instanceof CLIInputError
    ? cause
    : new CLIInputError(cause instanceof Error ? cause.message : String(cause))
})

const findTeam = (teams: ReadonlyArray<SetupTeam>, selection: string) => {
  const matches = teams.filter((team) => team.id === selection || team.slug === selection)
  return matches.length === 1 ? matches[0] : undefined
}

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

const adapterCommand = (
  action: string | undefined,
  argument: string | undefined,
  options: CLIOptions
): Effect.Effect<void, unknown, ClientConfigStore | AdapterPackages> => {
  switch (action) {
    case "list":
      if (argument !== undefined) return failUsage(t("cli.error.adaptersListNoId", "adapters list accepts no Adapter ID."))
      return listAdapters(options.json === true)
    case "install":
      if (argument === undefined) return failUsage(t("cli.error.adaptersInstallRequiresSpec", "adapters install requires a package name, local source, or HTTPS archive URL."))
      return installAdapter(argument).pipe(Effect.flatMap((result) => options.json
        ? printJSON(result)
        : print([
          result.created
            ? t("cli.adapters.installed", "Installed {name} ({id}) v{version}.", { name: result.adapter.displayName, id: result.adapter.adapterId, version: result.adapter.version })
            : t("cli.adapters.updated", "Updated {name} ({id}) v{version}.", { name: result.adapter.displayName, id: result.adapter.adapterId, version: result.adapter.version }),
          t("cli.adapters.installNotice", "No sync was enabled. Open Tools to configure it for your projects.")
        ].join("\n"))))
    case "upgrade": {
      const target = options.all ? "all" : argument
      if (target === undefined || (options.all && argument !== undefined)) {
        return failUsage(t("cli.error.adaptersUpgradeUsage", "Use `atape adapters upgrade <adapter-id>` or `atape adapters upgrade --all`."))
      }
      return upgradeAdapters(target).pipe(Effect.flatMap((adapters) => options.json
        ? printJSON({ adapters })
        : print(adapters.length === 0
          ? t("cli.adapters.noneInstalled", "No Adapters are installed.")
          : [t("cli.adapters.upgradeComplete", "Adapter upgrades complete:"),
            ...adapters.map((adapter) => `- ${adapter.adapterId} · v${adapter.version}`)].join("\n"))))
    }
    default:
      return failUsage(t("cli.error.adaptersUsage", "Use `atape adapters list|install|upgrade`."))
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

const collectCommand = (options: CLIOptions) => Effect.gen(function*() {
  const concurrency = yield* parseIntegerOption(options.concurrency, "--concurrency")
  const intervalSeconds = yield* parseIntegerOption(options.interval, "--interval")
  if (options.json && !options.once) {
    return yield* failUsage(t("cli.error.collectJsonRequiresOnce", "--json requires --once for collect."))
  }
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

const startCommand = (options: CLIOptions) => Effect.gen(function*() {
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

const daemonCommand = (options: CLIOptions) => Effect.gen(function*() {
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
