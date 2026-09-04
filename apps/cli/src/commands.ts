import {
  AdapterRuntimes,
  CollectorStateStore,
  CollectorTransport,
  SecretRedactor,
  inspectClient,
  installAdapter,
  removeProject,
  runCollector,
  setProjectAdapter,
  setupProject,
  upgradeAdapters,
  type AdapterPackages,
  type ClientConfigStore,
  type CollectionCycleReport,
  type ProjectLocator,
  type SetupProjectInput
} from "@atape/application"
import type { ClientConfig } from "@atape/domain"
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"
import { Effect } from "effect"

type CLIOptions = {
  readonly help?: boolean
  readonly json?: boolean
  readonly userId?: string
  readonly teamId?: string
  readonly teamName?: string
  readonly projectId?: string
  readonly name?: string
  readonly type?: string
  readonly server?: string
  readonly adapter?: ReadonlyArray<string>
  readonly project?: string
  readonly all?: boolean
  readonly once?: boolean
  readonly interval?: string
  readonly concurrency?: string
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
      json: { type: "boolean" },
      "user-id": { type: "string" },
      "team-id": { type: "string" },
      "team-name": { type: "string" },
      "project-id": { type: "string" },
      name: { type: "string" },
      type: { type: "string" },
      server: { type: "string" },
      adapter: { type: "string", multiple: true },
      project: { type: "string" },
      all: { type: "boolean" },
      once: { type: "boolean" },
      interval: { type: "string" },
      concurrency: { type: "string" }
    }
  })
  return {
    positionals: parsed.positionals,
    options: {
      ...(parsed.values.help === true ? { help: true } : {}),
      ...(parsed.values.json === true ? { json: true } : {}),
      ...(parsed.values["user-id"] ? { userId: parsed.values["user-id"] } : {}),
      ...(parsed.values["team-id"] ? { teamId: parsed.values["team-id"] } : {}),
      ...(parsed.values["team-name"] ? { teamName: parsed.values["team-name"] } : {}),
      ...(parsed.values["project-id"] ? { projectId: parsed.values["project-id"] } : {}),
      ...(parsed.values.name ? { name: parsed.values.name } : {}),
      ...(parsed.values.type ? { type: parsed.values.type } : {}),
      ...(parsed.values.server ? { server: parsed.values.server } : {}),
      ...(parsed.values.adapter ? { adapter: parsed.values.adapter } : {}),
      ...(parsed.values.project ? { project: parsed.values.project } : {}),
      ...(parsed.values.all === true ? { all: true } : {}),
      ...(parsed.values.once === true ? { once: true } : {}),
      ...(parsed.values.interval ? { interval: parsed.values.interval } : {}),
      ...(parsed.values.concurrency ? { concurrency: parsed.values.concurrency } : {})
    }
  }
}

export const runCommand = (cli: ParsedCLI): Effect.Effect<
  void,
  unknown,
  ClientConfigStore | ProjectLocator | AdapterPackages |
    CollectorStateStore | AdapterRuntimes | CollectorTransport | SecretRedactor
> => {
  const [command, action, argument, extra] = cli.positionals
  if (cli.options.help || command === undefined || command === "help") {
    if (action !== undefined && command !== "help") return failUsage("Too many arguments for help.")
    return print(helpText)
  }
  if (extra !== undefined) return failUsage("Too many positional arguments.")

  switch (command) {
    case "setup":
      if (argument !== undefined) return failUsage("setup accepts at most one directory.")
      return setupCommand(action, cli.options)
    case "projects":
      if (action === "list" && argument === undefined) return listProjects(cli.options.json === true)
      if (action === "remove" && argument !== undefined) return removeProjectCommand(argument, cli.options.json === true)
      return failUsage("Use `atape projects list` or `atape projects remove <project-id>`.")
    case "adapters":
      return adapterCommand(action, argument, cli.options)
    case "collect":
      if (action !== undefined) return failUsage("collect accepts no positional arguments.")
      return collectCommand(cli.options)
    default:
      return failUsage(`Unknown command: ${command}`)
  }
}

const setupCommand = (path: string | undefined, options: CLIOptions) => Effect.gen(function*() {
  const current = yield* inspectClient()
  const resolved = yield* resolveSetupInput(path, options, current)
  const result = yield* setupProject(resolved)
  if (options.json) {
    yield* printJSON(result)
    return
  }
  yield* print([
    result.created ? "Configured local capture Project." : "Project was already configured; nothing changed.",
    `  ${result.project.id} · ${result.project.type}`,
    `  ${result.project.path}`,
    `  Team: ${result.project.teamName} (${result.project.teamId})`,
    `  User: ${result.userId ?? "not configured"}`,
    `  Server: ${result.serverUrl}`,
    `  Adapters: ${result.project.adapterIds.length === 0 ? "none yet" : result.project.adapterIds.join(", ")}`
  ].join("\n"))
})

