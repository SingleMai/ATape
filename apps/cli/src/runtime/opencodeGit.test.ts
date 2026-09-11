import { AdapterRuntimes, CLISetupPlatform, installAdapter, makeGitSourceAttributionLayer,
  ProjectSetupGateway, ProjectSetupGatewayError, type SetupRemoteProject } from "@atape/application"
import type { GitSource, LocalProject, SourceDiscoveryPage } from "@atape/domain"
import { Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defaultNodeClientPaths, makeAdapterPackagesLayer, makeConfigStoreLayer, makeProjectLocatorLayer } from "./clientLayers.ts"
import { makeAdapterRuntimeLayer } from "./collectorLayers.ts"
import { makeCLISetupPlatformLayer } from "./cliSetupPlatform.ts"
import { makeGitSourceBindingsLayer } from "./gitSourceBindings.ts"

const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const sourceLimits = { rowBytes: 65536, pageBytes: 262144, pageRows: 1, records: 1000, threads: 20, durationMs: 10000 }
const projection = { events: 1000, usage: 1000, pageItems: 2, pageBytes: 262144 }
const origin = "https://github.com/controlled/opencode.git"
const remoteProject: SetupRemoteProject = { id: "project", teamId: "team", name: "OpenCode", type: "git", state: "active",
  repositoryIdentity: "github.com/controlled/opencode", repositoryLinkState: "linked", createdAt: "2026-09-11T00:00:00Z", updatedAt: "2026-09-11T00:00:00Z" }

