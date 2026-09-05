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
  slug: Schema.String,
  name: Schema.String,
  role: Schema.Literals(["owner", "member"]),
  projects: Schema.Array(WorkspaceProject)
})
export type WorkspaceTeam = typeof WorkspaceTeam.Type

export const Workspace = Schema.Struct({
  teams: Schema.Array(WorkspaceTeam)
})
export type Workspace = typeof Workspace.Type

export type WorkspaceProjectTarget = {
  readonly teamId: string
  readonly projectId: string
}

// The Workspace landing route uses the most recently captured Project rather
// than coupling first entry to demo data or server ordering.
export const selectDefaultWorkspaceProject = (
  workspace: Workspace
): WorkspaceProjectTarget | undefined => {
  let selected: (WorkspaceProjectTarget & { readonly capturedAt: number; readonly key: string }) | undefined
  for (const team of workspace.teams) {
    for (const project of team.projects) {
      const parsed = project.capturedThrough === undefined ? Number.NEGATIVE_INFINITY : Date.parse(project.capturedThrough)
      const capturedAt = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
      const key = `${team.id}\0${project.id}`
      if (selected === undefined || capturedAt > selected.capturedAt ||
        (capturedAt === selected.capturedAt && key.localeCompare(selected.key) < 0)) {
        selected = { teamId: team.id, projectId: project.id, capturedAt, key }
      }
    }
  }
  return selected === undefined ? undefined : { teamId: selected.teamId, projectId: selected.projectId }
}
