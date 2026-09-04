import { Schema } from "effect"

export const ProjectType = Schema.Literals(["git", "directory"])
export type ProjectType = typeof ProjectType.Type

export const WorkspaceProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: ProjectType,
  capturedThrough: Schema.optionalKey(Schema.String),
  sessionCount: Schema.Number,
  activeSessionCount: Schema.Number
})
export type WorkspaceProject = typeof WorkspaceProject.Type

export const WorkspaceTeam = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  projects: Schema.Array(WorkspaceProject)
})
export type WorkspaceTeam = typeof WorkspaceTeam.Type

export const Workspace = Schema.Struct({
  teams: Schema.Array(WorkspaceTeam)
})
export type Workspace = typeof Workspace.Type
