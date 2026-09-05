import {
  ProjectSetupGateway,
  ProjectSetupGatewayError,
  type CreateRemoteProject,
  type SetupProjectMatch,
  type SetupRemoteProject,
  type SetupWorkspace
} from "@atape/application"
import { randomUUID } from "node:crypto"
import { Effect, Layer, Schema } from "effect"
import {
  AuthenticatedHTTPClient,
  AuthenticatedHTTPError,
  type AuthenticatedHTTPResponse
} from "./authenticatedHTTPClient.ts"

const WireUser = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  avatarUrl: Schema.String
})
const WireTeam = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  displayName: Schema.String,
  membership: Schema.Struct({ role: Schema.Literals(["owner", "member"]) }),
  createdAt: Schema.String,
  updatedAt: Schema.String
})
const WireProject = Schema.Struct({
  id: Schema.String,
  teamId: Schema.String,
  type: Schema.Literals(["git", "folder"]),
  name: Schema.String,
  state: Schema.Literals(["active", "archived"]),
  repositoryIdentity: Schema.optionalKey(Schema.String),
  capturedThrough: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String
})
const WireWorkspace = Schema.Struct({
  teams: Schema.Array(WireTeam),
  projects: Schema.Array(WireProject)
})
const WireProjectMatch = Schema.Union([
  Schema.Struct({ status: Schema.Literal("none") }),
  Schema.Struct({ status: Schema.Literal("exact"), project: WireProject })
])

export const makeProjectSetupGatewayLayer = () => Layer.effect(
  ProjectSetupGateway,
  Effect.gen(function*() {
    const client = yield* AuthenticatedHTTPClient
    return ProjectSetupGateway.of({
      loadWorkspace: (instanceOrigin) => Effect.gen(function*() {
        const userResponse = yield* client.request({
          instanceOrigin, path: "/api/v1/users/me", method: "GET"
        }).pipe(Effect.mapError(gatewayTransportError))
        const user = yield* expectDecoded(userResponse, 200, WireUser, "current User")
        const workspaceResponse = yield* client.request({
          instanceOrigin,
          expectedUserId: user.id,
          path: "/api/v1/workspace",
          method: "GET"
        }).pipe(Effect.mapError(gatewayTransportError))
        const workspace = yield* expectDecoded(workspaceResponse, 200, WireWorkspace, "Workspace")
        return {
          user: { id: user.id, displayName: user.displayName },
          teams: workspace.teams.map((team) => ({
            id: team.id,
            slug: team.slug,
            displayName: team.displayName,
            role: team.membership.role
          })),
          projects: workspace.projects.map(projectFromWire)
        } satisfies SetupWorkspace
      }),
      matchGitProject: (instanceOrigin, teamId, remote) => client.request({
        instanceOrigin,
        path: "/api/v1/project-matches",
        method: "POST",
        body: { teamId, type: "git", remote }
      }).pipe(
        Effect.mapError(gatewayTransportError),
        Effect.flatMap((response) => expectDecoded(response, 200, WireProjectMatch, "Project match")),
        Effect.map((match): SetupProjectMatch => match.status === "none"
          ? match
          : { status: "exact", project: projectFromWire(match.project) })
      ),
      createProject: (instanceOrigin, teamSlug, project) => {
        const idempotencyKey = randomUUID()
        const request = client.request({
          instanceOrigin,
          path: `/api/v1/teams/${encodeURIComponent(teamSlug)}/projects`,
          method: "POST",
          body: projectBody(project),
          idempotencyKey
        })
        return retryNetworkOnce(request).pipe(
          Effect.mapError(gatewayTransportError),
          Effect.flatMap((response) => expectDecoded(response, 201, WireProject, "Project creation")),
          Effect.map(projectFromWire)
        )
      }
    })
  })
)

const projectBody = (project: CreateRemoteProject) => project.type === "git"
  ? { type: "git", remote: project.remote }
  : { type: "folder", name: project.name }

const projectFromWire = (project: typeof WireProject.Type): SetupRemoteProject => ({
  id: project.id,
  teamId: project.teamId,
  type: project.type,
  name: project.name,
  state: project.state,
  ...(project.repositoryIdentity === undefined ? {} : { repositoryIdentity: project.repositoryIdentity }),
  createdAt: project.createdAt,
  updatedAt: project.updatedAt
})

const expectDecoded = <A, I>(
  response: AuthenticatedHTTPResponse,
  expectedStatus: number,
  schema: Schema.Codec<A, I>,
  resource: string
): Effect.Effect<A, ProjectSetupGatewayError> => {
  if (response.status !== expectedStatus) return Effect.fail(statusError(response.status, resource))
  return Schema.decodeUnknownEffect(schema)(response.body).pipe(
    Effect.mapError(() => new ProjectSetupGatewayError({
      reason: "decode", message: `The ATape ${resource} response was invalid.`
    }))
  )
}

const statusError = (status: number, resource: string) => new ProjectSetupGatewayError({
  reason: status === 401 ? "unauthenticated"
    : status === 403 ? "forbidden"
    : status === 404 ? "not_found"
    : status === 409 ? "conflict"
    : status >= 500 ? "unavailable"
    : "decode",
  message: status === 401
    ? "The CLI credential is no longer valid; run `atape login` again."
    : `The ATape ${resource} request was rejected (${status}).`
})

const gatewayTransportError = (error: AuthenticatedHTTPError) => new ProjectSetupGatewayError({
  reason: error.reason === "unauthenticated" || error.reason === "identity_changed"
    ? "unauthenticated"
    : error.reason === "network" ? "transport" : "decode",
  message: error.message
})

const retryNetworkOnce = <A>(
  effect: Effect.Effect<A, AuthenticatedHTTPError>
): Effect.Effect<A, AuthenticatedHTTPError> => effect.pipe(Effect.matchEffect({
  onFailure: (error) => error.reason === "network" ? effect : Effect.fail(error),
  onSuccess: Effect.succeed
}))
