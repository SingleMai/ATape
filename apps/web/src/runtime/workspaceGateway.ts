import { WorkspaceGateway, WorkspaceGatewayError } from "@atape/application"
import { Workspace as WorkspaceSchema, type Workspace } from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import { BrowserHTTPError, browserRequest } from "./http"

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
  repositoryLinkState: Schema.Literals(["unknown", "linked", "not_applicable"]),
  repositoryIdentity: Schema.optionalKey(Schema.String),
  capturedThrough: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String
})

const WireWorkspace = Schema.Struct({
  teams: Schema.Array(WireTeam),
  projects: Schema.Array(WireProject)
})

const gatewayError = (error: BrowserHTTPError): WorkspaceGatewayError => new WorkspaceGatewayError({
  reason: error.reason === "transport" ? "transport" : error.reason === "decode" ? "decode" : "http",
  message: error.message,
  ...(error.status === undefined ? {} : { status: error.status })
})

const open = browserRequest("/api/v1/workspace").pipe(
  Effect.mapError(gatewayError),
  Effect.flatMap((payload) => Schema.decodeUnknownEffect(WireWorkspace)(payload).pipe(
    Effect.mapError(() => new WorkspaceGatewayError({
      reason: "decode",
      message: "The Workspace response did not match the ATape protocol."
    }))
  )),
  Effect.map((wire): Workspace => ({
    teams: wire.teams.map((team) => ({
      id: team.id,
      slug: team.slug,
      name: team.displayName,
      role: team.membership.role,
      projects: wire.projects
        .filter((project) => project.teamId === team.id && project.state === "active")
        .map((project) => ({
          id: project.id,
          name: project.name,
          type: project.type === "folder" ? "directory" : "git",
          repositoryLinkState: project.repositoryLinkState,
          ...(project.capturedThrough === undefined ? {} : { capturedThrough: project.capturedThrough }),
          sessionCount: 0,
          activeSessionCount: 0
        }))
    }))
  })),
  Effect.flatMap((workspace) => Schema.decodeUnknownEffect(WorkspaceSchema)(workspace).pipe(
    Effect.mapError(() => new WorkspaceGatewayError({
      reason: "decode",
      message: "The Workspace response could not be normalized safely."
    }))
  ))
)

export const BrowserWorkspaceGatewayLayer = Layer.succeed(
  WorkspaceGateway,
  WorkspaceGateway.of({ open: () => open })
)
