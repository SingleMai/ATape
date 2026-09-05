import type { CLIIdentity, LocalProject } from "@atape/domain"
import { Context, Effect, Schema } from "effect"
import {
  ProjectLocator,
  setupProject,
  type ClientConfigStore,
  type LocatedProject
} from "./clientManagement.ts"

export class ProjectSetupGatewayError extends Schema.TaggedError<ProjectSetupGatewayError>()(
  "ProjectSetupGatewayError",
  {
    reason: Schema.Literals([
      "unauthenticated",
      "forbidden",
      "not_found",
      "conflict",
      "transport",
      "decode",
      "unavailable"
    ]),
    message: Schema.String
  }
) {}

export class ProjectSetupError extends Schema.TaggedError<ProjectSetupError>()("ProjectSetupError", {
  reason: Schema.Literals([
    "missing_git_remote",
    "no_team",
    "invalid_selection",
    "changed",
    "unsupported"
  ]),
  message: Schema.String
}) {}

export type SetupTeam = {
  readonly id: string
  readonly slug: string
  readonly displayName: string
  readonly role: "owner" | "member"
}

export type SetupRemoteProject = {
  readonly id: string
  readonly teamId: string
  readonly type: "git" | "folder"
  readonly name: string
  readonly state: "active" | "archived"
  readonly repositoryIdentity?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export type SetupWorkspace = {
  readonly user: CLIIdentity
  readonly teams: ReadonlyArray<SetupTeam>
  readonly projects: ReadonlyArray<SetupRemoteProject>
}

export type SetupProjectMatch =
  | { readonly status: "none" }
  | { readonly status: "exact"; readonly project: SetupRemoteProject }

export type CreateRemoteProject =
  | { readonly type: "git"; readonly remote: string }
  | { readonly type: "folder"; readonly name: string }

export class ProjectSetupGateway extends Context.Service<ProjectSetupGateway, {
  loadWorkspace(instanceOrigin: string): Effect.Effect<SetupWorkspace, ProjectSetupGatewayError>
  matchGitProject(
    instanceOrigin: string,
    teamId: string,
    remote: string
  ): Effect.Effect<SetupProjectMatch, ProjectSetupGatewayError>
  createProject(
    instanceOrigin: string,
    teamSlug: string,
    project: CreateRemoteProject
  ): Effect.Effect<SetupRemoteProject, ProjectSetupGatewayError>
}>()("atape/application/ProjectSetupGateway") {}

export type ProjectSetupPlan = {
  readonly instanceOrigin: string
  readonly user: CLIIdentity
  readonly local: LocatedProject
  readonly teams: ReadonlyArray<SetupTeam>
  readonly exactMatches: ReadonlyArray<{
    readonly team: SetupTeam
    readonly project: SetupRemoteProject
  }>
}

export type ProjectSetupSelection =
  | {
    readonly mode: "exact"
    readonly teamId: string
    readonly projectId: string
    readonly adapterIds?: ReadonlyArray<string>
  }
  | {
    readonly mode: "create"
    readonly teamId: string
    readonly name?: string
    readonly adapterIds?: ReadonlyArray<string>
  }

export type ProjectSetupOutcome = {
  readonly project: LocalProject
  readonly createdLocally: boolean
  readonly createdRemotely: boolean
}

export const planProjectSetup = Effect.fn("ProjectSetup.plan")(function*(input: {
  readonly instanceOrigin: string
  readonly path: string
  readonly type?: "auto" | "git" | "directory"
}) {
  const locator = yield* ProjectLocator
  const gateway = yield* ProjectSetupGateway
  const local = yield* locator.locate(input.path, input.type ?? "auto")
  if (local.type === "git" && local.repositoryRemote === undefined) {
    return yield* new ProjectSetupError({
      reason: "missing_git_remote",
      message: "This Git worktree has no origin remote. Add one or use --type directory explicitly."
    })
  }
  const workspace = yield* gateway.loadWorkspace(input.instanceOrigin)
  const teams = workspace.teams
    .slice()
    .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.id.localeCompare(right.id))
  if (teams.length === 0) {
    return yield* new ProjectSetupError({
      reason: "no_team",
      message: "Create or join a Team in the ATape web app before configuring this directory."
    })
  }
  const exactMatches = local.type === "git"
    ? (yield* Effect.forEach(teams, (team) => gateway.matchGitProject(
      input.instanceOrigin,
      team.id,
      local.repositoryRemote as string
    ).pipe(Effect.map((match) => ({ team, match }))), { concurrency: 4 }))
      .flatMap(({ team, match }) => match.status === "exact" ? [{ team, project: match.project }] : [])
    : []
  return {
    instanceOrigin: input.instanceOrigin,
    user: workspace.user,
    local,
    teams,
    exactMatches
  } satisfies ProjectSetupPlan
})

