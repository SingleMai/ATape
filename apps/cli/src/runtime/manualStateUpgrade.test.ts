import { CollectorDaemonProcess } from "@atape/application"
import { emptyClientConfig } from "@atape/domain"
import { Effect } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import { assertManualStateUpgradeReady, prepareManualStateUpgrade, recordV2CollectorAdmission } from "./manualStateUpgrade.ts"
import { makeNodeCollectorDaemonLayer, withCollectorMaintenance } from "./collectorDaemonLayers.ts"
import { recoverPendingUpdate } from "./managedUpdates.ts"
import { acquireProcessLock } from "./processLock.ts"
import { acquireUpdateWorker } from "./updateOwnership.ts"
import { createUpdateControl, updateControlProtocol, type UpdateRuntimeSelection } from "./updateControl.ts"
import { managedStateContract, readRuntimeSelection, resolveRuntimeEntry, runtimeEntry, runtimeSelectionFile } from "./runtimeSelection.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const fixture = async (legacy = true) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "atape-manual-state-upgrade-")))
  directories.push(home)
  const paths = defaultNodeClientPaths({ ATAPE_HOME: home })
  const original = { adapterId: "codex", packageName: "@atape/adapter-codex", upgradeSpec: "@atape/adapter-codex",
    version: "0.5.2", packageSlot: randomUUID(), displayName: "Codex", installedAt: "2026-10-01", updatedAt: "2026-10-01" }
  const selected = { ...original, version: "0.5.3", packageSlot: randomUUID(), updatedAt: "2026-10-02" }
  const custom = { ...original, adapterId: "custom", packageName: "@custom/tool", upgradeSpec: "file:/custom", packageSlot: randomUUID() }
  const config = { ...emptyClientConfig(), locale: "zh-CN", autoUpdateEnabled: false, autoStartEnabled: false,
    activeInstanceOrigin: "https://atape.test", toolsConfigured: true, enabledAdapterIds: ["codex", "custom"], adapters: [original, custom],
    projects: [{ id: "project", instanceOrigin: "https://atape.test", userId: "user", teamId: "team", teamSlug: "team", teamName: "Team",
      name: "Project", type: "directory" as const, path: "/project", createdAt: "2026-10-01" }], futurePreference: "preserved" }
  for (const path of [dirname(paths.configFile), dirname(paths.collectorProcessFile), join(home, "releases"), join(home, "updates")])
    await mkdir(path, { recursive: true, mode: 0o700 })
  await writeFile(paths.configFile, JSON.stringify(config))
  const stopFile = `${paths.collectorProcessFile}.desired.json`
  const stopBytes = '{"version":1,"wanted":false}\n'
  await writeFile(stopFile, stopBytes)
  const captureFile = join(home, "state", "capture-journal.sqlite")
  const captureBytes = Buffer.from("untouched existing journal bytes")
  await writeFile(captureFile, captureBytes)
  const current = { protocol: "atape.runtime.v1", stateContract: "atape.client.v3-capture.v1", version: "0.5.3",
    bootstrapEntry: join(home, "npm", "atape.js"), adapters: [{ before: original, after: selected }] }
  const retained = { ...current, version: "0.5.2", adapters: [] }
  const currentFile = runtimeSelectionFile(home), retainedFile = join(home, "updates", "retained.json")
  const ledgerFile = join(home, "updates", "manual-state-upgrade.json")
  if (legacy) {
    await writeFile(currentFile, JSON.stringify(current))
    await writeFile(retainedFile, JSON.stringify(retained))
  }
  const record = { version: 1, token: randomUUID(), pid: process.pid, startedAt: "2026-10-09", intervalMs: 30_000, concurrency: 1, logFile: paths.collectorLogFile }
  return { home, paths, original, selected, custom, config, stopFile, stopBytes, captureFile, captureBytes,
    current, retained, currentFile, retainedFile, ledgerFile, record,
    run: () => Effect.runPromise(prepareManualStateUpgrade(paths)),
    persisted: async () => JSON.parse(await readFile(paths.configFile, "utf8")) as typeof config,
    ledger: async () => JSON.parse(await readFile(ledgerFile, "utf8")) as { phase: string; contract: string } }
}
const absent = (path: string) => expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
const controlFixture = async () => {
  const f = await fixture(false)
  const bootstrap = join(f.home, "npm", "node_modules", "@atape", "cli", "dist", "atape.js")
  const source = (version: string) => `import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
import { writeFile } from "node:fs/promises";
import { defaultNodeClientPaths } from ${JSON.stringify(new URL("./clientPaths.ts", import.meta.url).href)};
import { admitCollectorProcess } from ${JSON.stringify(new URL("./collectorDaemonLayers.ts", import.meta.url).href)};
import { recordV2CollectorAdmission } from ${JSON.stringify(new URL("./manualStateUpgrade.ts", import.meta.url).href)};
import { createUpdateControl } from ${JSON.stringify(new URL("./updateControl.ts", import.meta.url).href)};
const paths = defaultNodeClientPaths();
const token = process.argv[process.argv.indexOf("--daemon-token") + 1];
await Effect.runPromise(admitCollectorProcess(paths.collectorProcessFile, token));
await createUpdateControl(paths.atapeHome).assertRuntimeAdmission({ version: ${JSON.stringify(version)}, captureStateContract: ${JSON.stringify(managedStateContract)} });
await Effect.runPromise(recordV2CollectorAdmission(paths, token));
if (process.env.ATAPE_TEST_FAIL_VERSION === ${JSON.stringify(version)}) process.exit(1);
if (process.env.ATAPE_COLLECTOR_READY_FILE) await writeFile(process.env.ATAPE_COLLECTOR_READY_FILE, JSON.stringify({ pid: process.pid, token: process.env.ATAPE_COLLECTOR_READY_TOKEN }), { mode: 0o600 });
setInterval(() => {}, 1000);
`
  const writePackage = async (entry: string, version: string, captureStateContract = managedStateContract) => {
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, source(version))
    await writeFile(join(dirname(dirname(entry)), "package.json"), JSON.stringify({ name: "@atape/cli", version, type: "module",
      atapeRuntime: { stateContract: captureStateContract, updateControlProtocol } }))
  }
  await writePackage(bootstrap, "0.5.4")
  const bootstrapIdentity = createHash("sha256").update(await readFile(bootstrap)).digest("hex")
  const generation = async (version: string, captureStateContract = managedStateContract): Promise<UpdateRuntimeSelection> => {
    await writePackage(runtimeEntry(f.home, version), version, captureStateContract)
    return { protocol: updateControlProtocol, version, captureStateContract, bootstrapEntry: bootstrap, bootstrapIdentity, adapters: [] }
  }
  const previous = await generation("0.5.4"), next = await generation("0.5.5")
  const proofFile = join(f.home, "updates", "v2-collector-admission.json")
  const control = createUpdateControl(f.home)
  const runtimeKey = async (entry: string) => createHash("sha256").update(JSON.stringify([process.execPath, await realpath(entry)]))
    .update(await readFile(entry)).digest("hex")
  const startingGate = { version: 1, token: randomUUID(), ownerPid: process.ppid, generation: 0,
    phase: "starting", resume: { intervalMs: 30_000, concurrency: 1 } }
  return { ...f, bootstrap, previous, next, generation, proofFile, control, runtimeKey, startingGate,
    maintenanceFile: `${f.paths.collectorProcessFile}.maintenance.json`,
    readProof: () => readFile(proofFile, "utf8").then(JSON.parse) as Promise<{ pid: number; token: string; contract: string }>,
    daemon: (failVersion?: string) => Effect.runPromise(CollectorDaemonProcess.pipe(Effect.provide(makeNodeCollectorDaemonLayer(
      f.paths, () => resolveRuntimeEntry(f.home, bootstrap), { ...process.env, ATAPE_HOME: f.home, ATAPE_TEST_FAIL_VERSION: failVersion }
    )))) }
}

