import { describe, expect, it } from "vitest"
import {
  selectDefaultWorkspaceProject,
  selectDefaultWorkspaceTeam,
  type Workspace
} from "./workspace.ts"

describe("Workspace entry selection", () => {
  it("returns no target before the first Project is captured", () => {
    expect(selectDefaultWorkspaceProject({ teams: [] })).toBeUndefined()
    expect(selectDefaultWorkspaceProject({
      teams: [{ id: "team-a", slug: "team-a", name: "Team A", role: "owner", projects: [] }]
    })).toBeUndefined()
  })

  it("opens the most recently captured Project across Teams", () => {
    const workspace: Workspace = {
      teams: [{
        id: "team-a",
        slug: "team-a",
        name: "Team A",
        role: "owner",
        projects: [{
          id: "older",
          name: "Older",
          type: "git",
          repositoryLinkState: "linked",
          capturedThrough: "2026-09-04T12:00:00Z",
          sessionCount: 3,
          activeSessionCount: 0
        }]
      }, {
        id: "team-b",
        slug: "team-b",
        name: "Team B",
        role: "member",
        projects: [{
          id: "newer",
          name: "Newer",
          type: "directory",
          repositoryLinkState: "not_applicable",
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
        slug: "team-z",
        name: "Team Z",
        role: "owner",
        projects: [{
          id: "project-z",
          name: "Project Z",
          type: "git",
          repositoryLinkState: "linked",
          capturedThrough: "not-a-date",
          sessionCount: 0,
          activeSessionCount: 0
        }]
      }, {
        id: "team-a",
        slug: "team-a",
        name: "Team A",
        role: "member",
        projects: [{
          id: "project-a",
          name: "Project A",
          type: "git",
          repositoryLinkState: "unknown",
          sessionCount: 0,
          activeSessionCount: 0
        }]
      }]
    }

    expect(selectDefaultWorkspaceProject(workspace)).toEqual({ teamId: "team-a", projectId: "project-a" })
  })

  it("selects a stable Team before any Project is captured", () => {
    expect(selectDefaultWorkspaceTeam({ teams: [] })).toBeUndefined()
    expect(selectDefaultWorkspaceTeam({
      teams: [{
        id: "team-z",
        slug: "team-z",
        name: "Team Z",
        role: "owner",
        projects: []
      }, {
        id: "team-a",
        slug: "team-a",
        name: "Team A",
        role: "member",
        projects: []
      }]
    })).toEqual({ teamId: "team-a" })
  })
})
