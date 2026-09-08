import { CLISetupPlatform } from "@atape/application"
import { AdapterProtocolVersion, GitAttributionVersion } from "@atape/domain"
import { Effect } from "effect"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { defaultNodeClientPaths } from "./clientLayers.ts"
import { makeCLISetupPlatformLayer } from "./cliSetupPlatform.ts"
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "atape-guided-"))
  roots.push(root)
  const environment = { ATAPE_HOME: root, ATAPE_CODEX_HOME: join(root, "codex"), ATAPE_CLAUDE_HOME: join(root, "missing-claude") }
  const paths = defaultNodeClientPaths(environment)
  const layer = makeCLISetupPlatformLayer(paths, environment)
  return { root, paths, run: <A, E>(effect: Effect.Effect<A, E, CLISetupPlatform>) => Effect.runPromise(effect.pipe(Effect.provide(layer))) }
}
describe("Node guided setup Adapter", () => {
  it("suggests Unicode/space directories and detects only known source roots", async () => {
    const client = await fixture()
    await Promise.all([mkdir(join(client.root, "codex")), mkdir(join(client.root, "项目 space")), mkdir(join(client.root, "unrelated"))])
    const result = await client.run(Effect.gen(function*() {
      const platform = yield* CLISetupPlatform
      return { detected: yield* platform.detectSources(), suggestions: yield* platform.suggestDirectories(join(client.root, "项")) }
    }))
    expect(result.detected).toEqual(["codex"])
    expect(result.suggestions).toEqual([{ path: join(client.root, "项目 space") + "/", git: false }])
  })
  it("browses a complete path without a trailing slash and marks repositories and worktrees", async () => {
    const client = await fixture()
    const repo = join(client.root, "repo")
    const worktree = join(client.root, "worktree")
    await mkdir(join(repo, ".git"), { recursive: true })
    await mkdir(worktree)
    await writeFile(join(worktree, ".git"), "gitdir: /other/repo/.git/worktrees/feature")
    await mkdir(join(client.root, "folder"))
    const suggestions = await client.run(Effect.gen(function*() {
      return yield* (yield* CLISetupPlatform).suggestDirectories(client.root)
    }))
    expect(suggestions).toEqual([
      { path: dirname(client.root) + "/", git: false, parent: true },
      { path: join(client.root, "folder") + "/", git: false },
      { path: repo + "/", git: true },
      { path: worktree + "/", git: true }
    ])
  })
  it("reuses a durable, account-scoped creation key across concurrent retries", async () => {
    const client = await fixture()
    const scope = { instanceOrigin: "https://atape.net", userId: "user-1", teamId: "team-1", path: "/work/project", name: "Project" }
    const key = (userId = scope.userId) => client.run(Effect.gen(function*() {
      return yield* (yield* CLISetupPlatform).creationKey({ ...scope, userId })
    }))
    const first = await Promise.all([key(), key(), key()])
    expect(new Set(first).size).toBe(1)
    expect(await key()).toBe(first[0])
    expect(await key("another-user")).not.toBe(first[0])
  })
  it("checks the actual installed capability and package identity", async () => {
    const client = await fixture()
    const directory = join(client.paths.adapterDirectory, "node_modules", "adapter")
    await mkdir(directory, { recursive: true })
    const adapter = { packageName: "adapter", version: "1.0.0", adapterId: "codex", displayName: "Codex", upgradeSpec: "adapter", installedAt: "now", updatedAt: "now" }
    const manifest = { name: "adapter", version: "1.0.0", atapeAdapter: { protocolVersion: AdapterProtocolVersion,
      adapterId: "codex", displayName: "Codex", entry: "./index.js", harnesses: ["codex"] } }
    const supported = () => client.run(Effect.gen(function*() { return yield* (yield* CLISetupPlatform).supportsGit(adapter) }))
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest))
    expect(await supported()).toBe(false)
    await writeFile(join(directory, "package.json"), JSON.stringify({ ...manifest, atapeAdapter: { ...manifest.atapeAdapter, gitAttribution: GitAttributionVersion } }))
    expect(await supported()).toBe(true)
  })
})