describe("Installed OpenCode Git attribution", () => {
  it("uses original worktree evidence across checkouts, excludes foreign repositories and rechecks authority after origin removal", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "atape-opencode-git-"))); roots.push(root)
    const original = join(root, "original"), worktree = join(root, "worktree"), checkout = join(root, "checkout"), foreign = join(checkout, "foreign")
    const git = (cwd: string, ...args: string[]) => execute("git", ["-C", cwd, ...args], { timeout: 10000 })
    await mkdir(original)
    await git(original, "init", "-q")
    await git(original, "-c", "user.name=ATape", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
      "commit", "--allow-empty", "-qm", "controlled")
    await git(original, "remote", "add", "origin", origin)
    await git(original, "worktree", "add", "--detach", worktree)
    await execute("git", ["clone", "--no-hardlinks", original, checkout], { timeout: 10000 })
    await git(checkout, "remote", "set-url", "origin", origin)
    await mkdir(foreign)
    await git(foreign, "init", "-q")
    await git(foreign, "remote", "add", "origin", "https://github.com/controlled/foreign.git")

    const fixture = JSON.parse(await readFile(new URL("../../../../adapters/opencode/src/fixtures/native-v1.json", import.meta.url), "utf8")) as {
      rootID: string; forkID: string; ddl: string[]; rows: Record<string, Record<string, SQLInputValue>[]>
    }
    const sourcePath = join(root, "opencode.db"), db = new DatabaseSync(sourcePath)
    try {
      db.exec("PRAGMA foreign_keys=OFF")
      for (const ddl of fixture.ddl) db.exec(ddl)
      for (const [table, rows] of Object.entries(fixture.rows)) for (const row of rows) {
        const keys = Object.keys(row)
        db.prepare(`INSERT INTO "${table}" (${keys.map(key => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row))
      }
      db.prepare("UPDATE event SET data=json_set(data,'$.info.directory',?) WHERE type='session.created.1'").run(worktree)
      db.prepare("UPDATE event SET data=json_set(data,'$.info.directory',?) WHERE type='session.created.1' AND aggregate_id=?").run(foreign, fixture.forkID)
      db.prepare("UPDATE session SET directory=?").run(foreign)
    } finally { db.close() }
    vi.stubEnv("OPENCODE_DB", sourcePath)
    const fingerprint = async () => ({ hash: createHash("sha256").update(await readFile(sourcePath)).digest("hex"), mtime: (await stat(sourcePath)).mtimeMs })
    const before = await fingerprint()

    // Pack the real candidate and install through the caller-facing package
    // workflow. No source-import wrapper or hand-written package manifest.
    const artifacts = join(root, "artifacts"); await mkdir(artifacts)
    const packed = await execute("npm", ["pack", "--json", "--pack-destination", artifacts], {
      cwd: fileURLToPath(new URL("../../../../adapters/opencode", import.meta.url)), timeout: 120000, maxBuffer: 4 * 1024 * 1024
    })
    const artifact = (JSON.parse(packed.stdout) as { filename: string }[])[0]
    if (!artifact) throw new Error("OpenCode pack did not produce an artifact")
    const paths = defaultNodeClientPaths({ ATAPE_HOME: join(root, "atape") })
    const adapter = (await Effect.runPromise(installAdapter(join(artifacts, artifact.filename)).pipe(Effect.provide(Layer.mergeAll(
      makeConfigStoreLayer(paths.configFile), makeAdapterPackagesLayer(paths.adapterDirectory)
    ))))).adapter
    expect(await Effect.runPromise(CLISetupPlatform.use(platform => platform.supportsGit(adapter)).pipe(
      Effect.provide(makeCLISetupPlatformLayer(paths, {}))))).toBe(true)
    const project: LocalProject = { id: remoteProject.id, instanceOrigin: "https://atape.test", userId: "user", teamId: "team", teamSlug: "team",
      teamName: "Team", name: "OpenCode", type: "git", path: checkout, repositoryRemote: origin, createdAt: remoteProject.createdAt, adapterIds: ["opencode"] }
    let denied = false
    const matches: unknown[][] = []
    // Only the owned remote Project matching Seam is substituted. Source reading,
    // package loading, Git inspection and durable Origin bindings are real.
    const gateway = Layer.succeed(ProjectSetupGateway, ProjectSetupGateway.of({
      loadWorkspace: () => Effect.die("unused"), createProject: () => Effect.die("unused"),
      matchGitProject: (instance, team, remote, user) => {
        matches.push([instance, team, remote, user])
        return denied ? Effect.fail(new ProjectSetupGatewayError({ reason: "unauthenticated", message: "Controlled credential revoked" })) :
          Effect.succeed(remote === origin ? { status: "exact" as const, project: remoteProject } : { status: "none" as const })
      }
    }))
    const locator = makeProjectLocatorLayer()
    const attribution = makeGitSourceAttributionLayer().pipe(Layer.provide(Layer.mergeAll(gateway, locator,
      makeGitSourceBindingsLayer(`${paths.collectorStateFile}.git-attribution`))))
    const layer = makeAdapterRuntimeLayer(paths.adapterDirectory).pipe(Layer.provide(Layer.merge(locator, attribution)))
    const inspect = (afterOriginRemoval = false) => Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* (yield* AdapterRuntimes).open(project, adapter)
      if (!("sourceCapture" in runtime)) throw new Error("OpenCode source capability missing")
      const sources: GitSource[] = []
      let cursor: string | null = null, pages = 0
      for (;;) {
        const page: SourceDiscoveryPage = yield* runtime.sourceCapture.discover({ cursor, limits: sourceLimits })
        sources.push(...page.sources); pages++
        if (page.done) break
        if (pages > 10) throw new Error("Discovery did not finish")
        cursor = page.cursor
      }
      expect(sources).toHaveLength(2)
      const rootSource = sources.find(source => source.sourceId === fixture.rootID)!
      expect(rootSource.cwd).toBe(worktree)
      expect(yield* runtime.attribute(rootSource)).toBe("included")
      expect(yield* runtime.attribute(sources.find(source => source.sourceId === fixture.forkID)!)).toBe("excluded")
      if (afterOriginRemoval) expect(yield* runtime.attribute({ ...rootSource, sourceId: "unseen" })).toBe("unknown")
      const view = yield* runtime.sourceCapture.open({ sourceId: fixture.rootID, rawEnabled: false, limits: sourceLimits, projection })
      let events = 0
      for (;;) { const page = yield* view.read(); events += page.frames.flatMap(frame => frame.events).length; if (page.done) break }
      expect(events).toBe(6)
    })).pipe(Effect.provide(layer)))
    await inspect()
    await git(original, "worktree", "remove", "--force", worktree)
    const previousCalls = matches.length
    await inspect(true)
    expect(matches.length).toBeGreaterThan(previousCalls)
    denied = true
    await expect(inspect(true)).rejects.toMatchObject({ reason: "unauthenticated" })
    expect(matches.every(call => call[0] === project.instanceOrigin && call[1] === project.teamId && call[3] === project.userId)).toBe(true)
    expect(JSON.stringify(matches)).not.toContain(root)
    expect(await fingerprint()).toEqual(before)
  }, 30000)
})
