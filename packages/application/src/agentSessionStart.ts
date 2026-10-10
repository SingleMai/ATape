import type { LocalProject } from "@atape/domain"
import { Effect, Schema } from "effect"
import { AdapterRuntimes, AdapterRuntimeError } from "./collectorContracts.ts"
import { inspectClient, ClientConfigStore, ProjectLocator } from "./clientManagement.ts"
import { ProjectSetupGateway, type SetupWorkspace, type SetupProjectMatch } from "./projectSetup.ts"

export class AgentSessionStartError extends Schema.TaggedError<AgentSessionStartError>()("AgentSessionStartError", {
  reason: Schema.Literals(["invalid", "selection", "changed", "unauthenticated", "transport", "runtime"]),
  message: Schema.String
}) {}
const failure = (reason: AgentSessionStartError["reason"], message: string) => new AgentSessionStartError({ reason, message })
const covers = (root: string, cwd: string) => root === cwd || cwd.startsWith(root.endsWith("/") ? root : `${root}/`)

/** Selection and fresh permission checks are business rules shared by every start caller. */
export const startAgentSession = Effect.fn("AgentSession.start")(function*(input: {
  readonly toolId: string; readonly cwd: string; readonly projectId?: string; readonly initialPrompt?: string
}) {
  if (typeof input.toolId !== "string" || !input.toolId || input.toolId.length > 200 || input.toolId.includes("\0") ||
    typeof input.cwd !== "string" || !input.cwd || input.cwd.length > 4096 || input.cwd.includes("\0") ||
    input.projectId !== undefined && (typeof input.projectId !== "string" || !input.projectId || input.projectId.length > 200 || input.projectId.includes("\0")) ||
    input.initialPrompt !== undefined && (typeof input.initialPrompt !== "string" || input.initialPrompt.includes("\0") ||
      input.initialPrompt.length > 65536 || new TextEncoder().encode(input.initialPrompt).byteLength > 65536)) {
    return yield* failure("invalid", "Invalid session input. The initial prompt must contain no NUL and fit within 64 KiB of UTF-8.")
  }
  const store = yield* ClientConfigStore, locator = yield* ProjectLocator, gateway = yield* ProjectSetupGateway
  const select = Effect.gen(function*() {
    const config = yield* inspectClient().pipe(Effect.provideService(ClientConfigStore, store))
    const adapters = config.adapters.filter(value => value.adapterId === input.toolId), adapter = adapters[0]
    if (adapters.length !== 1 || !adapter || !config.enabledAdapterIds.includes(input.toolId)) return yield* failure("selection", "Install and enable this tool before starting a session.")
    const local = yield* locator.locate(input.cwd, "auto")
    const folders: LocalProject[] = []
    for (const project of config.projects.filter(value => value.type === "directory")) {
      const registered = yield* locator.locate(project.path, "auto").pipe(Effect.catch(error => error.reason === "missing"
        ? Effect.succeed(undefined) : Effect.fail(error)))
      if (registered && covers(registered.requestedCwd, local.requestedCwd)) folders.push(project)
    }
    if (folders.length > 1 || local.type === "git" && folders.length > 0) {
      return yield* failure("selection", "Registered folders overlap this directory. Resolve the registrations before starting a session.")
    }
    let candidates: LocalProject[]
    if (local.type === "directory") candidates = folders
    else {
      if (!local.repositoryRemote || !config.activeInstanceOrigin) return yield* failure("selection", "Connect this Git repository and select its Instance before starting a session.")
      candidates = config.projects.filter(value => value.type === "git" && value.instanceOrigin === config.activeInstanceOrigin)
    }
    if (input.projectId !== undefined) candidates = candidates.filter(value => value.id === input.projectId)
    const eligible: LocalProject[] = [], workspaces = new Map<string, SetupWorkspace>(), matches = new Map<string, SetupProjectMatch>()
    for (const project of candidates) {
      let workspace = workspaces.get(project.instanceOrigin)
      if (!workspace) { workspace = yield* gateway.loadWorkspace(project.instanceOrigin); workspaces.set(project.instanceOrigin, workspace) }
      const remote = workspace.projects.find(value => value.id === project.id && value.teamId === project.teamId &&
        value.state === "active" && value.createdAt === project.createdAt && value.type === (project.type === "git" ? "git" : "folder"))
      if (workspace.user.id !== project.userId || !workspace.teams.some(team => team.id === project.teamId) || !remote) continue
      if (local.type === "git") {
        const key = JSON.stringify([project.instanceOrigin, project.teamId, project.userId])
        let match = matches.get(key)
        if (!match) { match = yield* gateway.matchGitProject(project.instanceOrigin, project.teamId, local.repositoryRemote!, project.userId); matches.set(key, match) }
        if (match.status !== "exact" || match.project.id !== project.id || match.project.createdAt !== project.createdAt || match.project.state !== "active") continue
      }
      eligible.push(project)
    }
    if (eligible.length !== 1) return yield* failure("selection", eligible.length === 0
      ? "No accessible registered Project matches this directory." : "Several Projects match this repository. Select one with --project.")
    return { project: eligible[0]!, adapter, local }
  }).pipe(Effect.mapError(error => error instanceof AgentSessionStartError ? error : failure(
    error.reason === "unauthenticated" ? "unauthenticated" : error.reason === "transport" ? "transport" : "selection", error.message)))
  const frozen = yield* select
  const runtime = yield* (yield* AdapterRuntimes).open(frozen.project, frozen.adapter)
  if (!runtime.newSession) return yield* failure("runtime", "This installed tool does not support controlled new sessions.")
  const revalidate = select.pipe(Effect.flatMap(current => JSON.stringify(current) === JSON.stringify(frozen)
    ? Effect.void : Effect.fail(failure("changed", "The directory, Project, permissions or tool changed before launch. Try again."))),
    Effect.mapError(error => new AdapterRuntimeError({ reason: "start", adapterId: input.toolId, retryable: false, message: error.message })))
  const result = yield* runtime.newSession.start({ origin: { cwd: frozen.local.requestedCwd,
    ...(frozen.local.repositoryRemote === undefined ? {} : { repositoryRemote: frozen.local.repositoryRemote }) },
    ...(input.initialPrompt === undefined ? {} : { initialPrompt: input.initialPrompt }), revalidate })
  return { project: frozen.project, adapter: frozen.adapter, ...result }
})
