import { AdapterPackages, AutomaticUpdatePlatform, AdapterPackageError } from "@atape/application"
import { emptyClientConfig, mergeTargetReleaseBundle, releasePackageNames, updateTargetProtocol, type TargetReleaseBundle } from "@atape/domain"
import { Effect, Layer } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import { makeAutomaticUpdatePlatformLayer, needsUpdateRecovery, protectedRuntimeSlots, recoverPendingUpdate } from "./managedUpdates.ts"
import { atomicJSON, runtimeEntry } from "./runtimeFiles.ts"
import { acquireTargetUpdateExecution, advanceTargetUpdate, assertTargetUpdateBaseline, beginTargetUpdate, finishTargetUpdate,
  invokeTargetUpdate, readTargetUpdateHandoff, readTargetUpdateOwner, readTargetUpdateReceipt, targetUpdatePending } from "./targetUpdate.ts"
import { retireObsoleteTargetOwner, targetOwnerRetirementPending } from "./targetUpdate.ts"
import { createUpdateControl } from "./updateControl.ts"
import { gzipSync } from "node:zlib"
import { prepareCollectorReadiness } from "./collectorReadiness.ts"
import { compileCaptureFixtureEntry, captureV2 } from "./fixtures/managed-capture-update.ts"
import { promisify } from "node:util"