export const applyProjectSetup = Effect.fn("ProjectSetup.apply")(function*(
  plan: ProjectSetupPlan,
  selection: ProjectSetupSelection
) {
  const locator = yield* ProjectLocator
  const gateway = yield* ProjectSetupGateway
  const currentLocal = yield* locator.locate(plan.local.path, plan.local.type)
  if (currentLocal.path !== plan.local.path || currentLocal.type !== plan.local.type ||
    currentLocal.repositoryRemote !== plan.local.repositoryRemote) {
    return yield* new ProjectSetupError({
      reason: "changed",
      message: "The local directory or its Git origin changed during setup; start setup again."
    })
  }
  const workspace = yield* gateway.loadWorkspace(plan.instanceOrigin)
  if (workspace.user.id !== plan.user.id) {
    return yield* new ProjectSetupError({
      reason: "changed",
      message: "The signed-in account changed during setup; start setup again."
    })
  }
  const team = workspace.teams.find((candidate) => candidate.id === selection.teamId)
  if (team === undefined) {
    return yield* new ProjectSetupError({
      reason: "invalid_selection",
      message: "The selected Team is no longer available to this account."
    })
  }

  let remote: SetupRemoteProject
  let createdRemotely = false
  if (selection.mode === "exact") {
    if (currentLocal.type !== "git" || currentLocal.repositoryRemote === undefined) {
      return yield* new ProjectSetupError({
        reason: "unsupported", message: "Only a Git directory can attach to an exact repository match."
      })
    }
    const match = yield* gateway.matchGitProject(
      plan.instanceOrigin,
      team.id,
      currentLocal.repositoryRemote
    )
    if (match.status !== "exact" || match.project.id !== selection.projectId || match.project.state !== "active") {
      return yield* new ProjectSetupError({
        reason: "changed", message: "The matching Project changed during setup; start setup again."
      })
    }
    remote = match.project
  } else {
    const name = (selection.name ?? currentLocal.name).trim()
    if (name === "" || name.length > 200 || /[\r\n\0]/.test(name)) {
      return yield* new ProjectSetupError({
        reason: "invalid_selection", message: "The Project name must be between 1 and 200 characters."
      })
    }
    remote = yield* gateway.createProject(
      plan.instanceOrigin,
      team.slug,
      currentLocal.type === "git"
        ? { type: "git", remote: currentLocal.repositoryRemote as string }
        : { type: "folder", name }
    )
    createdRemotely = true
  }
  if (remote.teamId !== team.id || remote.state !== "active" ||
    (currentLocal.type === "git" && remote.type !== "git") ||
    (currentLocal.type === "directory" && remote.type !== "folder")) {
    return yield* new ProjectSetupError({
      reason: "changed", message: "The server returned a Project outside the selected setup scope."
    })
  }
  const local = yield* setupProject({
    path: currentLocal.path,
    instanceOrigin: plan.instanceOrigin,
    userId: workspace.user.id,
    teamId: team.id,
    teamSlug: team.slug,
    teamName: team.displayName,
    projectId: remote.id,
    name: remote.name,
    createdAt: remote.createdAt,
    type: currentLocal.type,
    ...(selection.adapterIds === undefined ? {} : { adapterIds: selection.adapterIds })
  })
  return {
    project: local.project,
    createdLocally: local.created,
    createdRemotely
  } satisfies ProjectSetupOutcome
})

export type ProjectSetupRequirements =
  ProjectLocator | ProjectSetupGateway | ClientConfigStore
