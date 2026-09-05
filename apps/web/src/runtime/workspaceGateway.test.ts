import { WorkspaceGateway, openWorkspace } from "@atape/application"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BrowserWorkspaceGatewayLayer } from "./workspaceGateway.ts"

describe("browser Workspace Gateway Adapter", () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("translates the flat HTTP read model without leaking transport shape", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      teams: [{
        id: "team-id",
        slug: "team-a",
        displayName: "Team A",
        membership: { role: "owner" },
        createdAt: "2026-09-05T00:00:00Z",
        updatedAt: "2026-09-05T00:00:00Z"
      }],
      projects: [{
        id: "project-active",
        teamId: "team-id",
        type: "folder",
        name: "Notes",
        state: "active",
        repositoryLinkState: "not_applicable",
        capturedThrough: "2026-09-05T02:00:00Z",
        createdAt: "2026-09-05T00:00:00Z",
        updatedAt: "2026-09-05T00:00:00Z"
      }, {
        id: "project-archived",
        teamId: "team-id",
        type: "git",
        name: "Old",
        state: "archived",
        repositoryLinkState: "linked",
        createdAt: "2026-09-05T00:00:00Z",
        updatedAt: "2026-09-05T00:00:00Z"
      }]
    }), { status: 200 }))

    const value = await openWorkspace().pipe(
      Effect.provide(BrowserWorkspaceGatewayLayer),
      Effect.runPromise
    )

    expect(value).toEqual({
      teams: [{
        id: "team-id",
        slug: "team-a",
        name: "Team A",
        role: "owner",
        projects: [{
          id: "project-active",
          name: "Notes",
          type: "directory",
          repositoryLinkState: "not_applicable",
          capturedThrough: "2026-09-05T02:00:00Z",
          sessionCount: 0,
          activeSessionCount: 0
        }]
      }]
    })
  })

  it("reports malformed transport data as a typed decode failure", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ teams: [], projects: "invalid" }), { status: 200 }))

    await expect(openWorkspace().pipe(
      Effect.provide(BrowserWorkspaceGatewayLayer),
      Effect.runPromise
    )).rejects.toMatchObject({ reason: "decode" })
  })

  it("provides the same Interface used by Workspace callers", async () => {
    const service = await Effect.runPromise(WorkspaceGateway.pipe(
      Effect.provide(BrowserWorkspaceGatewayLayer)
    ))
    expect(service.open).toBeTypeOf("function")
  })
})
