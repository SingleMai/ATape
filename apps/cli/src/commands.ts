import {
  AdapterRuntimes,
  CollectorDaemonProcess,
  CollectorRunStatusStore,
  CollectorStateStore,
  CollectorTransport,
  CLIAuthenticationGateway,
  CLIAuthenticationInteraction,
  CLICredentialStore,
  ClientMigration,
  ProjectSetupGateway,
  adoptClientCheckpoint,
  applyClientMigration,
  applyProjectSetup,
  SecretRedactor,
  inspectClient,
  inspectManagedCollector,
  installAdapter,
  loginCLI,
  logoutCLI,
  planProjectSetup,
  planClientMigration,
  removeProject,
  runCollector,
  runManagedCollector,
  setProjectAdapter,
  setActiveInstance,
  selectInstanceOrigin,
  startManagedCollector,
  stopManagedCollector,
  upgradeAdapters,
  type AdapterPackages,
  type ClientConfigStore,
  type CollectionCycleReport,
  type ManagedCollectorStatus,
  type ProjectLocator,
  type ProjectSetupPlan,
  type ProjectSetupSelection,
  type SetupTeam
} from "@atape/application"
import type { ClientConfig } from "@atape/domain"
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"
import { Effect } from "effect"
import { cliVersion } from "./version.ts"

