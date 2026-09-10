import { AdapterRuntimes } from "@atape/application"
import { AdapterProtocolVersion, SourceCaptureVersion, type AdapterInstallation, type LocalProject, type SourceCaptureView, type SourceDiscoveryPage } from "@atape/domain"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeNodeClientLayer, type NodeClientPaths } from "./clientLayers.ts"
import { hostSourceCapture } from "./sourceCaptureRuntime.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const limits = { rowBytes: 64 * 1024, pageBytes: 256 * 1024, pageRows: 2, records: 1000, threads: 20, durationMs: 10000 }
const projection = { events: 1000, usage: 1000, pageItems: 2, pageBytes: 256 * 1024 }
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "atape-hosted-source-")); directories.push(root)
  const evidence = JSON.parse(await readFile(new URL("../../../../adapters/opencode/src/fixtures/native-v1.json", import.meta.url), "utf8")) as {
    rootID: string; forkID: string; ddl: string[]; rows: Record<string, Record<string, SQLInputValue>[]>
  }
  const path = join(root, "opencode.db"), db = new DatabaseSync(path)
  db.exec("PRAGMA foreign_keys=OFF")
  for (const ddl of evidence.ddl) db.exec(ddl)
  for (const [table, rows] of Object.entries(evidence.rows)) for (const row of rows) {
    const keys = Object.keys(row)
    db.prepare(`INSERT INTO "${table}" (${keys.map(key => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row))
  }
  db.close()
  const paths: NodeClientPaths = { atapeHome: root, credentialDirectory: join(root, "credentials"), configFile: join(root, "config.json"),
    collectorStateFile: join(root, "collector.json"), collectorProcessFile: join(root, "process.json"), collectorStatusFile: join(root, "status.json"),
    collectorLogFile: join(root, "collector.log"), adapterDirectory: join(root, "adapters") }
  const packageRoot = join(paths.adapterDirectory, "node_modules", "@atape", "adapter-opencode")
  await mkdir(packageRoot, { recursive: true })
  const manifest = { name: "@atape/adapter-opencode", version: "0.0.0", type: "module", atapeAdapter: {
    protocolVersion: AdapterProtocolVersion, adapterId: "opencode", displayName: "OpenCode", entry: "./index.mjs", harnesses: ["OpenCode"], sourceCapture: SourceCaptureVersion
  } }
  await writeFile(join(packageRoot, "package.json"), JSON.stringify(manifest))
  await writeFile(join(packageRoot, "index.mjs"), `import { createOpenCodeRuntime } from ${JSON.stringify(new URL("../../../../adapters/opencode/src/runtime.ts", import.meta.url).href)};
export const createAtapeAdapter = context => createOpenCodeRuntime({ path: ${JSON.stringify(path)}, signal: context.signal });`)
  const adapter: AdapterInstallation = { adapterId: "opencode", packageName: manifest.name, version: manifest.version, displayName: "OpenCode", upgradeSpec: manifest.name,
    installedAt: "2026-09-10T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z" }
  const project: LocalProject = { id: "project", instanceOrigin: "https://atape.test", userId: "user", teamId: "team", teamSlug: "team", teamName: "Team", name: "Project",
    type: "directory", path: root, createdAt: "2026-09-10T00:00:00Z", adapterIds: ["opencode"] }
  const layer = makeNodeClientLayer(paths, {})
  const run = <A, E>(effect: Effect.Effect<A, E, AdapterRuntimes>) => Effect.runPromise(effect.pipe(Effect.provide(layer)))
  return { root, evidence, run, manifest, packageRoot, paths, project, adapter, open: AdapterRuntimes.use(runtimes => runtimes.open(project, adapter)) }
}

describe("Host source runtime capability", () => {
  it("opens the actual OpenCode package Interface and closes native views with the caller Scope", async () => {
    const f = await fixture()
    const escaped = await f.run(Effect.scoped(Effect.gen(function*() {
      const runtime = yield* f.open
      if (!("sourceCapture" in runtime)) throw new Error("source capability missing")
      const sources: string[] = []
      let cursor: string | null = null
      for (;;) {
        const page: SourceDiscoveryPage = yield* runtime.sourceCapture.discover({ cursor, limits }); sources.push(...page.sources.map(source => source.sourceId))
        if (page.done) break
        cursor = page.cursor
      }
      expect(sources.sort()).toEqual([f.evidence.rootID, f.evidence.forkID].sort())
      const view = yield* runtime.sourceCapture.open({ sourceId: f.evidence.rootID, rawEnabled: false, limits, projection })
      let events = 0
      for (;;) { const page = yield* view.read(); events += page.frames.flatMap(frame => frame.events).length; if (page.done) break }
      expect(events).toBe(6)
      return view
    })))
    await expect(Effect.runPromise(escaped.read())).rejects.toMatchObject({ reason: "contract" })
  })
  it("loads and consumes the source capability in native Node without a test transform", async () => {
    const f = await fixture()
    const { stdout } = await promisify(execFile)(process.execPath, [new URL("./fixtures/source-runtime-contract.ts", import.meta.url).pathname,
      JSON.stringify({ paths: f.paths, project: f.project, adapter: f.adapter, sourceId: f.evidence.rootID, limits, projection })])
    expect(JSON.parse(stdout)).toEqual({ events: 6, rawFrames: 0 })
  })
  it("never selects a source runtime without the matching explicit manifest capability", async () => {
    const f = await fixture()
    const undeclared = { ...f.manifest, atapeAdapter: { ...f.manifest.atapeAdapter, sourceCapture: undefined } }
    await writeFile(join(f.packageRoot, "package.json"), JSON.stringify(undeclared))
    await expect(f.run(Effect.scoped(f.open))).rejects.toMatchObject({ reason: "contract" })
  })
  it.each(["invalid", 1, true])("returns a typed contract error for primitive runtime %s", async value => {
    const f = await fixture()
    await writeFile(join(f.packageRoot, "index.mjs"), `export const createAtapeAdapter = () => ${JSON.stringify(value)};`)
    await expect(f.run(Effect.scoped(f.open))).rejects.toMatchObject({ reason: "contract", retryable: false })
  })
  it("closes a late foreign view after an open deadline instead of leaking it", async () => {
    let closes = 0
    const view = { close: () => { closes++ } } as unknown as SourceCaptureView
    const hosted = hostSourceCapture("fixture", { protocolVersion: SourceCaptureVersion,
      discover: () => undefined, open: () => new Promise(resolve => setTimeout(() => resolve(view), 50)) }, new AbortController().signal)
    await expect(Effect.runPromise(Effect.scoped(hosted.open({ sourceId: "root", rawEnabled: false,
      limits: { ...limits, durationMs: 10 }, projection })))).rejects.toMatchObject({ reason: "collect" })
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(closes).toBe(1)
  })
  it("rejects non-progressing discovery and does not call foreign code for invalid admission", async () => {
    let calls = 0
    const hosted = hostSourceCapture("fixture", { protocolVersion: SourceCaptureVersion,
      discover: () => { calls++; return { sources: [], cursor: "same", done: false, sourceFailures: [], sourceFailuresTruncated: false } },
      open: () => { throw new Error("unused") } }, new AbortController().signal)
    await expect(Effect.runPromise(hosted.discover({ cursor: "same", limits }))).rejects.toMatchObject({ reason: "contract" })
    await expect(Effect.runPromise(hosted.discover({ cursor: null, limits: { ...limits, durationMs: 0 } }))).rejects.toMatchObject({ reason: "contract" })
    expect(calls).toBe(1)
  })
})