const resolveSetupInput = (
  path: string | undefined,
  options: CLIOptions,
  current: ClientConfig
): Effect.Effect<SetupProjectInput, CLIInputError> => Effect.tryPromise({
  try: async () => {
    const needsPrompt = path === undefined || options.teamId === undefined ||
      (options.userId === undefined && current.userId === undefined) ||
      options.teamName === undefined || options.server === undefined
    if (needsPrompt && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      if (options.teamId === undefined) {
        throw new CLIInputError("--team-id is required when setup is not interactive.")
      }
      if (options.userId === undefined && current.userId === undefined) {
        throw new CLIInputError("--user-id is required for the first non-interactive setup.")
      }
    }
    if (!needsPrompt || (!process.stdin.isTTY || !process.stdout.isTTY)) {
      return setupInput(path ?? process.cwd(), options, current.serverUrl, current.userId)
    }

    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const selectedPath = path ?? await ask(prompt, "Project directory", process.cwd())
      const userId = options.userId ?? current.userId ?? await ask(prompt, "Team user ID")
      const teamId = options.teamId ?? await ask(prompt, "Team ID")
      const teamName = options.teamName ?? await ask(prompt, "Team name", teamId)
      const server = options.server ?? await ask(prompt, "ATape server", current.serverUrl)
      return setupInput(
        selectedPath,
        { ...options, userId, teamId, teamName, server },
        current.serverUrl,
        current.userId
      )
    } finally {
      prompt.close()
    }
  },
  catch: (cause) => cause instanceof CLIInputError
    ? cause
    : new CLIInputError(cause instanceof Error ? cause.message : String(cause))
})

const setupInput = (
  path: string,
  options: CLIOptions,
  defaultServer: string,
  currentUserId?: string
): SetupProjectInput => {
  if (options.teamId === undefined) throw new CLIInputError("Team ID is required.")
  const userId = options.userId ?? currentUserId
  if (userId === undefined) throw new CLIInputError("Team user ID is required.")
  const type = options.type ?? "auto"
  if (type !== "auto" && type !== "git" && type !== "directory") {
    throw new CLIInputError("--type must be auto, git, or directory.")
  }
  return {
    path,
    userId,
    teamId: options.teamId,
    teamName: options.teamName ?? options.teamId,
    type,
    serverUrl: options.server ?? defaultServer,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.name ? { name: options.name } : {}),
    ...(options.adapter ? { adapterIds: options.adapter } : {})
  }
}

const listProjects = (json: boolean) => inspectClient().pipe(
  Effect.flatMap((config) => json
    ? printJSON({ serverUrl: config.serverUrl, userId: config.userId, projects: config.projects })
    : printProjects(config))
)

const printProjects = (config: ClientConfig) => {
  if (config.projects.length === 0) return print("No local capture Projects. Run `atape setup`.")
  return print([
    `Local capture Projects · ${config.serverUrl} · User ${config.userId ?? "not configured"}`,
    ...config.projects.map((project) => [
      `- ${project.id} · ${project.type} · ${project.teamName}`,
      `  ${project.path}`,
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
      if (argument === undefined) return failUsage("adapters install requires a package name or local directory.")
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

const print = (value: string) => Effect.sync(() => { process.stdout.write(`${value}\n`) })
const printJSON = (value: unknown) => print(JSON.stringify(value, null, 2))
const failUsage = (message: string): Effect.Effect<never, CLIInputError> =>
  Effect.fail(new CLIInputError(`${message}\n\n${helpText}`))

const helpText = `ATape CLI

Usage:
  atape setup [directory] --team-id <id> [options]
  atape projects list [--json]
  atape projects remove <project-id> [--json]
  atape adapters list [--json]
  atape adapters install <package-or-directory> [--json]
  atape adapters enable <adapter-id> --project <project-id>
  atape adapters disable <adapter-id> --project <project-id>
  atape adapters upgrade <adapter-id>
  atape adapters upgrade --all
  atape collect [--once] [--project <project-id>] [options]

Setup options:
  --user-id <id>        Stable Team member identity for captured sessions
  --team-id <id>        Team identity used by server ingestion
  --team-name <name>    Team display name (defaults to Team ID)
  --project-id <id>     Stable global Project ID (defaults to folder name)
  --name <name>         Project display name
  --type <mode>         auto, git, or directory (default: auto)
  --server <url>        ATape server (default: http://127.0.0.1:8080)
  --adapter <id>        Attach an installed Adapter; may be repeated

Collector options:
  --once                Run one bounded collection cycle and exit
  --project <id>        Collect only one configured Project
  --interval <seconds>  Continuous interval from 10 to 3600 (default: 30)
  --concurrency <count> Project/Adapter jobs from 1 to 8 (default: 4)

Environment:
  ATAPE_CONFIG_FILE          Override the local client configuration file
  ATAPE_COLLECTOR_STATE_FILE Override opaque cursors and Raw progress state
  ATAPE_ADAPTER_DIRECTORY    Override the isolated Adapter npm directory
  ATAPE_REDACT_VALUES        JSON array of exact secret values to redact`
