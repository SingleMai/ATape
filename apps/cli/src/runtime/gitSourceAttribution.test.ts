import {
  GitSourceAttribution, GitSourceBindings, GitAttributionError,
  ProjectSetupGateway, ProjectSetupGatewayError, makeGitSourceAttributionLayer,
  type GitBindingScope, type SetupRemoteProject
} from "@atape/application"
import type { GitSource, LocalProject } from "@atape/domain"
import { Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, realpath, rm, readdir, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { makeProjectLocatorLayer } from "./clientLayers.ts"
import { makeGitSourceBindingsLayer } from "./gitSourceBindings.ts"

const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const origin = "git@github.com:acme/payments.git"
const alias = "https://github.com/acme/previous-payments.git"
const remoteProject: SetupRemoteProject = {
  id: "payments", teamId: "team", name: "Payments", type: "git", state: "active",
  repositoryIdentity: "github.com/acme/payments", repositoryLinkState: "linked",
  createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z"
}

const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atape-git-attribution-")))
  roots.push(root)
  const project: LocalProject = { id: "payments", instanceOrigin: "https://atape.example", userId: "user", teamId: "team",
    teamSlug: "team", teamName: "Team", name: "Payments", type: "git", path: join(root, "repo"),
    repositoryRemote: origin, adapterIds: ["codex", "claude"], createdAt: remoteProject.createdAt }
  const git = (cwd: string, ...args: string[]) => execute("git", ["-C", cwd, ...args])
  const repo = async (name: string, remote: string = origin) => {
    const path = join(root, name)
    await mkdir(path, { recursive: true })
    await git(path, "init", "-q")
    await git(path, "remote", "add", "origin", remote)
    return path
  }
  await repo("repo")
  let failure: ProjectSetupGatewayError | undefined
  const calls: unknown[][] = []
  const bindings = makeGitSourceBindingsLayer(join(root, "evidence"))
  const gateway = Layer.succeed(ProjectSetupGateway, ProjectSetupGateway.of({
    loadWorkspace: () => Effect.die("unused"), createProject: () => Effect.die("unused"),
    matchGitProject: (instance, team, remote, user) => {
      calls.push([instance, team, remote, user])
      if (failure) return Effect.fail(failure)
      if (remote === "invalid") return Effect.fail(new ProjectSetupGatewayError({ reason: "invalid_remote", message: "Invalid remote" }))
      // Owned remote Adapter: aliases/equivalence are authoritative server results.
      return Effect.succeed(remote === origin || remote === alias || remote === "ssh://git@github.com/acme/payments.git"
        ? { status: "exact" as const, project: remoteProject }
        : { status: "none" as const })
    }
  }))
  const layer = makeGitSourceAttributionLayer().pipe(Layer.provide(Layer.mergeAll(bindings, gateway, makeProjectLocatorLayer())))
  const resolve = (source: GitSource, selected = project, adapterId = "claude") => Effect.gen(function*() {
    const attribution = yield* GitSourceAttribution
    return yield* attribution.forProject(selected, adapterId)(source)
  }).pipe(Effect.provide(layer), Effect.runPromise)
  return { root, project, repo, git, resolve, calls, layer, bindings,
    setFailure: (value: ProjectSetupGatewayError | undefined) => { failure = value } }
}
const source = (cwd: string, sourceId = "session"): GitSource => ({ sourceId, originKey: "original-root", cwd })