// A future executable is a real deployment Seam. This test Adapter implements
// only its stable transport; it intentionally writes a capture ledger that this
// caller cannot decode. Installed release gates exercise the target's real core.
const futureExecutable = `import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path'; import { createHash } from 'node:crypto'; import { DatabaseSync } from 'node:sqlite';
if(process.argv.includes('--version')) console.log('ATape 0.5.99');
else if(process.argv[2]==='start') console.log('future-public-entry'); else {
const home=process.env.ATAPE_HOME, dir=join(home,'updates'), action=process.argv[5];
const db=new DatabaseSync(join(dir,'target.execution.lock.sqlite')); db.exec('PRAGMA busy_timeout=10000; BEGIN EXCLUSIVE');
try {
 if(process.env.TARGET_TEST_HANG==='1') { writeFileSync(process.env.TARGET_TEST_STARTED, String(process.pid)); setInterval(()=>{},1000); await new Promise(()=>{}); }
 const owner=action.startsWith('owner-'), job=JSON.parse(readFileSync(join(dir,owner?'target-owner.json':'target-update.json'),'utf8'));
 if(job.id!==process.argv[3] || job.token!==process.argv[4]) throw Error('Request mismatch');
 const hash=createHash('sha256').update(JSON.stringify(job)).digest('hex');
 const receipts=join(dir,'target-update-receipts'); mkdirSync(receipts,{recursive:true});
 const receipt={protocol:job.protocol,id:job.id,requestHash:hash,entrySha256:job.entrySha256,action,internalPending:false};
 if(owner) {
   const nonce=process.argv[6], request=JSON.parse(readFileSync(join(dir,'target-owner-calls',nonce+'.request.json'),'utf8'));
   if(request.ownerHash!==hash || request.action!==action || request.id!==job.id || request.nonce!==nonce) throw Error('Owner request mismatch');
   receipt.nonce=nonce; receipt.slots=['safe-slot-1'];
 }
 else if(action==='prepare') { receipt.status='prepared'; receipt.preparedKey='e859003d-90b4-44f6-ae5a-c14aa3c8ede7'; }
 else if(job.phase==='activating') {
   writeFileSync(join(dir,'runtime.json'),JSON.stringify({protocol:'atape.update-control.v1',version:job.bundle.version,
    captureStateContract:job.bundle.captureStateContract,bootstrapEntry:job.bootstrapEntry,bootstrapIdentity:job.baseline.bootstrap,adapters:[]}));
   writeFileSync(join(dir,'capture-migration.json'),JSON.stringify({protocol:'future.private-ledger.v99',phase:'completed'}));
   receipt.status='completed';
 } else receipt.status='deferred';
 const path=owner?join(dir,'target-owner-calls',receipt.nonce+'.receipt.json'):join(receipts,job.id+'.json');
 const temp=path+'.tmp'; writeFileSync(temp,JSON.stringify(receipt)); renameSync(temp,path);
} finally { db.exec('ROLLBACK'); db.close(); }
}
`
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atape-target-update-"))); roots.push(root)
  const paths = defaultNodeClientPaths({ ATAPE_HOME: join(root, "home") })
  await mkdir(paths.atapeHome, { recursive: true })
  const bundle: TargetReleaseBundle = { protocol: "atape.release-bundle.v3", version: "0.5.99",
    captureStateContract: "future.capture.v99", updateControlProtocol: "atape.update-control.v1", updateTargetProtocol,
    fromCaptureStateContracts: ["atape.client.v3-capture.v2", "future.capture.v99"], packages: releasePackageNames.map(name => ({ name,
      integrity: `sha512-${createHash("sha512").update(name).digest("base64")}`,
      tarball: `https://registry.npmjs.org/${name}/-/${name.slice(7)}-0.5.99.tgz` })) }
  const entry = runtimeEntry(paths.atapeHome, bundle.version), bootstrapEntry = join(root, "npm", "node_modules", "@atape", "cli", "dist", "atape.js")
  await mkdir(dirname(entry), { recursive: true }); await mkdir(dirname(bootstrapEntry), { recursive: true })
  await writeFile(entry, futureExecutable); await writeFile(bootstrapEntry, "old executable")
  await atomicJSON(join(dirname(dirname(entry)), "package.json"), { name: "@atape/cli", version: bundle.version, type: "module",
    atapeRuntime: { stateContract: bundle.captureStateContract, updateControlProtocol: bundle.updateControlProtocol, updateTargetProtocol } })
  const begin = () => beginTargetUpdate(paths, { bundle, bootstrapEntry, automatic: true })
  const invoke = (job: Awaited<ReturnType<typeof begin>>, action: "prepare" | "activate" | "recover", signal = AbortSignal.timeout(5000)) =>
    invokeTargetUpdate(job, action, process.env, signal)
  return { root, paths, bundle, entry, bootstrapEntry, begin, invoke }
}
const archive = (files: Readonly<Record<string, string>>) => gzipSync(Buffer.concat([
  ...Object.entries(files).flatMap(([name, source]) => {
    const bytes = Buffer.from(source), header = Buffer.alloc(512)
    header.write(`package/${name}`); header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116)
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124); header.write("00000000000\0", 136)
    header.fill(32, 148, 156); header[156] = 48
    header.write(`${[...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148)
    return [header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]
  }), Buffer.alloc(1024)
]))

describe("target-owned update executable Seam", () => {
  it.skipIf(process.platform === "win32")("recovers through the real public entry before fresh bridge admission after the synced floor", async () => {
    const f = await fixture(), version = "0.5.11", sourceEntry = runtimeEntry(f.paths.atapeHome, version)
    await compileCaptureFixtureEntry(f.bootstrapEntry, "target", version, captureV2)
    const sourceManifest = { name: "@atape/cli", version, type: "module", atapeRuntime: {
      protocol: "atape.runtime.v1", stateContract: captureV2, updateControlProtocol: f.bundle.updateControlProtocol, updateTargetProtocol } }
    await atomicJSON(join(dirname(dirname(f.bootstrapEntry)), "package.json"), sourceManifest)
    await mkdir(dirname(sourceEntry), { recursive: true }); await cp(f.bootstrapEntry, sourceEntry)
    await atomicJSON(join(dirname(dirname(sourceEntry)), "package.json"), sourceManifest)
    const begun = await f.begin(), prepared = await advanceTargetUpdate(begun, "prepared", (await f.invoke(begun, "prepare")).preparedKey!)
    const active = await advanceTargetUpdate(prepared, "activating", prepared.preparedKey!)
    const previous = { protocol: "atape.update-control.v1" as const, version, captureStateContract: captureV2,
      bootstrapEntry: f.bootstrapEntry, bootstrapIdentity: active.baseline.bootstrap, adapters: [] }
    const target = { ...previous, version: f.bundle.version, captureStateContract: f.bundle.captureStateContract }
    await createUpdateControl(f.paths.atapeHome).handoffTarget({ key: randomUUID(), previous, next: target })
    // The source installation truly had no pointer. Reconstruct the durable
    // floor-first crash window, then exercise the compiled entry through a PTY.
    await rm(join(f.paths.atapeHome, "updates", "runtime.json"))
    const environment = { ...process.env, ATAPE_HOME: f.paths.atapeHome, TERM: "xterm-256color",
      CI: "", CONTINUOUS_INTEGRATION: "", BUILD_NUMBER: "", ATAPE_RUNTIME_DIRECT: "", ATAPE_BOOTSTRAP_ENTRY: f.bootstrapEntry }
    const before = await readFile(join(f.paths.atapeHome, "updates", "target-update.json"), "utf8")
    expect((await promisify(execFile)(process.execPath, [f.bootstrapEntry, "--version"], { env: environment, timeout: 10_000 })).stdout).toContain(version)
    expect(await readFile(join(f.paths.atapeHome, "updates", "target-update.json"), "utf8")).toBe(before)
    const output = await promisify(execFile)("python3", ["-c", `import os,pty,sys
pid,fd=pty.fork()
if pid==0: os.execv(sys.argv[1],sys.argv[1:])
while True:
 try: data=os.read(fd,65536)
 except OSError: break
 if not data: break
 os.write(1,data)
_,status=os.waitpid(pid,0)
sys.exit(os.waitstatus_to_exitcode(status))`, process.execPath, f.bootstrapEntry, "start", "--tool", "cursor"], { env: environment, timeout: 15_000 }).catch(cause => {
      throw new Error(`Public PTY entry failed: ${cause.stdout ?? ""}${cause.stderr ?? ""}`)
    })
    expect(output.stdout).toContain("future-public-entry")
    expect(await targetUpdatePending(f.paths.atapeHome)).toBe(false)
    expect((await readTargetUpdateOwner(f.paths.atapeHome))?.bundle).toEqual(f.bundle)
    expect((await createUpdateControl(f.paths.atapeHome).readSelection())?.version).toBe(f.bundle.version)
  }, 20_000)
  it("hands v3 preparation and activation to the exact target without loading an Adapter in its older parent", async () => {
    const f = await fixture(), packageRoot = dirname(dirname(f.bootstrapEntry)), modules = dirname(dirname(packageRoot))
    await atomicJSON(join(packageRoot, "package.json"), { name: "@atape/cli", version: "0.5.11", type: "module",
      atapeRuntime: { protocol: "atape.runtime.v1", stateContract: "atape.client.v3-capture.v2", updateControlProtocol: f.bundle.updateControlProtocol, updateTargetProtocol } })
    await writeFile(f.bootstrapEntry, "if(process.argv.includes('--version')) console.log('ATape 0.5.11')")
    const targetManifest = { name: "@atape/cli", version: f.bundle.version, type: "module", atapeRuntime: {
      protocol: "atape.runtime.v1", stateContract: f.bundle.captureStateContract, updateControlProtocol: f.bundle.updateControlProtocol, updateTargetProtocol } }
    const bytes = archive({ "package.json": `${JSON.stringify(targetManifest)}\n`, "dist/atape.js": futureExecutable })
    const bundle = { ...f.bundle, packages: f.bundle.packages.map(item => item.name === "@atape/cli" ? {
      ...item, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } : item) }
    // Existing immutable generation must be the same published bytes.
    await atomicJSON(join(dirname(dirname(f.entry)), "package.json"), targetManifest)
    const bin = join(f.root, "bin"); await mkdir(bin)
    await writeFile(join(bin, "npm"), `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path'),z=require('node:zlib'),args=process.argv.slice(2);
if(args[0]==='root') console.log(process.env.TARGET_TEST_MODULES);
else if(args[0]==='install') {
 const root=p.join(args[args.indexOf('--prefix')+1],'node_modules','@atape','cli'),tar=z.gunzipSync(fs.readFileSync(args.at(-1)));
 for(let i=0;i+512<=tar.length;) { const h=tar.subarray(i,i+512);if(h.every(b=>b===0))break;
  const name=h.subarray(0,100).toString().replace(/\\0.*$/s,''),size=parseInt(h.subarray(124,136).toString(),8),out=p.join(root,name.slice(8));
  fs.mkdirSync(p.dirname(out),{recursive:true});fs.writeFileSync(out,tar.subarray(i+512,i+512+size));i+=512+Math.ceil(size/512)*512; }
} else process.exit(2);`)
    await chmod(join(bin, "npm"), 0o700)
    const adapters = [{ adapterId: "codex", packageName: "@atape/adapter-codex", upgradeSpec: "@atape/adapter-codex", displayName: "Codex",
      version: "0.5.11", installedAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z" }]
    await atomicJSON(f.paths.configFile, { ...emptyClientConfig(), toolsConfigured: true, autoUpdateEnabled: true, adapters })
    let parentAdapterInstalls = 0
    const packages = Layer.succeed(AdapterPackages, AdapterPackages.of({ install: spec => {
      parentAdapterInstalls++; return Effect.fail(new AdapterPackageError({ reason: "install", packageSpec: spec, message: "Parent cannot decode future Adapters" }))
    }, prune: () => Effect.succeed({ applied: false, removed: 0, more: false, slots: [] }) }))
    const metadata: typeof fetch = async url => String(url).endsWith(".tgz") ? new Response(bytes) :
      Response.json(String(url).endsWith("/catalog/v3.json") ? mergeTargetReleaseBundle(undefined, bundle) : bundle)
    const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TARGET_TEST_MODULES: modules }
    const layer = makeAutomaticUpdatePlatformLayer(f.paths, f.bootstrapEntry, "0.5.11", environment, metadata).pipe(Layer.provide(packages))
    const run = <A, E>(effect: Effect.Effect<A, E, AutomaticUpdatePlatform>) => Effect.runPromise(effect.pipe(Effect.provide(layer)))
    const prepared = await run(Effect.scoped(AutomaticUpdatePlatform.use(platform => platform.prepare(bundle, adapters, true))))
    expect(prepared.bundle).toEqual(bundle)
    expect((await readTargetUpdateHandoff(f.paths.atapeHome))?.phase).toBe("prepared")
    expect(parentAdapterInstalls).toBe(0)
    await run(AutomaticUpdatePlatform.use(platform => platform.activate(prepared, true)))
    expect(await targetUpdatePending(f.paths.atapeHome)).toBe(false)
    expect((await readTargetUpdateOwner(f.paths.atapeHome))?.bundle).toEqual(bundle)
    expect(parentAdapterInstalls).toBe(0)
  })
  it("persists before execution, admits one request, and checks config/bootstrap baselines", async () => {
    const f = await fixture(), job = await f.begin()
    expect(await readTargetUpdateHandoff(f.paths.atapeHome)).toEqual(job)
    await expect(f.begin()).rejects.toThrow("pending")
    await assertTargetUpdateBaseline(job)
    await atomicJSON(f.paths.configFile, { changed: true })
    await expect(assertTargetUpdateBaseline(job)).rejects.toThrow("baseline changed")
    await rm(f.paths.configFile)
    await writeFile(f.bootstrapEntry, "replaced bootstrap")
    await expect(assertTargetUpdateBaseline(job)).rejects.toThrow("baseline changed")
  })
  it("canonicalizes home-contained paths consistently across an aliased home", async () => {
    const f = await fixture(), alias = join(f.root, "home-alias")
    await symlink(f.paths.atapeHome, alias)
    const paths = defaultNodeClientPaths({ ATAPE_HOME: alias })
    const job = await beginTargetUpdate(paths, { bundle: f.bundle, bootstrapEntry: f.bootstrapEntry, automatic: true })
    expect(job.paths).toEqual(f.paths)
    await assertTargetUpdateBaseline(job)
    const prepared = await advanceTargetUpdate(job, "prepared", (await f.invoke(job, "prepare")).preparedKey!)
    const active = await advanceTargetUpdate(prepared, "activating", prepared.preparedKey!)
    await finishTargetUpdate(active, await f.invoke(active, "activate"))
    expect((await readTargetUpdateOwner(alias))?.paths).toEqual(f.paths)
  })
  it("reports local readiness then waits on stable handoff before any future capture decoder", async () => {
    const f = await fixture(), job = await f.begin(), marker = join(f.root, "ready.json"), cancellation = new AbortController()
    await atomicJSON(f.paths.configFile, { ...emptyClientConfig(), toolsConfigured: true })
    const ledger = join(f.paths.atapeHome, "updates", "capture-migration.json")
    await atomicJSON(ledger, { protocol: "future.private-ledger.v99", phase: "applying" })
    let settled = false
    const waiting = Effect.runPromise(prepareCollectorReadiness(f.paths, { ATAPE_COLLECTOR_READY_FILE: marker,
      ATAPE_COLLECTOR_READY_TOKEN: "local-ready" }), { signal: cancellation.signal }).finally(() => { settled = true })
    try {
      const deadline = Date.now() + 1000
      let ready: { token: string; pid: number } | undefined
      while (!ready) {
        ready = await readFile(marker, "utf8").then(value => JSON.parse(value), () => undefined)
        if (Date.now() >= deadline) throw new Error("Readiness marker was not reported")
        if (!ready) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(ready).toEqual({ token: "local-ready", pid: process.pid })
      await new Promise(resolve => setTimeout(resolve, 70))
      expect(settled).toBe(false)
      await rm(ledger)
      const receipt = await f.invoke(job, "recover")
      await finishTargetUpdate(job, receipt)
      await waiting
      expect(settled).toBe(true)
    } finally { cancellation.abort(); await waiting.catch(() => {}) }
  })
  it("binds opaque receipts and phase CAS, and joins the target execution lock before cleanup", async () => {
    const f = await fixture(), job = await f.begin(), receipt = await f.invoke(job, "prepare")
    const prepared = await advanceTargetUpdate(job, "prepared", receipt.preparedKey!)
    await expect(advanceTargetUpdate(job, "activating", receipt.preparedKey!)).rejects.toThrow("handoff changed")
    await expect(readTargetUpdateReceipt(prepared)).rejects.toMatchObject({ code: "ENOENT" })
    const release = await acquireTargetUpdateExecution(f.paths.atapeHome)
    expect(release).toBeTypeOf("function")
    try { await expect(advanceTargetUpdate(prepared, "activating", receipt.preparedKey!)).rejects.toThrow("execution lock") }
    finally { release!() }
    const activating = await advanceTargetUpdate(prepared, "activating", receipt.preparedKey!)
    const completed = await f.invoke(activating, "activate")
    const held = await acquireTargetUpdateExecution(f.paths.atapeHome)
    try { await expect(finishTargetUpdate(activating, completed)).rejects.toThrow("execution lock") }
    finally { held!() }
    await finishTargetUpdate(activating, completed)
    expect(await targetUpdatePending(f.paths.atapeHome)).toBe(false)
    expect((await readTargetUpdateOwner(f.paths.atapeHome))?.bundle).toEqual(f.bundle)
  })
  it("recovers pending first and keeps completed future ledgers opaque to the older caller", async () => {
    const f = await fixture(), job = await f.begin(), receipt = await f.invoke(job, "prepare")
    const prepared = await advanceTargetUpdate(job, "prepared", receipt.preparedKey!)
    await advanceTargetUpdate(prepared, "activating", receipt.preparedKey!)
    await atomicJSON(join(f.paths.atapeHome, "updates", "capture-migration.json"), { protocol: "future.private-ledger.v99" })
    expect(await needsUpdateRecovery(f.paths)).toBe(true)
    await recoverPendingUpdate(f.paths, f.bootstrapEntry, process.env)
    const ledger = await readFile(join(f.paths.atapeHome, "updates", "capture-migration.json"))
    expect(await targetUpdatePending(f.paths.atapeHome)).toBe(false)
    expect(await needsUpdateRecovery(f.paths)).toBe(true) // The owner delegates; the old decoder is never reached.
    await recoverPendingUpdate(f.paths, f.bootstrapEntry, process.env)
    expect(await protectedRuntimeSlots(f.paths.atapeHome)).toEqual(["safe-slot-1"])
    const overlapping = await Promise.all([protectedRuntimeSlots(f.paths.atapeHome),
      recoverPendingUpdate(f.paths, f.bootstrapEntry, process.env), protectedRuntimeSlots(f.paths.atapeHome)])
    expect(overlapping).toEqual([["safe-slot-1"], undefined, ["safe-slot-1"]])
    expect(await readFile(join(f.paths.atapeHome, "updates", "capture-migration.json"))).toEqual(ledger)
    await atomicJSON(join(f.paths.atapeHome, "updates", "runtime.json"), { protocol: "future.selection", version: "0.6.0" })
    await expect(needsUpdateRecovery(f.paths)).rejects.toThrow("current runtime selection")
    await expect(recoverPendingUpdate(f.paths, f.bootstrapEntry, process.env)).rejects.toThrow("current runtime selection")
  })
  it("defers interrupted preparation and pruning without interpreting unknown private ledgers", async () => {
    const f = await fixture(), job = await f.begin()
    await atomicJSON(join(f.paths.atapeHome, "updates", "capture-migration.json"), { protocol: "future.private-ledger.v99" })
    expect(await needsUpdateRecovery(f.paths)).toBe(true)
    await expect(protectedRuntimeSlots(f.paths.atapeHome)).rejects.toThrow("pending")
    await recoverPendingUpdate(f.paths, f.bootstrapEntry, process.env)
    expect(await targetUpdatePending(f.paths.atapeHome)).toBe(false)
    expect(await readTargetUpdateOwner(f.paths.atapeHome)).toBeUndefined()
    await expect(needsUpdateRecovery(f.paths)).rejects.toThrow()
    expect(job.phase).toBe("preparing")
  })
  it("rejects changed executable bytes, symlink escape and oversized stable metadata", async () => {
    const f = await fixture(), job = await f.begin()
    await writeFile(f.entry, `${futureExecutable}\n// replaced`)
    await expect(f.invoke(job, "prepare")).rejects.toThrow("identity changed")
    await rm(f.entry); await symlink(f.bootstrapEntry, f.entry)
    await expect(f.invoke(job, "prepare")).rejects.toThrow("immutable generation")
    await writeFile(join(f.paths.atapeHome, "updates", "target-update.json"), " ".repeat(256 * 1024 + 1))
    await expect(targetUpdatePending(f.paths.atapeHome)).rejects.toThrow()
  })
  it("retains durable handoff when a target is cancelled or its request receipt is forged", async () => {
    const f = await fixture(), job = await f.begin(), cancellation = new AbortController()
    cancellation.abort()
    await expect(f.invoke(job, "prepare", cancellation.signal)).rejects.toThrow()
    expect(await readTargetUpdateHandoff(f.paths.atapeHome)).toEqual(job)
    const receipt = await f.invoke(job, "prepare")
    await atomicJSON(join(f.paths.atapeHome, "updates", "target-update-receipts", `${job.id}.json`), { ...receipt, id: randomUUID() })
    await expect(readTargetUpdateReceipt(job, "prepare")).rejects.toThrow("immutable request")
  })
  it("keeps orphan exclusion after parent SIGKILL and recovers the same immutable target after its child exits", async () => {
    const f = await fixture(), job = await f.begin(), marker = join(f.root, "orphan.pid")
    const source = fileURLToPath(new URL("./targetUpdate.ts", import.meta.url))
    const runner = join(f.root, "runner.mjs")
    await writeFile(runner, `import { invokeTargetUpdate } from ${JSON.stringify(source)};
      await invokeTargetUpdate(${JSON.stringify(job)}, 'prepare', process.env, AbortSignal.timeout(60000));`)
    const parent = spawn(process.execPath, [runner], { env: { ...process.env, TARGET_TEST_HANG: "1", TARGET_TEST_STARTED: marker }, stdio: "ignore" })
    let child: number | undefined
    const wait = async (condition: () => Promise<boolean>) => {
      const deadline = Date.now() + 3000
      while (!await condition()) {
        if (Date.now() >= deadline) throw new Error("Process fixture did not reach its bounded condition")
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    try {
      await wait(async () => { child = Number(await readFile(marker, "utf8").catch(() => "")) || undefined; return child !== undefined })
      parent.kill("SIGKILL")
      await new Promise<void>(resolve => parent.once("exit", () => resolve()))
      await expect(advanceTargetUpdate(job, "prepared", randomUUID())).rejects.toThrow("execution lock")
      expect(await readTargetUpdateHandoff(f.paths.atapeHome)).toEqual(job)
      process.kill(child!, "SIGKILL")
      await wait(async () => { const release = await acquireTargetUpdateExecution(f.paths.atapeHome); release?.(); return release !== undefined })
      await recoverPendingUpdate(f.paths, f.bootstrapEntry, process.env)
      expect(await targetUpdatePending(f.paths.atapeHome)).toBe(false)
    } finally { parent.kill("SIGKILL"); if (child) { try { process.kill(child, "SIGKILL") } catch {} } }
  })
  it("retires an obsolete owner after a supported forward npm rebind without routing back", async () => {
    const f = await fixture(), job = await f.begin(), receipt = await f.invoke(job, "prepare")
    const prepared = await advanceTargetUpdate(job, "prepared", receipt.preparedKey!)
    const activating = await advanceTargetUpdate(prepared, "activating", receipt.preparedKey!)
    await finishTargetUpdate(activating, await f.invoke(activating, "activate"))
    await atomicJSON(join(dirname(dirname(f.bootstrapEntry)), "package.json"), { name: "@atape/cli", version: "0.6.0", type: "module",
      atapeRuntime: { stateContract: f.bundle.captureStateContract, updateControlProtocol: f.bundle.updateControlProtocol } })
    await writeFile(f.bootstrapEntry, "if(process.argv.includes('--version')) console.log('ATape 0.6.0')")
    expect((await createUpdateControl(f.paths.atapeHome).rebindBootstrap()).version).toBe("0.6.0")
    await expect(readTargetUpdateOwner(f.paths.atapeHome)).rejects.toThrow("current runtime selection")
    const actualNewRuntime = { version: "0.6.0", captureStateContract: f.bundle.captureStateContract }
    expect(await readTargetUpdateOwner(f.paths.atapeHome, actualNewRuntime)).toBeUndefined()
    expect(await targetOwnerRetirementPending(f.paths.atapeHome, actualNewRuntime)).toBe(true)
    await retireObsoleteTargetOwner(f.paths.atapeHome, actualNewRuntime)
    expect(await readTargetUpdateOwner(f.paths.atapeHome)).toBeUndefined()
    expect((await createUpdateControl(f.paths.atapeHome).readSelection())?.version).toBe("0.6.0")
  })
})
