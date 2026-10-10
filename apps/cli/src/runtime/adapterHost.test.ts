import { AdapterRuntimes, GitSourceAttribution } from "@atape/application"
import { AdapterProtocolVersion, NewSessionVersion, type LocalProject, type AdapterInstallation } from "@atape/domain"
import { Effect, Layer } from "effect"
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import { makeAdapterRuntimeLayer } from "./adapterHost.ts"
import { makeProjectLocatorLayer } from "./projectLocator.ts"
import { makeCreationReceiptStore } from "./creationReceipts.ts"
const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
const fixture = async (body: string, manifestCapability: unknown = NewSessionVersion, runtimeCapability: unknown = NewSessionVersion, withClose = true) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "atape-host-start-"))); homes.push(home)
  const directory = join(home, "adapters"), packageRoot = join(directory, "node_modules", "test-adapter"), root = join(home, "native")
  await mkdir(packageRoot, { recursive: true }); await mkdir(root)
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "test-adapter", version: "1", type: "module", atapeAdapter: { protocolVersion: AdapterProtocolVersion, adapterId: "test", displayName: "Test", entry: "./index.mjs", harnesses: ["Test"], ...(manifestCapability === null ? {} : { newSession: manifestCapability }) } }))
  await writeFile(join(packageRoot, "index.mjs"), `import { writeFile } from "node:fs/promises";
export const createAtapeAdapter = context => ({ collect: () => ({}),
  ${runtimeCapability === null ? "" : `newSession: { protocolVersion: ${JSON.stringify(runtimeCapability)}, start: async request => { ${body} } },`}
  ${withClose ? `close: async () => { await writeFile(${JSON.stringify(join(home, "closed"))}, "closed") }` : ""}
});`)
  const adapter: AdapterInstallation = { adapterId: "test", packageName: "test-adapter", upgradeSpec: "test-adapter", displayName: "Test", version: "1", installedAt: "now", updatedAt: "now" }
  const project: LocalProject = { id: "p", instanceOrigin: "https://example.invalid", userId: "u", teamId: "t", teamSlug: "team", teamName: "Team", name: "Project", type: "directory", path: home, createdAt: "now", adapterIds: ["test"] }
  const layer = makeAdapterRuntimeLayer(directory, undefined, { home }).pipe(Layer.provide(Layer.mergeAll(makeProjectLocatorLayer(),
    Layer.succeed(GitSourceAttribution, GitSourceAttribution.of({ forProject: () => () => Effect.die("Start must not resolve Git bindings") })))))
  const run = <A, E>(program: Effect.Effect<A, E, AdapterRuntimes>, signal?: AbortSignal) => Effect.runPromise(program.pipe(Effect.provide(layer)), signal ? { signal } : undefined)
  return { home, root, adapter, project, run }
}
describe("Adapter Host controlled start", () => {
  it("provides read-only receipts, pins Host facts and retains confirmation after a nonzero native result", async () => {
    const f = await fixture('if (!context.creationReceipts) throw new Error("missing reader"); '+
      'await request.creation.recordAttempt({sourceId:"fresh",stateDirectory:process.env.HOST_TEST_ROOT,sourcePath:process.env.HOST_TEST_ROOT+"/fresh.jsonl",profile:"test.v1"},request.signal); await request.creation.confirm({prefix:{bytes:1,rows:1,sha256:"a".repeat(64)}},request.signal); return {sourceId:"fresh",creation:"confirmed",exitCode:7};')
    // The Test Adapter has a real varying environment input, like a provider state root.
    const previous = process.env.HOST_TEST_ROOT; process.env.HOST_TEST_ROOT = f.root
    try {
      const result = await f.run(Effect.scoped(AdapterRuntimes.use(r => r.open(f.project, f.adapter).pipe(Effect.flatMap(runtime => runtime.newSession!.start({ origin: { cwd: f.home }, initialPrompt: "literal", revalidate: Effect.void }))))))
      expect(result).toEqual({ sourceId: "fresh", creation: "confirmed", exitCode: 7 })
      expect(await makeCreationReceiptStore(f.home, "test").reader.readConfirmed({ stateDirectory: f.root, sourceId: "fresh" }, new AbortController().signal)).toMatchObject({ origin: { cwd: f.home } })
      expect(await readFile(join(f.home, "closed"), "utf8")).toBe("closed")
    } finally { if (previous === undefined) delete process.env.HOST_TEST_ROOT; else process.env.HOST_TEST_ROOT = previous }
  })
  it.each([[NewSessionVersion, null], [null, NewSessionVersion], [NewSessionVersion, "wrong.v1"]])("rejects and closes mismatched newSession capabilities %s/%s", async (manifest, runtime) => {
    const f = await fixture("return {}", manifest, runtime)
    await expect(f.run(Effect.scoped(AdapterRuntimes.use(r => r.open(f.project, f.adapter))))).rejects.toThrow("exact runtime capability")
    expect(await readFile(join(f.home, "closed"), "utf8")).toBe("closed")
  })
  it("keeps older factories without newSession working", async () => {
    const f = await fixture("", null, null)
    expect(await f.run(Effect.scoped(AdapterRuntimes.use(r => r.open(f.project, f.adapter).pipe(Effect.map(runtime => runtime.newSession)))))).toBeUndefined()
  })
  it("rejects a provider claim unsupported by its receipt facts and abandons pending attempts", async () => {
    const f = await fixture('await request.creation.recordAttempt({sourceId:"fresh",stateDirectory:process.env.HOST_TEST_ROOT,sourcePath:process.env.HOST_TEST_ROOT+"/fresh.jsonl",profile:"test.v1"},request.signal); return {sourceId:"fresh",creation:"confirmed",exitCode:0};')
    const previous = process.env.HOST_TEST_ROOT; process.env.HOST_TEST_ROOT = f.root
    try {
      await expect(f.run(Effect.scoped(AdapterRuntimes.use(r => r.open(f.project, f.adapter).pipe(Effect.flatMap(runtime => runtime.newSession!.start({ origin: { cwd: f.home }, revalidate: Effect.void }))))))).rejects.toThrow("Host creation facts")
      expect(await makeCreationReceiptStore(f.home, "test").reader.readConfirmed({ stateDirectory: f.root, sourceId: "fresh" }, new AbortController().signal)).toBeUndefined()
    } finally { if (previous === undefined) delete process.env.HOST_TEST_ROOT; else process.env.HOST_TEST_ROOT = previous }
  })
})

