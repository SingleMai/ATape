import { describe, expect, it } from "vitest"
import { selectDefaultWorkspaceProject, type Workspace } from "./workspace.ts"

describe("Workspace entry selection", () => {
  it("returns no target before the first Project is captured", () => {
    expect(selectDefaultWorkspaceProject({ teams: [] })).toBeUndefined()
    expect(selectDefaultWorkspaceProject({
      teams: [{ id: "team-a", name: "Team A", projects: [] }]
    })).toBeUndefined()
  })

  it("opens the most recently captured Project across Teams", () => {
    const workspace: Workspace = {
      teams: [{
        id: "team-a",
        name: "Team A",
        projects: [{
          id: "older",
          name: "Older",
          type: "git",
          capturedThrough: "2026-09-04T12:00:00Z",
          sessionCount: 3,
          activeSessionCount: 0
        }]
      }, {
        id: "team-b",
        name: "Team B",
        projects: [{
          id: "newer",
          name: "Newer",
          type: "directory",
          capturedThrough: "2026-09-05T12:00:00Z",
          sessionCount: 1,
          activeSessionCount: 1
        }]
      }]
    }

    expect(selectDefaultWorkspaceProject(workspace)).toEqual({ teamId: "team-b", projectId: "newer" })
  })

  it("uses stable identity ordering when capture timestamps are unavailable or equal", () => {
    const workspace: Workspace = {
      teams: [{
        id: "team-z",
        name: "Team Z",
        projects: [{
          id: "project-z",
          name: "Project Z",
          type: "git",
          capturedThrough: "not-a-date",
          sessionCount: 0,
          activeSessionCount: 0
        }]
      }, {
        id: "team-a",
        name: "Team A",
        projects: [{
          id: "project-a",
          name: "Project A",
          type: "git",
          sessionCount: 0,
          activeSessionCount: 0
        }]
      }]
    }

    expect(selectDefaultWorkspaceProject(workspace)).toEqual({ teamId: "team-a", projectId: "project-a" })
  })
})