describe("Git Source Attribution Interface with real Git and filesystem", () => {
  it("includes worktrees and independent clones, excludes nested foreign repositories, and pins authority", async () => {
    const f = await fixture()
    const clone = await f.repo("independent-clone")
    await f.git(f.project.path, "-c", "user.name=ATape", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture")
    const worktree = join(f.root, "worktree")
    await f.git(f.project.path, "worktree", "add", "--detach", worktree)
    const nested = await f.repo("repo/nested", "https://github.com/acme/different.git")
    for (const adapter of ["codex", "claude"]) {
      expect(await f.resolve(source(clone, "clone"), f.project, adapter)).toBe("included")
      expect(await f.resolve(source(worktree, "worktree"), f.project, adapter)).toBe("included")
      expect(await f.resolve(source(nested, "nested"), f.project, adapter)).toBe("excluded")
    }
    expect(f.calls.every(call => call[0] === f.project.instanceOrigin && call[1] === "team" && call[3] === "user")).toBe(true)
    expect(JSON.stringify(f.calls)).not.toContain(f.root)
  })

  it("retains established attribution across restarts, origin changes and locator deletion", async () => {
    const f = await fixture()
    const original = source(f.project.path)
    expect(await f.resolve(original)).toBe("included")
    await f.git(f.project.path, "remote", "set-url", "origin", "https://github.com/acme/different.git")
    expect(await f.resolve(source(f.project.path, "new-session"))).toBe("excluded")
    expect(await f.resolve(original)).toBe("included")
    await rm(f.project.path, { recursive: true })
    // Each resolve reconstructs the Layer: only durable evidence survives.
    expect(await f.resolve(original)).toBe("included")
    expect(await f.resolve(source(f.project.path, "never-seen"))).toBe("unknown")
    expect(await f.resolve({ ...original, originKey: "replacement" })).toBe("unknown")
    expect(await f.resolve(original, { ...f.project, createdAt: "new-registration" })).toBe("unknown")
  })

  it("uses source-recorded remotes and server aliases even with a missing or conflicting CWD", async () => {
    const f = await fixture()
    const foreign = await f.repo("foreign", "https://github.com/acme/different.git")
    expect(await f.resolve({ ...source(foreign), repositoryRemote: alias })).toBe("included")
    expect(await f.resolve({ ...source("/missing/checkout", "recorded"), repositoryRemote: "ssh://git@github.com/acme/payments.git" })).toBe("included")
    expect(await f.resolve({ ...source(f.project.path, "invalid"), repositoryRemote: "invalid" })).toBe("unknown")
    expect(await f.resolve({ ...source(f.project.path, "recorded-foreign"), repositoryRemote: "https://github.com/acme/different.git" })).toBe("excluded")
  })

  it("does not disguise authentication/network failures as unknown sources or cache them on retry", async () => {
    const f = await fixture()
    f.setFailure(new ProjectSetupGatewayError({ reason: "unauthenticated", message: "Sign in again" }))
    await expect(f.resolve(source(f.project.path))).rejects.toMatchObject({ reason: "unauthenticated" })
    f.setFailure(new ProjectSetupGatewayError({ reason: "transport", message: "Offline" }))
    await expect(f.resolve(source(f.project.path))).rejects.toMatchObject({ reason: "transport" })
    f.setFailure(undefined)
    expect(await f.resolve(source(f.project.path))).toBe("included")
  })

  it("caches repeated matching within one call and refreshes authority on the next call", async () => {
    const f = await fixture()
    await Effect.gen(function*() {
      const attribution = yield* GitSourceAttribution
      const resolve = attribution.forProject(f.project, "claude")
      yield* resolve(source(f.project.path, "first"))
      yield* resolve(source(f.project.path, "second"))
    }).pipe(Effect.provide(f.layer), Effect.runPromise)
    expect(f.calls).toHaveLength(1)
    await f.resolve(source(f.project.path, "first"))
    expect(f.calls).toHaveLength(2)
  })

  it("does not inherit a different shell Git directory", async () => {
    const f = await fixture()
    const foreign = await f.repo("foreign", "https://github.com/acme/different.git")
    const previous = process.env.GIT_DIR
    try {
      process.env.GIT_DIR = join(foreign, ".git")
      expect(await f.resolve(source(f.project.path))).toBe("included")
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previous
    }
  })

  it("atomically preserves the first binding and refuses symlink/corrupt evidence", async () => {
    const f = await fixture()
    const scope: GitBindingScope = { ...f.project, adapterId: "claude" }
    const first = { version: 1 as const, cwd: f.project.path, originKey: "first", remote: origin }
    const second = { ...first, originKey: "second", remote: alias }
    const winners = await Effect.gen(function*() {
      const store = yield* GitSourceBindings
      return yield* Effect.all([store.remember(scope, "same", first), store.remember(scope, "same", second)], { concurrency: 2 })
    }).pipe(Effect.provide(f.bindings), Effect.runPromise)
    expect(winners[0]).toEqual(winners[1])
    const directory = join(f.root, "evidence")
    const files = await readdir(directory)
    expect(files).toHaveLength(1)
    const file = join(directory, files[0]!)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await writeFile(file, "broken")
    const read = Effect.gen(function*() { return yield* (yield* GitSourceBindings).read(scope, "same") })
    await expect(Effect.runPromise(read.pipe(Effect.provide(f.bindings)))).rejects.toBeInstanceOf(GitAttributionError)
    await rm(file)
    const outside = join(f.root, "outside")
    await writeFile(outside, JSON.stringify(first))
    await symlink(outside, file)
    await expect(Effect.runPromise(read.pipe(Effect.provide(f.bindings)))).rejects.toBeInstanceOf(GitAttributionError)
  })
})