it("joins a cancelled factory's resource cleanup and rejects revived late callbacks before returning", async () => {
  const f = await fixture("", NewSessionVersion), ready = join(f.home, "ready"), joined = join(f.home, "joined"), late = join(f.home, "late")
  await writeFile(join(f.home, "adapters", "node_modules", "test-adapter", "index.mjs"), `import {writeFile} from "node:fs/promises";
export const createAtapeAdapter = () => { let pending; return {collect:()=>({}), newSession:{protocolVersion:${JSON.stringify(NewSessionVersion)},start:request => pending=(async()=>{
await request.creation.recordAttempt({sourceId:"fresh",stateDirectory:${JSON.stringify(f.root)},sourcePath:${JSON.stringify(join(f.root, "fresh.jsonl"))},profile:"test.v1"},request.signal);
await writeFile(${JSON.stringify(ready)}, "ready"); await new Promise(resolve=>request.signal.addEventListener("abort",resolve,{once:true}));
await request.creation.confirm({prefix:{bytes:1,rows:1,sha256:"a".repeat(64)}},new AbortController().signal).then(()=>{throw Error("late callback accepted")},()=>writeFile(${JSON.stringify(late)},"rejected"));
await new Promise(resolve=>setTimeout(resolve,50));await writeFile(${JSON.stringify(joined)},"joined"); throw Error("cancelled");})()},close:async()=>{await pending?.catch(()=>{});await writeFile(${JSON.stringify(join(f.home, "closed"))},"closed")}}};`)
  const cancellation = new AbortController()
  const pending = f.run(Effect.scoped(AdapterRuntimes.use(r => r.open(f.project, f.adapter).pipe(Effect.flatMap(runtime => runtime.newSession!.start({ origin: { cwd: f.home }, revalidate: Effect.void }))))), cancellation.signal)
  const settled = pending.then(() => "unexpected", () => "interrupted")
  await expect.poll(() => readFile(ready, "utf8").catch(() => ""), { timeout: 5000 }).toBe("ready")
  cancellation.abort(); expect(await settled).toBe("interrupted")
  expect(await readFile(joined, "utf8")).toBe("joined"); expect(await readFile(late, "utf8")).toBe("rejected")
  expect(await readFile(join(f.home, "closed"), "utf8")).toBe("closed")
  expect(await makeCreationReceiptStore(f.home, "test").reader.readConfirmed({ stateDirectory: f.root, sourceId: "fresh" }, new AbortController().signal)).toBeUndefined()
})

it("requires a joining close operation whenever a legacy factory declares controlled start", async () => {
  const f = await fixture("return {sourceId:'fresh',creation:'unconfirmed',exitCode:0}", NewSessionVersion, NewSessionVersion, false)
  await expect(f.run(Effect.scoped(AdapterRuntimes.use(r => r.open(f.project, f.adapter))))).rejects.toMatchObject({ reason: "contract" })
})
