import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { emptyClientConfig, type ClientConfig, type LocalProject } from "@atape/domain"
import { ClientConfigStore, ProjectLocator } from "./clientManagement.ts"
import { ProjectSetupGateway } from "./projectSetup.ts"
import { AdapterRuntimes } from "./collectorContracts.ts"
import { startAgentSession } from "./agentSessionStart.ts"

const project = (id = "p", overrides: Partial<LocalProject> = {}): LocalProject => ({ id, instanceOrigin: "https://one.invalid", userId: "u", teamId: "t", teamSlug: "team", teamName: "Team", name: id, type: "directory", path: "/work", createdAt: "2026-10-10T00:00:00Z", adapterIds: ["cursor"], ...overrides })
const fixture = (projects: LocalProject[] = [project()], git = false) => {
  let config: ClientConfig = { ...emptyClientConfig(), activeInstanceOrigin: "https://active.invalid", projects,
    enabledAdapterIds: ["cursor"], adapters: [{ adapterId: "cursor", packageName: "cursor-test", upgradeSpec: "cursor-test", displayName: "Cursor", version: "1", installedAt: "now", updatedAt: "now" }] }
  let remote = "git@github.com:example/repo.git", opened = 0, starts = 0, beforeRecord = () => {}
  const calls: string[] = []
  let lastPrompt: string | undefined, lastCwd: string | undefined
  const layer = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, ClientConfigStore.of({ transact: change => change(structuredClone(config)).pipe(Effect.map(result => result.value)) })),
    Layer.succeed(ProjectLocator, ProjectLocator.of({ locate: path => Effect.sync(() => ({ requestedCwd: path, path: git && path === "/work/sub" ? "/work" : path, name: "Work", type: git ? "git" as const : "directory" as const, ...(git ? { repositoryRemote: remote } : {}) })) })),
    Layer.succeed(ProjectSetupGateway, ProjectSetupGateway.of({
      loadWorkspace: instance => Effect.sync(() => { calls.push(instance); return { user: { id: "u", displayName: "User" }, teams: [...new Set(config.projects.map(p => p.teamId))].map(id => ({ id, slug: id, displayName: id, role: "owner" as const })), projects: config.projects.filter(p => p.instanceOrigin === instance).map(p => ({ id: p.id, teamId: p.teamId, name: p.name, type: p.type === "git" ? "git" as const : "folder" as const, state: "active" as const, repositoryLinkState: "unknown" as const, createdAt: p.createdAt, updatedAt: p.createdAt })) } }),
      matchGitProject: (instance, teamId) => Effect.succeed({ status: "exact" as const, project: { id: config.projects.find(p => p.instanceOrigin === instance && p.teamId === teamId)!.id, teamId, name: "Repo", type: "git" as const, state: "active" as const, repositoryLinkState: "linked" as const, createdAt: "2026-10-10T00:00:00Z", updatedAt: "now" } }),
      createProject: () => Effect.die("Start must never create Projects")
    })),
    Layer.succeed(AdapterRuntimes, AdapterRuntimes.of({ open: () => Effect.sync(() => { opened++; return {
      collect: () => Effect.die("Start must never collect"), newSession: { start: request => Effect.gen(function*() {
        starts++; lastPrompt = request.initialPrompt; lastCwd = request.origin.cwd; beforeRecord(); yield* request.revalidate
        return { sourceId: "fresh", creation: "confirmed" as const, exitCode: 0 }
      }) }
    } }) }))
  )
  return { calls, run: (input: Parameters<typeof startAgentSession>[0]) => Effect.runPromise(Effect.scoped(startAgentSession(input)).pipe(Effect.provide(layer))),
    setRemote: (value: string) => { remote = value }, change: (value: (c: ClientConfig) => ClientConfig) => { config = value(config) },
    beforeRecord: (value: () => void) => { beforeRecord = value }, observed: () => ({ opened, starts, lastPrompt, lastCwd }) }
}
const input = { toolId: "cursor", cwd: "/work/sub" }
describe("controlled session selection", () => {
  it("uses the unique folder's own Instance and preserves empty/literal prompt", async () => {
    const f = fixture(); await f.run({ ...input, initialPrompt: "" }); expect(f.calls).toEqual(["https://one.invalid", "https://one.invalid"])
    expect(f.observed()).toMatchObject({ lastPrompt: "", lastCwd: "/work/sub" })
  })
  it("rejects folder overlap even with explicit Project", async () => {
    const f = fixture([project(), project("other", { instanceOrigin: "https://two.invalid", path: "/work/sub" })])
    await expect(f.run({ ...input, projectId: "p" })).rejects.toThrow("overlap")
    expect(f.observed().opened).toBe(0)
  })
  it("rejects Git covered by a registered folder", async () => {
    const f = fixture([project()], true); await expect(f.run(input)).rejects.toThrow("overlap")
  })
  it("requires an explicit choice for matching Git Projects across Teams", async () => {
    const f = fixture([project("a", { type: "git", instanceOrigin: "https://active.invalid", teamId: "a" }), project("b", { type: "git", instanceOrigin: "https://active.invalid", teamId: "b" })], true)
    await expect(f.run(input)).rejects.toThrow("Several Projects")
    await expect(f.run({ ...input, projectId: "b" })).resolves.toMatchObject({ project: { id: "b" } })
    expect(f.observed().lastCwd).toBe("/work/sub")
  })
  it.each(["remote", "disabled", "permission"])("rejects %s changes before recording", async kind => {
    const f = fixture([project("p", { type: "git", instanceOrigin: "https://active.invalid" })], true)
    f.beforeRecord(() => kind === "remote" ? f.setRemote("git@github.com:other/repo.git") : f.change(c => ({ ...c, ...(kind === "disabled" ? { enabledAdapterIds: [] } : { projects: c.projects.map(p => ({ ...p, userId: "changed" })) }) })))
    await expect(f.run(input)).rejects.toThrow()
  })
  it.each(["a\0b", "中".repeat(21846), "a".repeat(65537)])("validates prompt bytes/NUL before opening services", async initialPrompt => {
    const f = fixture(); await expect(f.run({ ...input, initialPrompt })).rejects.toThrow("64 KiB")
    expect(f.calls).toEqual([]); expect(f.observed().opened).toBe(0)
  })
  it("accepts the exact 64 KiB UTF-8 prompt without trimming", async () => {
    const f = fixture(), initialPrompt = " "+"a".repeat(65535); await f.run({ ...input, initialPrompt }); expect(f.observed().lastPrompt).toBe(initialPrompt)
  })
})
