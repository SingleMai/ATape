import type { GitSource, GitSourceDecision, LocalProject } from "@atape/domain"
import { Context, Effect, Layer, Schema } from "effect"
import { ProjectLocator } from "./clientManagement.ts"
import { ProjectSetupGateway, type SetupProjectMatch } from "./projectSetup.ts"

export class GitAttributionError extends Schema.TaggedError<GitAttributionError>()("GitAttributionError", {
  reason: Schema.Literals(["io", "unauthenticated", "transport", "contract"]),
  message: Schema.String
}) {}

export const GitSourceBinding = Schema.Struct({
  version: Schema.Literal(1),
  originKey: Schema.String,
  cwd: Schema.String,
  metadataRemote: Schema.optionalKey(Schema.String),
  remote: Schema.String
})
export type GitSourceBinding = typeof GitSourceBinding.Type
export type GitBindingScope = Pick<LocalProject, "instanceOrigin" | "userId" | "id" | "createdAt"> & {
  readonly adapterId: string
}

export class GitSourceBindings extends Context.Service<GitSourceBindings, {
  read(scope: GitBindingScope, sourceId: string): Effect.Effect<GitSourceBinding | undefined, GitAttributionError>
  // Returns the atomically established winner, never replaces older evidence.
  remember(scope: GitBindingScope, sourceId: string, binding: GitSourceBinding): Effect.Effect<GitSourceBinding, GitAttributionError>
}>()("atape/application/GitSourceBindings") {}

export type GitSourceResolver = (source: GitSource) => Effect.Effect<GitSourceDecision, GitAttributionError>
export class GitSourceAttribution extends Context.Service<GitSourceAttribution, {
  // A fresh resolver owns bounded caches for one collection call.
  forProject(project: LocalProject, adapterId: string): GitSourceResolver
}>()("atape/application/GitSourceAttribution") {}

export const makeGitSourceAttributionLayer = () => Layer.effect(GitSourceAttribution, Effect.gen(function*() {
  const locator = yield* ProjectLocator
  const gateway = yield* ProjectSetupGateway
  const bindings = yield* GitSourceBindings
  return GitSourceAttribution.of({
    forProject: (project, adapterId) => {
      const origins = new Map<string, string | undefined>()
      const matches = new Map<string, SetupProjectMatch | undefined>()
      const scope: GitBindingScope = { ...project, adapterId }
      const findOrigin = (cwd: string) => origins.has(cwd)
        ? Effect.succeed(origins.get(cwd))
        : locator.locate(cwd, "git").pipe(
          Effect.map(local => local.repositoryRemote),
          Effect.catch(error => error.reason === "missing" || error.reason === "not_git" || error.reason === "not_directory"
            ? Effect.succeed(undefined)
            : Effect.fail(new GitAttributionError({ reason: "io", message: "Could not inspect a source's original Git repository." }))),
          Effect.tap(remote => Effect.sync(() => boundedSet(origins, cwd, remote)))
        )
      const matchRemote = (remote: string) => matches.has(remote)
        ? Effect.succeed(matches.get(remote))
        : gateway.matchGitProject(project.instanceOrigin, project.teamId, remote, project.userId).pipe(
          Effect.catch(error => error.reason === "invalid_remote"
            ? Effect.succeed(undefined)
            : Effect.fail(new GitAttributionError({
              reason: error.reason === "unauthenticated" ? "unauthenticated"
                : error.reason === "transport" || error.reason === "unavailable" ? "transport" : "contract",
              message: error.message
            }))),
          Effect.tap(match => Effect.sync(() => boundedSet(matches, remote, match)))
        )

      return (source) => Effect.gen(function*() {
        if (project.type !== "git" || !source.sourceId || !source.originKey || !source.cwd ||
          [source.sourceId, source.originKey, source.cwd, source.repositoryRemote ?? ""].some(value =>
            value.length > 4096 || /[\r\n\0]/.test(value))) return "unknown" as const
        const previous = yield* bindings.read(scope, source.sourceId)
        if (previous && !sameOrigin(previous, source)) return "unknown" as const
        const remote = previous?.remote ?? source.repositoryRemote ?? (yield* findOrigin(source.cwd))
        if (!remote) return "unknown" as const
        const match = yield* matchRemote(remote)
        if (match === undefined) return "unknown" as const
        if (match.status === "none" || match.project.id !== project.id) return "excluded" as const
        if (match.project.type !== "git" || match.project.teamId !== project.teamId || match.project.state !== "active") {
          return yield* new GitAttributionError({ reason: "contract", message: "The Git Project match is no longer active in the configured Team." })
        }
        if (!previous) {
          const winner = yield* bindings.remember(scope, source.sourceId, {
            version: 1, originKey: source.originKey, cwd: source.cwd, remote,
            ...(source.repositoryRemote === undefined ? {} : { metadataRemote: source.repositoryRemote })
          })
          if (!sameOrigin(winner, source) || winner.remote !== remote) return "unknown" as const
        }
        return "included" as const
      })
    }
  })
}))

const sameOrigin = (binding: GitSourceBinding, source: GitSource) =>
  binding.originKey === source.originKey && binding.cwd === source.cwd && binding.metadataRemote === source.repositoryRemote

const boundedSet = <A>(map: Map<string, A>, key: string, value: A) => {
  if (map.size >= 256) map.clear()
  map.set(key, value)
}