type CLIOptions = {
  readonly help?: boolean
  readonly version?: boolean
  readonly json?: boolean
  readonly instance?: string
  readonly noBrowser?: boolean
  readonly team?: string
  readonly create?: boolean
  readonly apply?: boolean
  readonly adoptCheckpoint?: boolean
  readonly from?: string
  readonly sourceProject?: string
  readonly sourceAdapter?: string
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
      instance: { type: "string" },
      "no-browser": { type: "boolean" },
      team: { type: "string" },
      create: { type: "boolean" },
      apply: { type: "boolean" },
      "adopt-checkpoint": { type: "boolean" },
      from: { type: "string" },
      "source-project": { type: "string" },
      "source-adapter": { type: "string" },
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
      ...(parsed.values.instance ? { instance: parsed.values.instance } : {}),
      ...(parsed.values["no-browser"] === true ? { noBrowser: true } : {}),
      ...(parsed.values.team ? { team: parsed.values.team } : {}),
      ...(parsed.values.create === true ? { create: true } : {}),
      ...(parsed.values.apply === true ? { apply: true } : {}),
      ...(parsed.values["adopt-checkpoint"] === true ? { adoptCheckpoint: true } : {}),
      ...(parsed.values.from ? { from: parsed.values.from } : {}),
      ...(parsed.values["source-project"] ? { sourceProject: parsed.values["source-project"] } : {}),
      ...(parsed.values["source-adapter"] ? { sourceAdapter: parsed.values["source-adapter"] } : {}),
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
    ClientMigration
> => {
  const [command, action, argument, extra] = cli.positionals
  if (cli.options.version) {
    return cli.positionals.length === 0 ? print(`ATape ${cliVersion}`) : failUsage("--version accepts no command.")
  }
  if (cli.options.help || command === undefined || command === "help") {
    if (action !== undefined && command !== "help") return failUsage("Too many arguments for help.")
    return print(helpText)
  }
  if (extra !== undefined) return failUsage("Too many positional arguments.")

  switch (command) {
    case "login":
      if (action !== undefined) return failUsage("login accepts no positional arguments.")
      return loginCommand(cli.options)
    case "logout":
      if (action !== undefined) return failUsage("logout accepts no positional arguments.")
      return logoutCommand(cli.options)
    case "setup":
      if (argument !== undefined) return failUsage("setup accepts at most one directory.")
      return setupCommand(action, cli.options)
    case "migrate-local-v0.1":
      if (action !== undefined) return failUsage("migrate-local-v0.1 accepts no positional arguments.")
      return migrateCommand(cli.options)
    case "projects":
      if (action === "list" && argument === undefined) return listProjects(cli.options.json === true)
      if (action === "remove" && argument !== undefined) return removeProjectCommand(argument, cli.options.json === true)
      return failUsage("Use `atape projects list` or `atape projects remove <project-id>`.")
    case "adapters":
      return adapterCommand(action, argument, cli.options)
    case "collect":
      if (action !== undefined) return failUsage("collect accepts no positional arguments.")
      return collectCommand(cli.options)
    case "start":
      if (action !== undefined) return failUsage("start accepts no positional arguments.")
      return startCommand(cli.options)
    case "stop":
      if (action !== undefined) return failUsage("stop accepts no positional arguments.")
      return stopCommand(cli.options.json === true)
    case "status":
      if (action !== undefined) return failUsage("status accepts no positional arguments.")
      return statusCommand(cli.options.json === true)
    case "__collector-daemon":
      if (action !== undefined || cli.options.daemonToken === undefined) {
        return failUsage("Invalid internal Collector invocation.")
      }
      return daemonCommand(cli.options)
    default:
      return failUsage(`Unknown command: ${command}`)
  }
}

const setupCommand = (path: string | undefined, options: CLIOptions) => Effect.gen(function*() {
  const current = yield* inspectClient()
  const instanceOrigin = yield* resolveInstance(options, current)
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
  yield* print([
    result.createdLocally ? "Configured local capture Project." : "Project was already configured; nothing changed.",
    `  ${result.project.id} · ${result.project.type}`,
    `  ${result.project.path}`,
    `  Team: ${result.project.teamName} (${result.project.teamSlug})`,
    `  Instance: ${result.project.instanceOrigin}`,
    result.createdRemotely ? "  Created the matching server Project." : "  Attached the existing server Project.",
    `  Adapters: ${result.project.adapterIds.length === 0 ? "none yet" : result.project.adapterIds.join(", ")}`
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
    `Signed in to ${result.instanceOrigin} as ${result.user.displayName}.`,
    `Credential: ${result.credentialId}`,
    ...result.warnings.map((warning) => `Warning: ${warning}`)
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
      ? `Signed out from ${instanceOrigin}; the local credential was removed.`
      : `No local credential exists for ${instanceOrigin}.`,
    ...result.warnings.map((warning) => `Warning: ${warning}`)
  ].join("\n"))
})

const migrateCommand = (options: CLIOptions) => Effect.gen(function*() {
  if (options.adoptCheckpoint === true) {
    if (options.apply === true) return yield* failUsage("--adopt-checkpoint and --apply are separate operations.")
    if (options.from === undefined || options.project === undefined || options.adapter?.length !== 1) {
      return yield* failUsage(
        "Checkpoint adoption requires --from <import-id>, --project <project-id>, and one --adapter <adapter-id>."
      )
    }
    const adapterId = options.adapter[0]
    if (adapterId === undefined) return yield* failUsage("Checkpoint adoption requires one Adapter ID.")
    const result = yield* adoptClientCheckpoint({
      importId: options.from,
      projectId: options.project,
      adapterId,
      ...(options.sourceProject === undefined ? {} : { sourceProjectId: options.sourceProject }),
      ...(options.sourceAdapter === undefined ? {} : { sourceAdapterId: options.sourceAdapter })
    })
    yield* options.json
      ? printJSON(result)
      : print([
        `Adopted checkpoint ${result.source.projectId}/${result.source.adapterId}.`,
        `Target: ${result.target.instanceOrigin} · User ${result.target.userId} · ${result.target.projectId}/${result.target.adapterId}`,
        `Local checkpoint revision: ${result.revision} (archived source revision ${result.sourceRevision}).`
      ].join("\n"))
    return
  }
  if (options.apply === true) {
    const result = yield* applyClientMigration()
    if (options.json) {
      yield* printJSON(result)
      return
    }
    yield* print([
      `Archived v0.1 data in ${result.importDirectory}.`,
      `Created an empty v0.2 configuration at ${result.createdConfig}.`,
      "The original files were not removed.",
      ...result.unresolved.map((item) => `- ${item}`)
    ].join("\n"))
    return
  }
  const result = yield* planClientMigration()
  if (options.json) {
    yield* printJSON(result)
    return
  }
  yield* print([
    "v0.1 → v0.2 migration plan",
    `Destination: ${result.destinationRoot}`,
    ...result.sources.map((source) => `- Archive ${source.kind}: ${source.path}`),
    ...result.discardedAuthority.map((item) => `- Discard authority: ${item}`),
    ...result.blockers.map((item) => `Blocker: ${item}`),
    result.canApply ? "Run `atape migrate-local-v0.1 --apply` to apply this plan." : "Resolve the blockers before applying."
  ].join("\n"))
})

const resolveInstance = (options: CLIOptions, config: ClientConfig) => selectInstanceOrigin({
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
    : Effect.fail(new CLIInputError("--type must be auto, git, or directory."))
}

const resolveProjectSetupSelection = (
  plan: ProjectSetupPlan,
  options: CLIOptions
): Effect.Effect<ProjectSetupSelection, CLIInputError> => Effect.tryPromise({
  try: async () => {
    const interactive = process.stdin.isTTY && process.stdout.isTTY && options.json !== true
    let team = options.team === undefined ? undefined : findTeam(plan.teams, options.team)
    if (options.team !== undefined && team === undefined) {
      throw new CLIInputError(`Team ${options.team} is not available to the signed-in account.`)
    }

    if (team === undefined && options.create !== true && plan.exactMatches.length === 1) {
      const exact = plan.exactMatches[0]
      if (exact === undefined) throw new CLIInputError("The exact Project match disappeared.")
      return {
        mode: "exact",
        teamId: exact.team.id,
        projectId: exact.project.id,
        ...(options.adapter === undefined ? {} : { adapterIds: options.adapter })
      }
    }

    if (team === undefined) {
      if (plan.teams.length === 1) {
        team = plan.teams[0]
      } else if (!interactive) {
        throw new CLIInputError("--team <slug> is required when more than one Team is available.")
      } else {
        const prompt = createInterface({ input: process.stdin, output: process.stdout })
        try {
          process.stdout.write(["Choose a Team:", ...plan.teams.map((item) =>
            `  ${item.slug} · ${item.displayName}`)].join("\n") + "\n")
          team = findTeam(plan.teams, await ask(prompt, "Team slug"))
        } finally {
          prompt.close()
        }
        if (team === undefined) throw new CLIInputError("The selected Team is not available.")
      }
    }
    if (team === undefined) throw new CLIInputError("No Team is available to the signed-in account.")

    const exact = plan.exactMatches.find((match) => match.team.id === team.id)
    if (exact !== undefined) {
      if (options.create === true) {
        throw new CLIInputError("This repository already has an exact Project match; omit --create to attach it.")
      }
      return {
        mode: "exact",
        teamId: team.id,
        projectId: exact.project.id,
        ...(options.adapter === undefined ? {} : { adapterIds: options.adapter })
      }
    }

    if (options.create !== true) {
      if (!interactive) {
        throw new CLIInputError("No exact Project match exists; pass --create to create one explicitly.")
      }
      const prompt = createInterface({ input: process.stdin, output: process.stdout })
      try {
        const approved = await confirm(prompt, `Create a Project in ${team.displayName}?`)
        if (!approved) throw new CLIInputError("Setup cancelled before creating a server Project.")
      } finally {
        prompt.close()
      }
    }
    return {
      mode: "create",
      teamId: team.id,
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.adapter === undefined ? {} : { adapterIds: options.adapter })
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

const printProjects = (config: ClientConfig) => {
  if (config.projects.length === 0) return print("No local capture Projects. Run `atape setup`.")
  return print([
    `Local capture Projects${config.activeInstanceOrigin ? ` · active ${config.activeInstanceOrigin}` : ""}`,
    ...config.projects.map((project) => [
      `- ${project.id} · ${project.type} · ${project.teamName}`,
      `  ${project.path} · ${project.instanceOrigin}`,
      `  Adapters: ${project.adapterIds.length === 0 ? "none" : project.adapterIds.join(", ")}`
    ].join("\n"))
  ].join("\n"))
}

const removeProjectCommand = (projectId: string, json: boolean) => removeProject(projectId).pipe(
  Effect.flatMap(() => json
    ? printJSON({ projectId, removedLocally: true, serverHistoryDeleted: false })
    : print(`Removed local Project ${projectId}. Captured ATape server history was not deleted.`))
)

const adapterCommand = (
  action: string | undefined,
  argument: string | undefined,
  options: CLIOptions
): Effect.Effect<void, unknown, ClientConfigStore | AdapterPackages> => {
  switch (action) {
    case "list":
      if (argument !== undefined) return failUsage("adapters list accepts no Adapter ID.")
      return listAdapters(options.json === true)
    case "install":
      if (argument === undefined) return failUsage("adapters install requires a package name, local source, or HTTPS archive URL.")
      return installAdapter(argument).pipe(Effect.flatMap((result) => options.json
        ? printJSON(result)
        : print([
          `${result.created ? "Installed" : "Updated"} ${result.adapter.displayName} (${result.adapter.adapterId}) v${result.adapter.version}.`,
          "No Adapter process was started. Enable it for a Project when ready."
        ].join("\n"))))
    case "enable":
    case "disable": {
      if (argument === undefined || options.project === undefined) {
        return failUsage(`adapters ${action} requires <adapter-id> and --project <project-id>.`)
      }
      const enabled = action === "enable"
      return setProjectAdapter({ projectId: options.project, adapterId: argument, enabled }).pipe(
        Effect.flatMap((project) => options.json
          ? printJSON({ projectId: project.id, adapterId: argument, enabled })
          : print(`${enabled ? "Enabled" : "Disabled"} ${argument} for ${project.id}. ${enabled ? "It will be loaded only while this Project is collected." : "It is no longer loaded for this Project."}`))
      )
    }
    case "upgrade": {
      const target = options.all ? "all" : argument
      if (target === undefined || (options.all && argument !== undefined)) {
        return failUsage("Use `atape adapters upgrade <adapter-id>` or `atape adapters upgrade --all`.")
      }
      return upgradeAdapters(target).pipe(Effect.flatMap((adapters) => options.json
        ? printJSON({ adapters })
        : print(adapters.length === 0
          ? "No Adapters are installed."
          : ["Adapter upgrades complete:", ...adapters.map((adapter) => `- ${adapter.adapterId} · v${adapter.version}`)].join("\n"))))
    }
    default:
      return failUsage("Use `atape adapters list|install|enable|disable|upgrade`.")
  }
}

const listAdapters = (json: boolean) => inspectClient().pipe(
  Effect.flatMap((config) => json ? printJSON(adapterList(config)) : printAdapters(config))
)

const adapterList = (config: ClientConfig) => config.adapters.map((adapter) => ({
  ...adapter,
  projectIds: config.projects
    .filter((project) => project.adapterIds.includes(adapter.adapterId))
    .map((project) => project.id)
}))

const printAdapters = (config: ClientConfig) => {
  const adapters = adapterList(config)
  if (adapters.length === 0) return print("No Adapters installed.")
  return print([
    "Installed Adapters",
    ...adapters.map((adapter) => [
      `- ${adapter.adapterId} · ${adapter.displayName} · v${adapter.version}`,
      `  ${adapter.packageName}`,
      `  Projects: ${adapter.projectIds.length === 0 ? "none" : adapter.projectIds.join(", ")}`
    ].join("\n"))
  ].join("\n"))
}

const collectCommand = (options: CLIOptions) => Effect.gen(function*() {
  const concurrency = yield* parseIntegerOption(options.concurrency, "--concurrency")
  const intervalSeconds = yield* parseIntegerOption(options.interval, "--interval")
  if (options.json && !options.once) {
    return yield* failUsage("--json requires --once for collect.")
  }
  if (!options.once) {
    yield* print(`ATape collector is running every ${intervalSeconds ?? 30}s. Press Ctrl+C to stop.`)
  }
  const report = yield* runCollector({
    once: options.once === true,
    ...(options.project ? { projectId: options.project } : {}),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(intervalSeconds === undefined ? {} : { intervalMs: intervalSeconds * 1_000 })
  })
  yield* options.json ? printJSON(report) : printCollectionReport(report)
  if (report.failures.length > 0) {
    return yield* Effect.fail(new CLIInputError(`${report.failures.length} collection job(s) failed.`))
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
    started.created ? "ATape Collector started." : "ATape Collector is already running.",
    `  PID: ${started.pid}`,
    `  Every ${started.intervalMs / 1_000}s · concurrency ${started.concurrency}`,
    `  Logs: ${started.logFile}`
  ].join("\n"))
})

const stopCommand = (json: boolean) => stopManagedCollector().pipe(
  Effect.flatMap((stopped) => json
    ? printJSON({ stopped })
    : print(stopped
      ? "ATape Collector stopped. Its last Project/Adapter status was retained."
      : "ATape Collector is not running."))
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

const printCollectorStatus = (status: ManagedCollectorStatus) => {
  const lines = [
    status.running
      ? `ATape Collector is running · PID ${status.pid} · started ${formatAge(status.startedAt)}`
      : "ATape Collector is stopped.",
    ...(status.running
      ? [`Every ${(status.intervalMs ?? 0) / 1_000}s · concurrency ${status.concurrency}`, `Logs: ${status.logFile}`]
      : []),
    ...(status.collectorFailure === undefined
      ? []
      : [`Collector failure ${formatAge(status.collectorFailure.occurredAt)}: ${status.collectorFailure.message}`])
  ]
  if (status.jobs.length === 0) {
    lines.push("No configured Project/Adapter jobs.")
    return print(lines.join("\n"))
  }
  lines.push("Project/Adapter status")
  for (const job of status.jobs) {
    if (job.state === "pending") {
      lines.push(`- ${job.projectId}/${job.adapterId} · waiting for first cycle`)
      continue
    }
    if (job.state === "failed") {
      lines.push(
        `- ${job.projectId}/${job.adapterId} · failed ${formatAge(job.lastFailureAt)}` +
          `${job.failureReason === "unauthenticated" ? " · unauthenticated" : job.retryable ? " · retryable" : ""}`,
        `  ${job.failureMessage}`,
        ...(job.lastSuccessAt ? [`  Last success ${formatAge(job.lastSuccessAt)}`] : [])
      )
      continue
    }
    lines.push(
      `- ${job.projectId}/${job.adapterId} · healthy · last success ${formatAge(job.lastSuccessAt)}`,
      `  ${job.observations ?? 0} observations · ${job.rawChunks ?? 0} Raw chunks · ${job.redactions ?? 0} redactions`
    )
  }
  return print(lines.join("\n"))
}

const formatAge = (value: string | undefined) => {
  if (value === undefined) return "at an unknown time"
  const elapsed = Math.max(0, Date.now() - Date.parse(value))
  if (!Number.isFinite(elapsed)) return value
  if (elapsed < 5_000) return "just now"
  const seconds = Math.floor(elapsed / 1_000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const printCollectionReport = (report: CollectionCycleReport) => print([
  `Collection cycle completed · ${report.jobs.length} succeeded · ${report.failures.length} failed`,
  ...report.jobs.map((job) =>
    `- ${job.projectId}/${job.adapterId}: ${job.observations} observations, ${job.rawChunks} Raw chunks, ${job.redactions} redactions${job.hasMore ? " · more queued" : ""}`),
  ...report.failures.map((failure) =>
    `- ${failure.projectId}/${failure.adapterId}: ${failure.message}${failure.retryable ? " · retryable" : ""}`)
].join("\n"))

const parseIntegerOption = (
  value: string | undefined,
  name: string
): Effect.Effect<number | undefined, CLIInputError> => {
  if (value === undefined) return Effect.succeed(undefined)
  const parsed = Number(value)
  return Number.isSafeInteger(parsed)
    ? Effect.succeed(parsed)
    : Effect.fail(new CLIInputError(`${name} must be a whole number.`))
}

const ask = async (
  prompt: ReturnType<typeof createInterface>,
  label: string,
  defaultValue?: string
) => {
  const answer = (await prompt.question(`${label}${defaultValue ? ` [${defaultValue}]` : ""}: `)).trim()
  const value = answer || defaultValue
  if (!value) throw new CLIInputError(`${label} is required.`)
  return value
}

const confirm = async (prompt: ReturnType<typeof createInterface>, label: string) => {
  const answer = (await prompt.question(`${label} [y/N]: `)).trim().toLowerCase()
  return answer === "y" || answer === "yes"
}

const print = (value: string) => Effect.sync(() => { process.stdout.write(`${value}\n`) })
const printJSON = (value: unknown) => print(JSON.stringify(value, null, 2))
const failUsage = (message: string): Effect.Effect<never, CLIInputError> =>
  Effect.fail(new CLIInputError(`${message}\n\n${helpText}`))

const helpText = `ATape CLI

Usage:
  atape --version
  atape login [--instance <origin>] [--no-browser]
  atape logout [--instance <origin>]
  atape setup [directory] [--team <slug>] [--create] [options]
  atape migrate-local-v0.1 [--apply] [--json]
  atape migrate-local-v0.1 --adopt-checkpoint --from <import-id>
        --project <id> --adapter <id> [--source-project <id>] [--source-adapter <id>]
  atape projects list [--json]
  atape projects remove <project-id> [--json]
  atape adapters list [--json]
  atape adapters install <package-or-source> [--json]
  atape adapters enable <adapter-id> --project <project-id>
  atape adapters disable <adapter-id> --project <project-id>
  atape adapters upgrade <adapter-id>
  atape adapters upgrade --all
  atape collect [--once] [--project <project-id>] [options]
  atape start [--interval <seconds>] [--concurrency <count>]
  atape stop
  atape status [--json]

Setup options:
  --instance <origin>   Instance for login/setup/logout
  --team <slug>         Select one of the signed-in account's Teams
  --create              Explicitly create when no exact Project match exists
  --name <name>         Name for a newly created directory Project
  --type <mode>         auto, git, or directory (default: auto)
  --adapter <id>        Attach an installed Adapter; may be repeated

Login options:
  --no-browser          Print the URL and code without opening a browser

Collector options:
  --once                Run one bounded collection cycle and exit
  --project <id>        Collect only one configured Project
  --interval <seconds>  Continuous interval from 10 to 3600 (default: 30)
  --concurrency <count> Project/Adapter jobs from 1 to 8 (default: 4)

Background Collector:
  start                    Run collection after this terminal closes
  stop                     Gracefully stop the managed Collector
  status                   Show each Project/Adapter's latest result

Environment:
  ATAPE_HOME                 Local ATape root (default: ~/.atape)
  ATAPE_INSTANCE_URL         Instance used when --instance is absent
  ATAPE_DEVELOPMENT_ALLOW_HTTP=true
                             Allow an all-loopback HTTP development topology
  ATAPE_CONFIG_FILE          Override the local client configuration file
  ATAPE_COLLECTOR_STATE_FILE Override opaque cursors and Raw progress state
  ATAPE_COLLECTOR_PROCESS_FILE Override managed process metadata
  ATAPE_COLLECTOR_STATUS_FILE  Override Project/Adapter run status
  ATAPE_COLLECTOR_LOG_FILE     Override background Collector logs
  ATAPE_ADAPTER_DIRECTORY    Override the isolated Adapter npm directory
  ATAPE_REDACT_VALUES        JSON array of exact secret values to redact`