describe("explicit manual state upgrade through its interactive caller Interface", () => {
  it("materializes the selected Adapter while preserving settings, bindings, Stop and all capture files", async () => {
    const f = await fixture()
    await f.run()
    expect(await f.persisted()).toEqual({ ...f.config, adapters: [f.selected, f.custom] })
    await absent(f.currentFile)
    await absent(f.retainedFile)
    expect(await f.ledger()).toMatchObject({ phase: "completed", contract: managedStateContract })
    expect((await lstat(f.ledgerFile)).mode & 0o077).toBe(0)
    expect(await readFile(f.stopFile, "utf8")).toBe(f.stopBytes)
    expect(await readFile(f.captureFile)).toEqual(f.captureBytes)
    expect(await readRuntimeSelection(f.home)).toBeUndefined()
    const bytes = await readFile(f.ledgerFile)
    await writeFile(f.paths.collectorProcessFile, JSON.stringify(f.record))
    await f.run() // Subsequent consoles remain available while v2 sync runs.
    expect(await readFile(f.ledgerFile)).toEqual(bytes)
  })

  it("does not restore an overlay invalidated by a deliberate local Adapter replacement", async () => {
    const f = await fixture()
    const replacement = { ...f.original, version: "local", upgradeSpec: "file:/local", packageSlot: randomUUID() }
    await writeFile(f.paths.configFile, JSON.stringify({ ...f.config, adapters: [replacement, f.custom] }))
    await f.run()
    expect((await f.persisted()).adapters).toEqual([replacement, f.custom])
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("replays a partial durable transition without undoing later user changes", async () => {
    const f = await fixture()
    const releases = dirname(f.currentFile)
    await chmod(releases, 0o500) // Real unlink failure after ledger/config have been persisted.
    try { await expect(f.run()).rejects.toMatchObject({ reason: "metadata" }) }
    finally { await chmod(releases, 0o700) }
    expect(await f.ledger()).toMatchObject({ phase: "pending" })
    expect((await f.persisted()).adapters[0]).toEqual(f.selected)
    await expect(Effect.runPromise(assertManualStateUpgradeReady(f.paths))).rejects.toMatchObject({ reason: "pending" })
    await expect(recoverPendingUpdate(f.paths, "/new-cli", {})).rejects.toMatchObject({ reason: "pending" })
    await expect(Effect.runPromise(recordV2CollectorAdmission(f.paths, f.record.token))).rejects.toMatchObject({ reason: "metadata" })
    const replacement = { ...f.selected, version: "local", packageSlot: randomUUID(), upgradeSpec: "file:/changed" }
    await writeFile(f.paths.configFile, JSON.stringify({ ...f.config, locale: "en", autoStartEnabled: true, adapters: [replacement, f.custom] }))
    await rm(f.currentFile) // Also represents process death after retiring the first pointer.
    await f.run()
    expect(await f.persisted()).toEqual({ ...f.config, locale: "en", autoStartEnabled: true, adapters: [replacement, f.custom] })
    await absent(f.retainedFile)
    expect(await f.ledger()).toMatchObject({ phase: "completed" })
    expect(await readFile(f.stopFile, "utf8")).toBe(f.stopBytes)
  })

  it.each(["update", "process"] as const)("refuses a live %s owner without transferring configuration or deleting pointers", async lock => {
    const f = await fixture()
    const release = lock === "update" ? await acquireUpdateWorker(f.home) : await acquireProcessLock(`${f.paths.collectorProcessFile}.lock.sqlite`)
    expect(release).toBeTypeOf("function")
    try { await expect(f.run()).rejects.toMatchObject({ reason: "busy" }) }
    finally { release?.() }
    expect(await f.persisted()).toEqual(f.config)
    expect(JSON.parse(await readFile(f.currentFile, "utf8"))).toEqual(f.current)
    await absent(f.ledgerFile)
    await f.run() // Rejection released every lock acquired by this attempt.
  })

  it.each(["pending", "maintenance"] as const)("refuses unfinished old %s without guessing its outcome", async kind => {
    const f = await fixture()
    const file = kind === "pending" ? join(f.home, "updates", "pending.json") : `${f.paths.collectorProcessFile}.maintenance.json`
    const bytes = kind === "pending" ? JSON.stringify({ next: f.current, previous: f.retained }) : "unknown unfinished maintenance"
    await writeFile(file, bytes)
    await expect(f.run()).rejects.toMatchObject({ reason: "pending", message: expect.stringContaining("Restore the old npm CLI") })
    expect(await readFile(file, "utf8")).toBe(bytes)
    expect(await f.persisted()).toEqual(f.config)
    await absent(f.ledgerFile)
  })

  it.each([true, false])("requires stopped collection even when a legacy installation has managed pointers: %s", async legacy => {
    const f = await fixture(legacy)
    await writeFile(f.paths.collectorProcessFile, JSON.stringify(f.record))
    await expect(f.run()).rejects.toMatchObject({ reason: "running" })
    expect(await f.persisted()).toEqual(f.config)
    expect(JSON.parse(await readFile(f.paths.collectorProcessFile, "utf8"))).toEqual(f.record)
    await absent(f.ledgerFile)
  })

  it.skipIf(process.platform === "win32")("admits the first console after a genuine v2 headless Start without managed pointers or a completed receipt", async () => {
    const f = await fixture(false)
    const entry = join(f.home, "capable-collector.mjs")
    await writeFile(entry, `import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
import { defaultNodeClientPaths } from ${JSON.stringify(new URL("./clientPaths.ts", import.meta.url).href)};
import { admitCollectorProcess } from ${JSON.stringify(new URL("./collectorDaemonLayers.ts", import.meta.url).href)};
import { recordV2CollectorAdmission } from ${JSON.stringify(new URL("./manualStateUpgrade.ts", import.meta.url).href)};
const paths = defaultNodeClientPaths();
const token = process.argv[process.argv.indexOf("--daemon-token") + 1];
await Effect.runPromise(admitCollectorProcess(paths.collectorProcessFile, token).pipe(Effect.andThen(recordV2CollectorAdmission(paths, token))));
setInterval(() => {}, 1000);
`)
    const daemon = await Effect.runPromise(CollectorDaemonProcess.pipe(Effect.provide(makeNodeCollectorDaemonLayer(f.paths, entry, { ...process.env, ATAPE_HOME: f.home }))))
    try {
      const started = await Effect.runPromise(daemon.start({ intervalMs: 30_000, concurrency: 1 }))
      const proofFile = join(f.home, "updates", "v2-collector-admission.json")
      await expect.poll(() => readFile(proofFile, "utf8").then(JSON.parse).catch(() => undefined), { timeout: 15_000 }).toMatchObject({ pid: started.pid, contract: managedStateContract })
      await absent(f.ledgerFile)
      await f.run()
      expect((await Effect.runPromise(daemon.inspect()))?.pid).toBe(started.pid)
      await absent(f.ledgerFile)
      await absent(f.currentFile)
      expect(await f.persisted()).toEqual(f.config)
      // The proof cannot exempt another public override context or stale token.
      const proof = JSON.parse(await readFile(proofFile, "utf8"))
      await writeFile(proofFile, JSON.stringify({ ...proof, configFile: "/different-context" }))
      await expect(f.run()).rejects.toMatchObject({ reason: "running" })
      await writeFile(proofFile, JSON.stringify({ ...proof, token: randomUUID() }))
      await expect(f.run()).rejects.toMatchObject({ reason: "running" })
    } finally { await Effect.runPromise(daemon.stop()) }
  }, 25_000)

  it.skipIf(process.platform === "win32")("renews headless admission during an owned control handoff without legacy pointers or an interactive receipt", async () => {
    const f = await controlFixture(), daemon = await f.daemon()
    const release = await acquireUpdateWorker(f.home)
    expect(release).toBeTypeOf("function")
    try {
      const original = await Effect.runPromise(daemon.start({ intervalMs: 30_000, concurrency: 1 }))
      await expect.poll(f.readProof, { timeout: 15_000 }).toMatchObject({ pid: original.pid, contract: managedStateContract })
      await absent(f.currentFile)
      await absent(f.retainedFile)
      await absent(f.ledgerFile)
      const ticket = await withCollectorMaintenance(f.paths, () => resolveRuntimeEntry(f.home, f.bootstrap),
        { ...process.env, ATAPE_HOME: f.home }, async () => {
          const ticket = await f.control.prepare({ next: f.next, previous: f.previous })
          await f.control.begin(ticket)
          return ticket
        }, { readyTimeoutMs: 10_000 })
      await f.control.complete(ticket)
      const current = await Effect.runPromise(daemon.inspect())
      expect(current?.pid).not.toBe(original.pid)
      const processRecord = JSON.parse(await readFile(f.paths.collectorProcessFile, "utf8"))
      expect(await f.readProof()).toMatchObject({ pid: current?.pid, token: processRecord.token })
      expect(await f.control.readSelection()).toEqual(f.next)
      await f.run()
      await absent(f.ledgerFile)
      await absent(f.currentFile)
      await absent(f.retainedFile)
      await absent(f.maintenanceFile)
      expect(await f.persisted()).toEqual(f.config)
      expect(await readFile(f.captureFile)).toEqual(f.captureBytes)
    } finally {
      try { await Effect.runPromise(daemon.stop()) }
      finally { release?.() }
    }
  }, 30_000)

  it.skipIf(process.platform === "win32")("renews admission for the compatible npm fallback after a failed first control handoff", async () => {
    const f = await controlFixture(), daemon = await f.daemon("0.5.5")
    const release = await acquireUpdateWorker(f.home)
    expect(release).toBeTypeOf("function")
    try {
      const original = await Effect.runPromise(daemon.start({ intervalMs: 30_000, concurrency: 1 }))
      await expect.poll(f.readProof, { timeout: 15_000 }).toMatchObject({ pid: original.pid })
      await expect(withCollectorMaintenance(f.paths, () => resolveRuntimeEntry(f.home, f.bootstrap),
        { ...process.env, ATAPE_HOME: f.home, ATAPE_TEST_FAIL_VERSION: "0.5.5" }, async () => {
          const ticket = await f.control.prepare({ next: f.next, previous: f.previous })
          await f.control.begin(ticket)
        }, { readyTimeoutMs: 10_000, recover: async () => { await f.control.recoverSelection() } }
      )).rejects.toMatchObject({ reason: "start", message: "The updated Collector did not become locally ready." })
      await f.control.completeRecovery()
      const fallback = await Effect.runPromise(daemon.inspect())
      expect(fallback?.pid).not.toBe(original.pid)
      const processRecord = JSON.parse(await readFile(f.paths.collectorProcessFile, "utf8"))
      expect(await f.readProof()).toMatchObject({ pid: fallback?.pid, token: processRecord.token })
      expect(await f.control.readSelection()).toBeUndefined()
      expect(await f.control.recoveryPending()).toBe(false)
      await f.run()
      await absent(f.ledgerFile)
      await absent(f.currentFile)
      await absent(f.retainedFile)
      await absent(f.maintenanceFile)
      expect(await f.persisted()).toEqual(f.config)
      expect(await readFile(f.captureFile)).toEqual(f.captureBytes)
    } finally {
      try { await Effect.runPromise(daemon.stop()) }
      finally { release?.() }
    }
  }, 35_000)

  it.each(["failed gate", "malformed gate", "absent gate", "foreign runtime", "foreign transaction", "malformed control", "no owner", "capture contract"] as const)(
    "rejects %s before recording independent control admission", async kind => {
      const f = await controlFixture()
      const next = kind === "capture contract" ? await f.generation("0.6.0", "atape.client.v3-capture.v3") : f.next
      const release = await acquireUpdateWorker(f.home)
      expect(release).toBeTypeOf("function")
      try {
        const ticket = await f.control.prepare({ next, previous: f.previous })
        await f.control.begin(ticket)
        await writeFile(f.paths.collectorProcessFile, JSON.stringify({ ...f.record,
          runtimeKey: kind === "foreign runtime" ? "foreign" : await f.runtimeKey(runtimeEntry(f.home, next.version)) }))
        await writeFile(f.maintenanceFile, JSON.stringify(f.startingGate))
        if (kind === "failed gate") await writeFile(f.maintenanceFile, JSON.stringify({ ...f.startingGate, phase: "failed" }))
        if (kind === "malformed gate") await writeFile(f.maintenanceFile, "{")
        if (kind === "absent gate") await rm(f.maintenanceFile)
        if (kind === "foreign transaction") await writeFile(join(f.home, "updates", "runtime.json"), JSON.stringify(f.previous))
        if (kind === "malformed control") await writeFile(join(f.home, "updates", "control.json"), "{")
        if (kind === "no owner") release?.() // The diagnostic PID remains live; it cannot prove ownership.
        await expect(Effect.runPromise(recordV2CollectorAdmission(f.paths, f.record.token))).rejects.toMatchObject({ reason: "metadata" })
        await absent(f.proofFile)
        await absent(f.ledgerFile)
        expect(await f.persisted()).toEqual(f.config)
        expect(await readFile(f.captureFile)).toEqual(f.captureBytes)
      } finally { release?.() }
    })

  it.each(["v1 current", "v1 pending", "manual migration", "foreign token"] as const)(
    "keeps %s outside independent control admission", async kind => {
      const f = await controlFixture(), release = await acquireUpdateWorker(f.home)
      expect(release).toBeTypeOf("function")
      try {
        const ticket = await f.control.prepare({ next: f.next, previous: f.previous })
        await f.control.begin(ticket)
        await writeFile(f.paths.collectorProcessFile, JSON.stringify({ ...f.record, runtimeKey: await f.runtimeKey(runtimeEntry(f.home, f.next.version)) }))
        await writeFile(f.maintenanceFile, JSON.stringify(f.startingGate))
        if (kind === "v1 current") await writeFile(f.currentFile, JSON.stringify(f.current))
        if (kind === "v1 pending") await writeFile(join(f.home, "updates", "pending.json"), JSON.stringify({ next: f.current }))
        if (kind === "manual migration") await writeFile(f.ledgerFile, JSON.stringify({ protocol: "atape.manual-state-upgrade.v1", contract: managedStateContract,
          home: f.home, phase: "pending", configFile: f.paths.configFile, processFile: f.paths.collectorProcessFile }), { mode: 0o600 })
        await expect(Effect.runPromise(recordV2CollectorAdmission(f.paths, kind === "foreign token" ? randomUUID() : f.record.token)))
          .rejects.toMatchObject({ reason: kind === "foreign token" ? "running" : "metadata" })
        await absent(f.proofFile)
        expect(await f.persisted()).toEqual(f.config)
      } finally { release?.() }
    })

  it("binds a completed receipt to its configuration and process context", async () => {
    const f = await fixture()
    await f.run()
    const bytes = await readFile(f.ledgerFile)
    for (const paths of [{ ...f.paths, configFile: join(f.home, "other-config.json") }, { ...f.paths, collectorProcessFile: join(f.home, "other-process.json") }])
      await expect(Effect.runPromise(prepareManualStateUpgrade(paths))).rejects.toMatchObject({ reason: "metadata", message: expect.stringContaining("Keep ATAPE_CONFIG_FILE") })
    expect(await readFile(f.ledgerFile)).toEqual(bytes)
  })

  it("keeps a dead process marker and wanted intent unchanged while accepting a stopped installation", async () => {
    const f = await fixture()
    const desired = '{"version":1,"wanted":true,"established":true,"intervalMs":30000,"concurrency":1}'
    await writeFile(f.stopFile, desired)
    await writeFile(f.paths.collectorProcessFile, JSON.stringify({ ...f.record, pid: 2147483647, restartPending: true }))
    const bytes = await readFile(f.paths.collectorProcessFile)
    await f.run()
    expect(await readFile(f.paths.collectorProcessFile)).toEqual(bytes)
    expect(await readFile(f.stopFile, "utf8")).toBe(desired)
  })

  it("leaves an already selected v2 runtime to normal update recovery", async () => {
    const f = await fixture(false)
    await writeFile(f.currentFile, JSON.stringify({ ...f.current, stateContract: managedStateContract }))
    await writeFile(join(f.home, "updates", "pending.json"), JSON.stringify({ next: { ...f.current, stateContract: managedStateContract } }))
    await writeFile(f.paths.collectorProcessFile, JSON.stringify(f.record))
    await f.run()
    expect((await readRuntimeSelection(f.home))?.stateContract).toBe(managedStateContract)
    await absent(f.ledgerFile)
  })

  it.each(["contract", "shape", "retained", "process"] as const)("rejects unknown %s metadata before changing any state", async kind => {
    const f = await fixture()
    if (kind === "contract") await writeFile(f.currentFile, JSON.stringify({ ...f.current, stateContract: "unknown" }))
    if (kind === "shape") await writeFile(f.currentFile, JSON.stringify({ ...f.current, adapters: [{ before: f.original, after: { ...f.selected, version: "wrong" } }] }))
    if (kind === "retained") await writeFile(f.retainedFile, "invalid-json")
    if (kind === "process") await writeFile(f.paths.collectorProcessFile, "{}")
    const before = await readFile(f.currentFile)
    await expect(f.run()).rejects.toMatchObject({ reason: "metadata" })
    expect(await f.persisted()).toEqual(f.config)
    expect(await readFile(f.currentFile)).toEqual(before)
    await absent(f.ledgerFile)
  })

  it.each(["oversized", "unknown", "public", "symlink"] as const)("refuses an %s ledger instead of guessing replay", async kind => {
    const f = await fixture()
    if (kind === "oversized") await writeFile(f.ledgerFile, " ".repeat(1024 * 1024 + 1), { mode: 0o600 })
    if (kind === "unknown") await writeFile(f.ledgerFile, '{"protocol":"unknown"}', { mode: 0o600 })
    if (kind === "public") await writeFile(f.ledgerFile, '{}', { mode: 0o644 })
    if (kind === "symlink") await symlink(f.currentFile, f.ledgerFile)
    await expect(f.run()).rejects.toMatchObject({ reason: "metadata" })
    expect(await f.persisted()).toEqual(f.config)
    expect(JSON.parse(await readFile(f.currentFile, "utf8"))).toEqual(f.current)
  })

  it("rejects old pointers reintroduced after a completed migration", async () => {
    const f = await fixture()
    await f.run()
    await writeFile(f.currentFile, JSON.stringify(f.current))
    await expect(f.run()).rejects.toMatchObject({ reason: "metadata" })
    expect((await f.persisted()).adapters[0]).toEqual(f.selected)
    expect(JSON.parse(await readFile(f.currentFile, "utf8"))).toEqual(f.current)
  })
})
