import { CollectorDaemonProcess, CollectorRunStatusStore, type CollectorRedactionJobEvent } from "@atape/application"
import { Effect } from "effect"
import { execFileSync, spawn } from "node:child_process"
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { admitCollectorProcess, isCollectorMaintenancePending, makeNodeCollectorDaemonLayer, makeCollectorRunStatusLayer,
  CollectorMaintenanceFailure, withCollectorMaintenance } from "./collectorDaemonLayers.ts"
import { acquireProcessLock } from "./processLock.ts"
import { assertRuntimeDataAdmission } from "./runtimeAdmission.ts"
import { runtimeWriterFixture } from "./fixtures/runtime-writer-admission.ts"

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("Node Collector run status Adapter", () => {
  const redactionFixture = async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-redaction-status-"))
    temporaryDirectories.push(root)
    const processFile = join(root, "process.json"), statusFile = join(root, "status.json"), configFile = join(root, "redaction.json")
    const owner = async (token: string, pid = process.pid) => writeFile(processFile, JSON.stringify({ version: 1, token, pid,
      startedAt: "2026-10-10T01:00:00.000Z", intervalMs: 30000, concurrency: 4, logFile: join(root, "collector.log") }))
    const store = (token?: string) => Effect.runPromise(CollectorRunStatusStore.pipe(Effect.provide(makeCollectorRunStatusLayer(statusFile,
      token === undefined ? undefined : { processFile, collectorToken: token, configFile, origin: "default" }))))
    const snapshot = { configFile, origin: "default" as const, revision: "saved-revision", exists: true, literalCount: 2, customRuleCount: 1 }
    const event = (attemptId: string, kind: "loading" | "loaded", at = "2026-10-10T01:00:00.000Z"): CollectorRedactionJobEvent =>
      kind === "loading" ? { kind, projectId: "project", adapterId: "claude", attemptId, at }
        : { kind, projectId: "project", adapterId: "claude", attemptId, at, snapshot }
    return { root, processFile, statusFile, configFile, owner, store, snapshot, event }
  }

  it("does not create status files for foreground redaction and reads legacy v1 state", async () => {
    const f = await redactionFixture(), store = await f.store()
    await Effect.runPromise(store.recordRedactionJob(f.event("foreground", "loading")))
    expect(await readdir(f.root)).toEqual([])
    expect(await Effect.runPromise(store.read())).toEqual({ version: 1, jobs: [] })
    expect(await readdir(f.root)).toEqual([])
    await writeFile(f.statusFile, JSON.stringify({ version: 1, jobs: [] }))
    expect(await Effect.runPromise(store.read())).toEqual({ version: 1, jobs: [] })
  })

  it("atomically merges concurrent independent status writers without losing jobs or policy observations", async () => {
    const f = await redactionFixture()
    await f.owner("admitted-token")
    const stores = await Promise.all([f.store("admitted-token"), f.store("admitted-token")])
    await Promise.all(Array.from({ length: 12 }, async (_, index) => {
      const store = stores[index % 2]!, adapterId = `adapter-${index}`
      await Promise.all([
        Effect.runPromise(store.recordRedactionJob({ kind: "loading", projectId: "project", adapterId,
          attemptId: `attempt-${index}`, at: "2026-10-10T01:00:00.000Z" })),
        Effect.runPromise(store.recordCycle({ startedAt: "2026-10-10T01:00:00.000Z", completedAt: "2026-10-10T01:00:01.000Z",
          jobs: [{ projectId: "project", adapterId, pages: 1, observations: 1, canonicalBatches: 1,
            rawChunks: 1, redactions: 0, hasMore: false }], failures: [] }))
      ])
    }))
    const current = await Effect.runPromise(stores[0]!.read())
    expect(current.jobs).toHaveLength(12)
    expect(current.redaction?.jobs).toHaveLength(12)
    expect(current.redaction).toMatchObject({ generation: createHash("sha256").update("admitted-token").digest("hex"),
      configFile: f.configFile, origin: "default" })
    await Effect.runPromise(stores[1]!.recordCollectorFailure({ occurredAt: "2026-10-10T01:00:02.000Z",
      message: "Configuration unavailable" }))
    expect((await Effect.runPromise(stores[0]!.read())).redaction).toEqual(current.redaction)
    expect((await stat(f.statusFile)).mode & 0o777).toBe(0o600)
    expect(await readFile(f.statusFile, "utf8")).not.toContain("admitted-token")
  })

  it("reads complete published snapshots while concurrent writers replace the status file", async () => {
    const f = await redactionFixture(), store = await f.store()
    const report = (observations: number) => ({
      startedAt: "2026-10-10T01:00:00.000Z", completedAt: "2026-10-10T01:00:01.000Z",
      jobs: Array.from({ length: 128 }, (_, index) => ({ projectId: `project-${index}`, adapterId: "claude",
        pages: 1, observations, canonicalBatches: 1, rawChunks: 1, redactions: 0, hasMore: false })), failures: []
    })
    await Effect.runPromise(store.recordCycle(report(1)))
    const readSnapshots = async () => {
      for (let index = 0; index < 96; index++) {
        const state = await Effect.runPromise(store.read())
        expect(state.jobs).toHaveLength(128)
        expect([1, 2]).toContain(state.jobs[0]!.observations)
        expect(state.jobs.every(job => job.observations === state.jobs[0]!.observations)).toBe(true)
      }
    }
    await Promise.all([
      (async () => {
        for (let index = 0; index < 64; index++) await Effect.runPromise(store.recordCycle(report(index % 2 + 1)))
      })(), readSnapshots(), readSnapshots()
    ])
  })

  it("fences stale attempts, resets new snapshots, and prevents old or wrong processes claiming the new generation", async () => {
    const f = await redactionFixture()
    await f.owner("generation-a")
    const first = await f.store("generation-a")
    await Effect.runPromise(first.recordRedactionJob(f.event("old", "loading")))
    await Effect.runPromise(first.recordRedactionJob(f.event("old", "loaded")))
    await Effect.runPromise(first.recordRedactionJob(f.event("new", "loading")))
    expect((await Effect.runPromise(first.read())).redaction?.jobs[0]).not.toHaveProperty("snapshot")
    await Effect.runPromise(first.recordRedactionJob(f.event("old", "loaded")))
    await Effect.runPromise(first.recordRedactionJob({ ...f.event("old", "loading"), kind: "finished", outcome: "load_failed" }))
    expect((await Effect.runPromise(first.read())).redaction?.jobs[0]).toMatchObject({ attemptId: "new", phase: "loading" })
    await Effect.runPromise(first.recordRedactionJob(f.event("new", "loaded")))
    await Effect.runPromise(first.recordRedactionJob({ ...f.event("new", "loading"), kind: "finished", outcome: "failed" }))
    await Effect.runPromise(first.recordRedactionJob(f.event("new", "loaded")))
    expect((await Effect.runPromise(first.read())).redaction?.jobs[0]).toMatchObject({ phase: "failed", snapshot: f.snapshot })

    await f.owner("generation-b")
    const second = await f.store("generation-b")
    await Effect.runPromise(second.recordRedactionJob(f.event("new-process", "loading")))
    const baseline = await readFile(f.statusFile, "utf8")
    await Effect.runPromise(first.recordRedactionJob(f.event("late-old-process", "loading")))
    expect(await readFile(f.statusFile, "utf8")).toBe(baseline)
    await f.owner("generation-b", process.pid + 1)
    await Effect.runPromise(second.recordRedactionJob(f.event("new-process", "loaded")))
    expect(await readFile(f.statusFile, "utf8")).toBe(baseline)
    await f.owner("generation-b")
    await Effect.runPromise(second.recordRedactionJob({ ...f.event("new-process", "loading"), kind: "finished", outcome: "load_failed" }))
    expect((await Effect.runPromise(second.read())).redaction?.jobs).toEqual([expect.objectContaining({ phase: "load_failed" })])
    expect((await Effect.runPromise(second.read())).redaction?.jobs[0]).not.toHaveProperty("snapshot")
    expect(await readFile(f.statusFile, "utf8")).not.toMatch(/generation-a|generation-b/)
  })

  it("uses attempt identity and phase rather than wall-clock order across clock corrections", async () => {
    const f = await redactionFixture()
    await f.owner("admitted-token")
    const store = await f.store("admitted-token")
    await Effect.runPromise(store.recordRedactionJob(f.event("first", "loading", "2026-10-10T01:00:30.000Z")))
    await Effect.runPromise(store.recordRedactionJob(f.event("first", "loaded", "2026-10-10T01:00:20.000Z")))
    expect((await Effect.runPromise(store.read())).redaction?.jobs[0]).toMatchObject({ phase: "active", snapshot: f.snapshot,
      startedAt: "2026-10-10T01:00:30.000Z", updatedAt: "2026-10-10T01:00:20.000Z" })
    await Effect.runPromise(store.recordRedactionJob({ ...f.event("first", "loading", "2026-10-10T01:00:10.000Z"),
      kind: "finished", outcome: "completed" }))
    expect((await Effect.runPromise(store.read())).redaction?.jobs[0]).toMatchObject({ phase: "completed", snapshot: f.snapshot,
      updatedAt: "2026-10-10T01:00:10.000Z" })
    await Effect.runPromise(store.recordRedactionJob(f.event("next", "loading", "2026-10-10T01:00:00.000Z")))
    await Effect.runPromise(store.recordRedactionJob(f.event("next", "loaded", "2026-10-10T00:59:50.000Z")))
    const active = await readFile(f.statusFile, "utf8")
    await Effect.runPromise(store.recordRedactionJob(f.event("first", "loaded", "2026-10-10T02:00:00.000Z")))
    await Effect.runPromise(store.recordRedactionJob({ ...f.event("first", "loading", "2026-10-10T02:00:00.000Z"),
      kind: "finished", outcome: "failed" }))
    expect(await readFile(f.statusFile, "utf8")).toBe(active)
    await Effect.runPromise(store.recordRedactionJob({ ...f.event("next", "loading", "2026-10-10T00:59:40.000Z"),
      kind: "finished", outcome: "completed" }))
    const completed = await readFile(f.statusFile, "utf8")
    await Effect.runPromise(store.recordRedactionJob(f.event("next", "loading", "2026-10-10T03:00:00.000Z")))
    expect(await readFile(f.statusFile, "utf8")).toBe(completed)
    expect((await Effect.runPromise(store.read())).redaction?.jobs[0]).toMatchObject({ attemptId: "next", phase: "completed",
      startedAt: "2026-10-10T01:00:00.000Z", updatedAt: "2026-10-10T00:59:40.000Z", snapshot: f.snapshot })
  })

  it("retains transaction exclusion through cancellation before merging the next writer", async () => {
    const f = await redactionFixture()
    await f.owner("admitted-token")
    const store = await f.store("admitted-token"), cancellation = new AbortController()
    const release = (await acquireProcessLock(`${f.statusFile}.lock.sqlite`))!
    const interrupted = Effect.runPromise(store.recordRedactionJob(f.event("cancelled-caller", "loading")), { signal: cancellation.signal })
    // Attach the handler before aborting, then let the bounded transaction
    // finish after lock contention even though its caller has gone away.
    const settled = interrupted.catch(() => undefined)
    cancellation.abort()
    release()
    await settled
    await Effect.runPromise(store.recordCycle({ startedAt: "2026-10-10T01:00:00.000Z", completedAt: "2026-10-10T01:00:01.000Z",
      jobs: [{ projectId: "project", adapterId: "claude", pages: 1, observations: 1, canonicalBatches: 1,
        rawChunks: 1, redactions: 0, hasMore: false }], failures: [] }))
    const status = await Effect.runPromise(store.read())
    expect(status.jobs).toHaveLength(1)
    expect(status.redaction?.jobs[0]).toMatchObject({ attemptId: "cancelled-caller", phase: "loading" })
  })

  it("fails safely on malformed, oversized and symlinked run status without echoing source contents", async () => {
    const f = await redactionFixture(), store = await f.store()
    for (const content of ['{"secret":"do-not-echo"', JSON.stringify({ version: 1, jobs: "do-not-echo" }),
      Buffer.from([0xff]), " ".repeat(8 * 1024 * 1024 + 1)]) {
      await writeFile(f.statusFile, content)
      await expect(Effect.runPromise(store.read())).rejects.toThrow(/Collector run status/)
      try { await Effect.runPromise(store.read()) } catch (cause) { expect(String(cause)).not.toContain("do-not-echo") }
    }
    await rm(f.statusFile)
    await symlink(f.processFile, f.statusFile)
    await expect(Effect.runPromise(store.read())).rejects.toThrow("Could not read Collector run status.")
  })

  it("retains last success while exposing the current failure reason", async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-run-status-"))
    temporaryDirectories.push(root)
    await mkdir(join(root, "state"))
    const layer = makeCollectorRunStatusLayer(join(root, "state", "status.json"))
    const run = <A, E>(effect: Effect.Effect<A, E, CollectorRunStatusStore>) =>
      effect.pipe(Effect.provide(layer), Effect.runPromise)
    const first = {
      startedAt: "2026-09-05T02:30:00.000Z",
      completedAt: "2026-09-05T02:30:01.000Z",
      jobs: [{
        projectId: "atape",
        adapterId: "codex",
        pages: 1,
        observations: 2,
        canonicalBatches: 2,
        rawChunks: 3,
        redactions: 1,
        progress: { phase: "raw" as const, sourceFiles: 5, pendingRawBytes: 400 },
        canonicalEvents: 100, rawBytes: 200, durationMs: 1000,
        hasMore: false
      }],
      failures: []
    }
    const second = {
      startedAt: "2026-09-05T02:31:00.000Z",
      completedAt: "2026-09-05T02:31:01.000Z",
      jobs: [],
      failures: [{
        projectId: "atape",
        adapterId: "codex",
        reason: "transport" as const,
        retryable: true,
        message: "Server unavailable"
      }]
    }

    await run(Effect.gen(function*() {
      const statuses = yield* CollectorRunStatusStore
      yield* statuses.recordCycle({ ...first, jobs: first.jobs.map(job => ({ ...job,
        sourceFailures: [{ source: "/history/broken.jsonl", reason: "format" as const }], sourceFailuresTruncated: true
      })) })
      expect((yield* statuses.read()).jobs[0]).toMatchObject({
        sourceFailures: [{ source: "/history/broken.jsonl", reason: "format" }], sourceFailuresTruncated: true
      })
      yield* statuses.recordCycle(first)
      expect((yield* statuses.read()).jobs[0]).not.toHaveProperty("sourceFailures")
      expect((yield* statuses.read()).jobs[0]).not.toHaveProperty("sourceFailuresTruncated")
      yield* statuses.recordCycle(second)
    }))
    const status = await run(Effect.gen(function*() {
      return yield* (yield* CollectorRunStatusStore).read()
    }))

    expect(status.jobs).toEqual([expect.objectContaining({
      projectId: "atape",
      adapterId: "codex",
      lastSuccessAt: first.completedAt,
      lastFailureAt: second.completedAt,
      failureMessage: "Server unavailable",
      failureReason: "transport",
      retryable: true
    })])
    expect(status.jobs[0]).not.toHaveProperty("rawBytes")
    expect(status.jobs[0]).not.toHaveProperty("progress")
  })
})

describe.skipIf(process.platform === "win32")("managed Collector executable replacement", () => {
  const fixture = async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-process-refresh-"))
    temporaryDirectories.push(root)
    const entry = join(root, "cli.mjs"), marker = join(root, "started.json")
    const paths = { collectorProcessFile: join(root, "process.json"),
      collectorStatusFile: join(root, "status.json"), collectorLogFile: join(root, "collector.log") }
    const replace = (build: string, options: { readonly ignoreTermination?: boolean; readonly ready?: boolean;
      readonly exitDuringReadiness?: boolean; readonly readyMarker?: "directory" | "malformed" | "foreign" } = {}) => writeFile(entry, `import { mkdirSync, renameSync, writeFileSync } from "node:fs";
${options.ignoreTermination ? 'process.on("SIGTERM", () => {});' : ""}
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({build:${JSON.stringify(build)},pid:process.pid}));
if (process.env.ATAPE_COLLECTOR_READY_FILE && ${options.exitDuringReadiness === true}) process.exit(1);
if (process.env.ATAPE_COLLECTOR_READY_FILE && ${options.readyMarker === "directory"}) mkdirSync(process.env.ATAPE_COLLECTOR_READY_FILE);
if (process.env.ATAPE_COLLECTOR_READY_FILE && ${options.readyMarker === "malformed"}) writeFileSync(process.env.ATAPE_COLLECTOR_READY_FILE, '{"token":');
if (process.env.ATAPE_COLLECTOR_READY_FILE && ${options.ready !== false}) {
  const temporary = process.env.ATAPE_COLLECTOR_READY_FILE + "." + process.pid + ".tmp";
  writeFileSync(temporary, JSON.stringify({token:${options.readyMarker === "foreign"} ? "foreign" : process.env.ATAPE_COLLECTOR_READY_TOKEN,pid:process.pid}));
  renameSync(temporary, process.env.ATAPE_COLLECTOR_READY_FILE);
}
setInterval(() => {}, 1000);
`)
    await replace("original")
    const layer = makeNodeCollectorDaemonLayer(paths, entry)
    const run = <A, E>(effect: Effect.Effect<A, E, CollectorDaemonProcess>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)))
    const daemon = await run(CollectorDaemonProcess)
    return { ...paths, entry, replace, run, daemon,
      // A retained 0.5.3 UI knows the PID and maintenance protocol, but does
      // not read or update the new durable intent file.
      legacyStop: async () => {
        const release = (await acquireProcessLock(`${paths.collectorProcessFile}.lock.sqlite`, 10_000))!
        try {
          const gateFile = `${paths.collectorProcessFile}.maintenance.json`
          const gate = await readFile(gateFile, "utf8").then(value => JSON.parse(value)).catch(() => undefined)
          if (gate) {
            const { resume: _, ...stopped } = gate
            await writeFile(gateFile, JSON.stringify({ ...stopped, generation: gate.generation + 1 }))
          }
          const record = await readFile(paths.collectorProcessFile, "utf8").then(value => JSON.parse(value)).catch(() => undefined)
          if (record) {
            try { process.kill(record.pid, "SIGTERM") } catch { /* Already exited. */ }
            await expect.poll(() => {
              try { process.kill(record.pid, 0); return true } catch { return false }
            }).toBe(false)
            await rm(paths.collectorProcessFile, { force: true })
          }
        } finally { release() }
      },
      started: async (build: string, pid: number) => {
        await expect.poll(async () => JSON.parse(await readFile(marker, "utf8"))).toEqual({ build, pid })
      } }
  }

  it("observes an absent process without creating files or locks", async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-process-observe-"))
    temporaryDirectories.push(root)
    const daemon = await Effect.runPromise(CollectorDaemonProcess.pipe(Effect.provide(makeNodeCollectorDaemonLayer({
      collectorProcessFile: join(root, "state", "process.json"), collectorStatusFile: join(root, "state", "status.json"),
      collectorLogFile: join(root, "logs", "collector.log")
    }, join(root, "missing-entry.mjs")))))
    expect(await Effect.runPromise(daemon.observe())).toBeUndefined()
    expect(await readdir(root)).toEqual([])
  })

  it("observes the owned generation purely and treats live ownership mismatch as unknown", async () => {
    const f = await fixture()
    const started = await f.run(f.daemon.start({ intervalMs: 30000, concurrency: 1 }))
    await f.started("original", started.pid)
    const original = await readFile(f.collectorProcessFile, "utf8"), record = JSON.parse(original)
    try {
      const files = await readdir(join(f.collectorProcessFile, ".."))
      expect(await f.run(f.daemon.observe())).toEqual({ generation: createHash("sha256").update(record.token).digest("hex"),
        pid: started.pid, startedAt: started.startedAt })
      expect(await readFile(f.collectorProcessFile, "utf8")).toBe(original)
      expect(await readdir(join(f.collectorProcessFile, ".."))).toEqual(files)
      await writeFile(f.collectorProcessFile, JSON.stringify({ ...record, token: record.token.slice(0, 8) }))
      await expect(f.run(f.daemon.observe())).rejects.toThrow("Could not confirm the current Collector process.")
      await writeFile(f.collectorProcessFile, JSON.stringify({ ...record, token: "secret-wrong-token" }))
      await expect(f.run(f.daemon.observe())).rejects.toThrow("Could not confirm the current Collector process.")
      await writeFile(f.collectorProcessFile, '{"secret":"do-not-echo"')
      await expect(f.run(f.daemon.observe())).rejects.toThrow("Could not confirm the current Collector process.")
    } finally {
      await writeFile(f.collectorProcessFile, original)
      await f.run(f.daemon.stop())
    }
    await writeFile(f.collectorProcessFile, original)
    expect(await f.run(f.daemon.observe())).toBeUndefined()
    expect(await readFile(f.collectorProcessFile, "utf8")).toBe(original)
  })

  it("admits only the process and token published by the spawning parent, without waiting on its launch lock", async () => {
    const f = await fixture()
    const release = (await acquireProcessLock(`${f.collectorProcessFile}.lock.sqlite`))!
    const admitted = Effect.runPromise(admitCollectorProcess(f.collectorProcessFile, "owned-child"))
    await new Promise(resolve => setTimeout(resolve, 50))
    const published = `${f.collectorProcessFile}.published`
    await writeFile(published, JSON.stringify({ version: 1, token: "owned-child", pid: process.pid,
      startedAt: new Date().toISOString(), intervalMs: 30000, concurrency: 4, logFile: f.collectorLogFile }))
    await rename(published, f.collectorProcessFile)
    try { await expect(admitted).resolves.toBeUndefined() }
    finally { release() }
  })

  it.each([
    { token: "wrong-token", pid: process.pid },
    { token: "owned-child", pid: process.pid + 1 }
  ])("rejects unowned private Collector invocation %# within a finite admission window", async ({ token, pid }) => {
    const f = await fixture()
    await writeFile(f.collectorProcessFile, JSON.stringify({ version: 1, token, pid,
      startedAt: new Date().toISOString(), intervalMs: 30000, concurrency: 4, logFile: f.collectorLogFile }))
    const started = performance.now()
    await expect(Effect.runPromise(admitCollectorProcess(f.collectorProcessFile, "owned-child")))
      .rejects.toMatchObject({ reason: "identity" })
    expect(performance.now() - started).toBeLessThan(2_750)
  })

  it("cancels admission while waiting for the parent to publish ownership", async () => {
    const f = await fixture(), cancellation = new AbortController()
    const admitted = Effect.runPromise(admitCollectorProcess(f.collectorProcessFile, "owned-child"), { signal: cancellation.signal })
    setTimeout(() => cancellation.abort(), 50)
    const started = performance.now()
    await expect(admitted).rejects.toBeDefined()
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it("restarts changed bytes with the saved schedule, preserves current processes, and never starts stopped sync", async () => {
    const f = await fixture()
    try {
      expect(await f.run(f.daemon.refresh())).toBe(false)
      expect(await f.run(f.daemon.inspect())).toBeUndefined()
      const original = await f.run(f.daemon.start({ intervalMs: 45000, concurrency: 2 }))
      await f.started("original", original.pid)
      expect(await f.run(f.daemon.refresh())).toBe(false)
      await f.replace("replacement-same-version")
      expect(await f.run(f.daemon.refresh())).toBe(true)
      const current = await f.run(f.daemon.inspect())
      expect(current).toMatchObject({ intervalMs: 45000, concurrency: 2 })
      expect(current!.pid).not.toBe(original.pid)
      await f.started("replacement-same-version", current!.pid)
      expect(await f.run(f.daemon.refresh())).toBe(false)
      expect((await f.run(f.daemon.start({ intervalMs: 30000, concurrency: 4 }))).pid).toBe(current!.pid)
      await f.run(f.daemon.stop())
      await f.replace("stopped-replacement")
      expect(await f.run(f.daemon.refresh())).toBe(false)
      expect(await f.run(f.daemon.inspect())).toBeUndefined()
    } finally { await f.run(f.daemon.stop()) }
  })

  it("persists Start across process loss and concurrent login resumes without creating a second Collector", async () => {
    const f = await fixture()
    try {
      expect(await f.run(f.daemon.resume())).toBeUndefined()
      const original = await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      await f.started("original", original.pid)
      process.kill(original.pid, "SIGKILL")
      await expect.poll(() => f.run(f.daemon.inspect())).toBeUndefined()
      expect(JSON.parse(await readFile(f.collectorProcessFile, "utf8"))).toMatchObject({ restartPending: true })
      const [first, second] = await Promise.all([f.run(f.daemon.resume()), f.run(f.daemon.resume())])
      expect(first).toMatchObject({ intervalMs: 60000, concurrency: 3 })
      expect(second).toMatchObject({ pid: first!.pid, intervalMs: 60000, concurrency: 3 })
      // Concurrent lock acquisition has no ordering by Promise.all position.
      expect([first!.created, second!.created].sort()).toEqual([false, true])
      expect(first!.pid).not.toBe(original.pid)
      await f.started("original", first!.pid)
      await f.run(f.daemon.stop())
      expect(await f.run(f.daemon.resume())).toBeUndefined()
      expect(await f.run(f.daemon.stop())).toBe(false)
      expect(await f.run(f.daemon.resume())).toBeUndefined()
    } finally { await f.run(f.daemon.stop()) }
  })

  it("serializes user Stop with login resume and keeps the stopped intent for later triggers", async () => {
    const f = await fixture()
    let release!: () => void, entered!: () => void
    const resolving = new Promise<void>(resolve => { entered = resolve })
    const waiting = new Promise<void>(resolve => { release = resolve })
    const layer = makeNodeCollectorDaemonLayer(f, async () => { entered(); await waiting; return f.entry })
    const daemon = await Effect.runPromise(CollectorDaemonProcess.pipe(Effect.provide(layer)))
    try {
      const original = await f.run(f.daemon.start({ intervalMs: 45000, concurrency: 2 }))
      process.kill(original.pid, "SIGKILL")
      await expect.poll(() => f.run(f.daemon.inspect())).toBeUndefined()
      const resuming = Effect.runPromise(daemon.resume())
      await resolving
      const stopping = f.run(f.daemon.stop())
      release()
      await expect(resuming).resolves.toMatchObject({ intervalMs: 45000, concurrency: 2 })
      await expect(stopping).resolves.toBe(true)
      expect(await f.run(f.daemon.inspect())).toBeUndefined()
      expect(await f.run(f.daemon.resume())).toBeUndefined()
    } finally { release?.(); await f.run(f.daemon.stop()) }
  })

  it("resolves the selected runtime again when resuming after a lost process", async () => {
    const f = await fixture(), replacement = join(f.entry, "..", "login-selected.mjs")
    try {
      const original = await f.run(f.daemon.start({ intervalMs: 45000, concurrency: 2 }))
      process.kill(original.pid, "SIGKILL")
      await expect.poll(() => f.run(f.daemon.inspect())).toBeUndefined()
      await f.replace("login-selected")
      await copyFile(f.entry, replacement)
      await f.replace("original")
      const layer = makeNodeCollectorDaemonLayer(f, async () => replacement)
      const resumed = await Effect.runPromise(CollectorDaemonProcess.use(process => process.resume()).pipe(Effect.provide(layer)))
      expect(resumed).toMatchObject({ intervalMs: 45000, concurrency: 2 })
      await f.started("login-selected", resumed!.pid)
    } finally { await f.run(f.daemon.stop()) }
  })

  it("migrates missing intent only from a confirmed running legacy Collector", async () => {
    const f = await fixture()
    try {
      const original = await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      await rm(`${f.collectorProcessFile}.desired.json`)
      expect(await f.run(f.daemon.resume())).toMatchObject({ pid: original.pid, created: false })
      process.kill(original.pid, "SIGKILL")
      await expect.poll(() => f.run(f.daemon.inspect())).toBeUndefined()
      expect(await f.run(f.daemon.resume())).toMatchObject({ intervalMs: 60000, concurrency: 3, created: true })
    } finally { await f.run(f.daemon.stop()) }
  })

  it.each(["legacy", "current"] as const)("does not revive collection after a retained 0.5.3 Stop with %s established intent", async version => {
    const f = await fixture()
    try {
      const original = await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      if (version === "legacy") await rm(`${f.collectorProcessFile}.desired.json`)
      expect(await f.run(f.daemon.inspect())).toMatchObject({ pid: original.pid })
      expect(JSON.parse(await readFile(`${f.collectorProcessFile}.desired.json`, "utf8")))
        .toMatchObject({ wanted: true, established: true })
      await f.legacyStop()
      // The older UI has no knowledge of the intent file. Login must infer its
      // completed Stop from the absence of both PID and maintenance resume.
      expect(JSON.parse(await readFile(`${f.collectorProcessFile}.desired.json`, "utf8"))).toMatchObject({ wanted: true })
      expect(await f.run(f.daemon.resume())).toBeUndefined()
      expect(await f.run(f.daemon.refresh())).toBe(false)
      expect(JSON.parse(await readFile(`${f.collectorProcessFile}.desired.json`, "utf8")))
        .toEqual({ version: 1, wanted: false })
    } finally { await f.run(f.daemon.stop()) }
  })

  it("retries a first Start that failed before publishing any process identity", async () => {
    const f = await fixture()
    try {
      await rm(f.entry)
      await expect(f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))).rejects.toMatchObject({ reason: "io" })
      expect(await f.run(f.daemon.inspect())).toBeUndefined()
      expect(JSON.parse(await readFile(`${f.collectorProcessFile}.desired.json`, "utf8")))
        .toEqual({ version: 1, wanted: true, intervalMs: 60000, concurrency: 3 })
      await f.replace("repaired-first-start")
      const resumed = await f.run(f.daemon.resume())
      expect(resumed).toMatchObject({ intervalMs: 60000, concurrency: 3, created: true })
      await f.started("repaired-first-start", resumed!.pid)
    } finally { await f.run(f.daemon.stop()) }
  })

  it("retains resumable metadata across pause and a failed replacement spawn", async () => {
    const f = await fixture()
    try {
      const original = await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      expect(await f.run(f.daemon.pause())).toBe(true)
      expect(JSON.parse(await readFile(f.collectorProcessFile, "utf8")))
        .toMatchObject({ pid: original.pid, restartPending: true })
      await writeFile(f.entry, "process.exit(1)\n")
      // Ownership can be confirmed just before Node evaluates this entry. In
      // either timing the exited replacement must leave resumable metadata.
      try { await f.run(f.daemon.resume()) } catch (cause) { expect(cause).toMatchObject({ reason: "start" }) }
      await expect.poll(() => f.run(f.daemon.inspect())).toBeUndefined()
      expect(JSON.parse(await readFile(f.collectorProcessFile, "utf8"))).toMatchObject({ restartPending: true })
      expect(JSON.parse(await readFile(`${f.collectorProcessFile}.desired.json`, "utf8")))
        .toMatchObject({ wanted: true, established: true })
      await f.replace("repaired-replacement")
      const resumed = await f.run(f.daemon.resume())
      expect(resumed).toMatchObject({ intervalMs: 60000, concurrency: 3, created: true })
      await f.started("repaired-replacement", resumed!.pid)
    } finally { await f.run(f.daemon.stop()) }
  })

  it("does not inherit user intent from a stale legacy PID or restart marker", async () => {
    const f = await fixture()
    try {
      const original = await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      const record = JSON.parse(await readFile(f.collectorProcessFile, "utf8"))
      process.kill(original.pid, "SIGKILL")
      await expect.poll(() => f.run(f.daemon.inspect())).toBeUndefined()
      await rm(`${f.collectorProcessFile}.desired.json`)
      await writeFile(f.collectorProcessFile, JSON.stringify({ ...record, restartPending: true }))
      expect(await f.run(f.daemon.resume())).toBeUndefined()
      expect(await f.run(f.daemon.refresh())).toBe(false)
    } finally { await f.run(f.daemon.stop()) }
  })

  it("fails closed on malformed saved intent and lets an explicit Stop repair it", async () => {
    const f = await fixture()
    await writeFile(`${f.collectorProcessFile}.desired.json`, JSON.stringify({ version: 1, wanted: true, intervalMs: 1, concurrency: 20 }))
    await expect(f.run(f.daemon.resume())).rejects.toMatchObject({ reason: "identity" })
    expect(await f.run(f.daemon.stop())).toBe(false)
    expect(await f.run(f.daemon.resume())).toBeUndefined()
  })

  it("pauses legacy collection for maintenance without changing the desired schedule or cancelling a later Stop", async () => {
    const f = await fixture()
    try {
      const original = await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      await rm(`${f.collectorProcessFile}.desired.json`)
      expect(await f.run(f.daemon.pause())).toBe(true)
      expect(await f.run(f.daemon.inspect())).toBeUndefined()
      expect(JSON.parse(await readFile(f.collectorProcessFile, "utf8")))
        .toMatchObject({ pid: original.pid, restartPending: true })
      const resumed = await f.run(f.daemon.resume())
      expect(resumed).toMatchObject({ intervalMs: 60000, concurrency: 3 })
      expect(resumed!.pid).not.toBe(original.pid)
      expect(await f.run(f.daemon.pause())).toBe(true)
      expect(await f.run(f.daemon.stop())).toBe(false)
      expect(await f.run(f.daemon.pause())).toBe(false)
      expect(await f.run(f.daemon.resume())).toBeUndefined()
    } finally { await f.run(f.daemon.stop()) }
  })

  it("replaces legacy processes once through start and leaves a running process intact when the entry cannot be read", async () => {
    const f = await fixture()
    try {
      const original = await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      const record = JSON.parse(await readFile(f.collectorProcessFile, "utf8"))
      delete record.runtimeKey
      await writeFile(f.collectorProcessFile, JSON.stringify(record))
      const replaced = await f.run(f.daemon.start({ intervalMs: 30000, concurrency: 4 }))
      expect(replaced).toMatchObject({ created: true, intervalMs: 60000, concurrency: 3 })
      expect(replaced.pid).not.toBe(original.pid)
      await f.started("original", replaced.pid)
      expect(await f.run(f.daemon.refresh())).toBe(false)
      await rm(f.entry)
      await expect(f.run(f.daemon.refresh())).rejects.toMatchObject({ reason: "io" })
      expect((await f.run(f.daemon.inspect()))!.pid).toBe(replaced.pid)
    } finally { await f.run(f.daemon.stop()) }
  })

  it("resolves the current runtime again for start and refresh in an existing CLI runtime", async () => {
    const f = await fixture(), replacement = join(f.entry, "..", "next-cli.mjs")
    let selected = f.entry
    const layer = makeNodeCollectorDaemonLayer(f, async () => selected)
    const run = <A, E>(effect: Effect.Effect<A, E, CollectorDaemonProcess>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)))
    const daemon = await run(CollectorDaemonProcess)
    try {
      const original = await run(daemon.start({ intervalMs: 45000, concurrency: 2 }))
      await f.started("original", original.pid)
      await f.replace("selected-runtime")
      await copyFile(f.entry, replacement)
      await f.replace("original")
      selected = replacement
      expect(await run(daemon.refresh())).toBe(true)
      const updated = await run(daemon.inspect())
      await f.started("selected-runtime", updated!.pid)
      expect(await run(daemon.refresh())).toBe(false)
      await run(daemon.stop())
      const restarted = await run(daemon.start({ intervalMs: 30000, concurrency: 4 }))
      await f.started("selected-runtime", restarted.pid)
    } finally { await run(daemon.stop()) }
  })

  it("resumes persisted restart intent after process exit and lets explicit stop cancel it", async () => {
    const f = await fixture()
    try {
      const original = await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      const record = JSON.parse(await readFile(f.collectorProcessFile, "utf8"))
      process.kill(original.pid, "SIGKILL")
      await expect.poll(() => f.run(f.daemon.inspect())).toBeUndefined()
      await writeFile(f.collectorProcessFile, JSON.stringify({ ...record, restartPending: true }))
      expect(await f.run(f.daemon.inspect())).toBeUndefined()
      expect(await f.run(f.daemon.refresh())).toBe(true)
      expect(await f.run(f.daemon.inspect())).toMatchObject({ intervalMs: 60000, concurrency: 3 })
      await f.run(f.daemon.stop())
      await writeFile(f.collectorProcessFile, JSON.stringify({ ...record, restartPending: true }))
      await f.run(f.daemon.stop())
      expect(await f.run(f.daemon.refresh())).toBe(false)
    } finally { await f.run(f.daemon.stop()) }
  })

  it("rejects changed prerequisites before publishing pause intent or stopping collection", async () => {
    const f = await fixture()
    try {
      const original = await f.run(f.daemon.start({ intervalMs: 45000, concurrency: 2 }))
      let activated = false
      await expect(withCollectorMaintenance(f, async () => f.entry, process.env,
        async () => { activated = true }, { beforePause: async wanted => {
          expect(wanted).toBe(true)
          expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
          throw new Error("The preflight scope changed")
        } })).rejects.toThrow("The preflight scope changed")
      expect(activated).toBe(false)
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
      expect((await f.run(f.daemon.inspect()))?.pid).toBe(original.pid)
    } finally { await f.run(f.daemon.stop()) }
  })

  it("keeps stopped intent while claiming pause and rejects Start until the handoff finishes", async () => {
    const f = await fixture()
    await f.run(f.daemon.stop())
    const beforePause: boolean[] = []
    await withCollectorMaintenance(f, async () => f.entry, process.env, async () => {
      await expect(f.run(f.daemon.start({ intervalMs: 30000, concurrency: 2 }))).rejects.toMatchObject({ reason: "start" })
    }, { beforePause: async wanted => {
      beforePause.push(wanted)
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
    } })
    expect(beforePause).toEqual([false])
    expect(await f.run(f.daemon.inspect())).toBeUndefined()
    expect(JSON.parse(await readFile(`${f.collectorProcessFile}.desired.json`, "utf8")).wanted).toBe(false)
  })

  it("bounds termination of an uncooperative Collector and hands off only after local readiness", async () => {
    const f = await fixture()
    await f.replace("ignores-termination", { ignoreTermination: true })
    try {
      const original = await f.run(f.daemon.start({ intervalMs: 45000, concurrency: 2 }))
      await f.started("ignores-termination", original.pid)
      const before = performance.now()
      const result = await withCollectorMaintenance(f, async () => f.entry, process.env, async () => {
        expect(performance.now() - before).toBeGreaterThanOrEqual(4_900)
        expect(performance.now() - before).toBeLessThan(7_500)
        expect(await f.run(f.daemon.inspect())).toBeUndefined()
        expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(true)
        await expect(f.run(f.daemon.start({ intervalMs: 30000, concurrency: 4 }))).rejects.toMatchObject({ reason: "start" })
        await expect(f.run(f.daemon.refresh())).rejects.toMatchObject({ reason: "start" })
        await f.replace("updated")
        return "activated"
      })
      expect(result).toBe("activated")
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
      const current = await f.run(f.daemon.inspect())
      expect(current).toMatchObject({ intervalMs: 45000, concurrency: 2 })
      expect(current!.pid).not.toBe(original.pid)
      await f.started("updated", current!.pid)
    } finally { await f.run(f.daemon.stop()) }
  }, 15_000)

  it("lets user Stop cancel maintenance restart without waiting for a ready file", async () => {
    const f = await fixture()
    let release!: () => void, entered!: () => void
    const activation = new Promise<void>(resolve => { release = resolve })
    const startedActivation = new Promise<void>(resolve => { entered = resolve })
    try {
      await f.run(f.daemon.start({ intervalMs: 45000, concurrency: 2 }))
      const updating = withCollectorMaintenance(f, async () => f.entry, process.env, async () => {
        entered(); await activation; await f.replace("stopped", { ready: false }); return "updated"
      })
      await startedActivation
      await expect(withCollectorMaintenance(f, async () => f.entry, process.env, async () => {}))
        .rejects.toMatchObject({ reason: "identity" })
      await f.run(f.daemon.stop())
      release()
      await expect(updating).resolves.toBe("updated")
      expect(await f.run(f.daemon.inspect())).toBeUndefined()
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
    } finally { release?.(); await f.run(f.daemon.stop()) }
  })

  it("preserves established intent when maintenance observes a crashed Collector before inspect marks it pending", async () => {
    const f = await fixture()
    try {
      const original = await f.run(f.daemon.start({ intervalMs: 45000, concurrency: 2 }))
      process.kill(original.pid, "SIGKILL")
      await expect.poll(() => {
        try { process.kill(original.pid, 0); return true } catch { return false }
      }).toBe(false)
      expect(JSON.parse(await readFile(f.collectorProcessFile, "utf8"))).not.toHaveProperty("restartPending")
      await withCollectorMaintenance(f, async () => f.entry, process.env, () => f.replace("recovered-before-inspect"))
      const recovered = await f.run(f.daemon.inspect())
      expect(recovered).toMatchObject({ intervalMs: 45000, concurrency: 2 })
      expect(recovered!.pid).not.toBe(original.pid)
      await f.started("recovered-before-inspect", recovered!.pid)
      expect(JSON.parse(await readFile(`${f.collectorProcessFile}.desired.json`, "utf8")))
        .toMatchObject({ wanted: true, established: true })
    } finally { await f.run(f.daemon.stop()) }
  })

  it("honors a retained 0.5.3 Stop which cancels the resume gate while maintenance has no PID", async () => {
    const f = await fixture()
    try {
      await f.run(f.daemon.start({ intervalMs: 45000, concurrency: 2 }))
      await withCollectorMaintenance(f, async () => f.entry, process.env, async () => {
        await expect(readFile(f.collectorProcessFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
        await f.legacyStop()
        await f.replace("must-remain-stopped")
      })
      expect(await f.run(f.daemon.resume())).toBeUndefined()
      expect(JSON.parse(await readFile(`${f.collectorProcessFile}.desired.json`, "utf8")))
        .toEqual({ version: 1, wanted: false })
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
    } finally { await f.run(f.daemon.stop()) }
  })

  it("retains failed maintenance for recovery and preserves the original schedule", async () => {
    const f = await fixture()
    const failed = new Error("Activation failed")
    try {
      await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      await expect(withCollectorMaintenance(f, async () => f.entry, process.env, async () => { throw failed }))
        .rejects.toBe(failed)
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(true)
      await expect(f.run(f.daemon.start({ intervalMs: 30000, concurrency: 4 }))).rejects.toMatchObject({ reason: "start" })
      await withCollectorMaintenance(f, async () => f.entry, process.env, () => f.replace("recovered"))
      const current = await f.run(f.daemon.inspect())
      expect(current).toMatchObject({ intervalMs: 60000, concurrency: 3 })
      await f.started("recovered", current!.pid)
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
    } finally { await f.run(f.daemon.stop()) }
  })

  it("migrates an interrupted legacy maintenance resume but never overrides a later user Stop", async () => {
    const f = await fixture()
    const gate = { version: 1, token: "legacy-maintenance", generation: 0, phase: "failed",
      resume: { intervalMs: 60000, concurrency: 3 } }
    try {
      await writeFile(`${f.collectorProcessFile}.maintenance.json`, JSON.stringify(gate))
      await expect(f.run(f.daemon.resume())).rejects.toMatchObject({ reason: "start" })
      await withCollectorMaintenance(f, async () => f.entry, process.env, () => f.replace("legacy-recovered"))
      const running = await f.run(f.daemon.inspect())
      expect(running).toMatchObject({ intervalMs: 60000, concurrency: 3 })
      await f.started("legacy-recovered", running!.pid)
      await f.run(f.daemon.stop())
      // Simulate an older retained worker carrying an uncancelled resume gate.
      await writeFile(`${f.collectorProcessFile}.maintenance.json`, JSON.stringify(gate))
      await withCollectorMaintenance(f, async () => f.entry, process.env, () => f.replace("must-remain-stopped"))
      expect(await f.run(f.daemon.inspect())).toBeUndefined()
      expect(await f.run(f.daemon.resume())).toBeUndefined()
    } finally { await f.run(f.daemon.stop()) }
  })

  it("honors a persisted Stop even when a crashed Stop did not clear the updater's earlier resume gate", async () => {
    const f = await fixture()
    try {
      await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      await withCollectorMaintenance(f, async () => f.entry, process.env, async () => {
        // Reproduce process death after durable Stop intent, before gate mutation.
        await writeFile(`${f.collectorProcessFile}.desired.json`, JSON.stringify({ version: 1, wanted: false }))
        await f.replace("must-remain-stopped")
      })
      expect(await f.run(f.daemon.inspect())).toBeUndefined()
      expect(await f.run(f.daemon.resume())).toBeUndefined()
    } finally { await f.run(f.daemon.stop()) }
  })

  it("lets an old console Stop cancel restart after a same-contract reader floor advances", async () => {
    const f = await fixture(), admission = await runtimeWriterFixture(dirname(f.entry))
    const maintenanceFile = `${f.collectorProcessFile}.maintenance.json`
    const gate = { version: 1, token: "owned-maintenance", ownerPid: process.pid, generation: 2, phase: "activating",
      resume: { intervalMs: 60000, concurrency: 3 } }
    try {
      const running = await f.run(f.daemon.start(gate.resume))
      await f.started("original", running.pid)
      await writeFile(maintenanceFile, JSON.stringify(gate))
      await admission.raiseFloor()
      await expect(assertRuntimeDataAdmission(admission.runtime)).rejects.toMatchObject({ reason: "admission" })

      expect(await f.run(f.daemon.stop())).toBe(true)
      expect(JSON.parse(await readFile(`${f.collectorProcessFile}.desired.json`, "utf8"))).toEqual({ version: 1, wanted: false })
      const { resume: _, ...cancelled } = gate
      expect(JSON.parse(await readFile(maintenanceFile, "utf8"))).toEqual({ ...cancelled, generation: gate.generation + 1 })
      await expect(readFile(f.collectorProcessFile)).rejects.toMatchObject({ code: "ENOENT" })
      expect(await f.run(f.daemon.resume())).toBeUndefined()
      expect(await f.run(f.daemon.inspect())).toBeUndefined()
    } finally { await f.run(f.daemon.stop()) }
  })

  it("honors Stop while the replacement is waiting for readiness", async () => {
    const f = await fixture()
    try {
      const old = await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      const updating = withCollectorMaintenance(f, async () => f.entry, process.env,
        () => f.replace("waiting-for-ready", { ready: false }))
      await expect.poll(async () => (await f.run(f.daemon.inspect()))?.pid).not.toBe(old.pid)
      await expect.poll(async () => (await f.run(f.daemon.inspect()))?.pid).toBeTypeOf("number")
      const stoppedAt = performance.now()
      await f.run(f.daemon.stop())
      await updating
      expect(performance.now() - stoppedAt).toBeLessThan(2_000)
      expect(await f.run(f.daemon.inspect())).toBeUndefined()
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
    } finally { await f.run(f.daemon.stop()) }
  })

  it("lets Stop cancel a fallback restart while recovery is in progress", async () => {
    const f = await fixture(), failed = new Error("Activation failed")
    let release!: () => void, entered!: () => void
    const recovery = new Promise<void>(resolve => { release = resolve })
    const startedRecovery = new Promise<void>(resolve => { entered = resolve })
    try {
      await f.run(f.daemon.start({ intervalMs: 45000, concurrency: 2 }))
      const updating = withCollectorMaintenance(f, async () => f.entry, process.env,
        async () => { throw failed }, { recover: async () => {
          entered(); await recovery; await f.replace("must-remain-stopped", { ready: false })
        } })
      await startedRecovery
      await f.run(f.daemon.stop())
      release()
      await expect(updating).rejects.toBe(failed)
      expect(await f.run(f.daemon.inspect())).toBeUndefined()
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
    } finally { release?.(); await f.run(f.daemon.stop()) }
  })

  it("restores the previous runtime after readiness failure and reports the update failure", async () => {
    const f = await fixture()
    try {
      await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      let restored = false
      const failure = await withCollectorMaintenance(f, async () => f.entry, process.env,
        () => f.replace("cannot-become-ready", { ready: false }), {
          // The readiness budget also applies when the previous child restarts.
          readyTimeoutMs: 5_000,
          recover: async () => { restored = true; await f.replace("restored") }
        }).then(() => undefined, error => error)
      // A real ps probe started just before the deadline may time out; its
      // identity uncertainty must not be classified as a candidate failure.
      expect(["start", "identity"]).toContain(failure?.reason)
      if (failure.reason === "start") expect(failure).toMatchObject({ reason: "start", stage: "candidate-readiness", recovery: "ready",
          message: "The updated Collector did not become locally ready." })
      else expect(failure).not.toBeInstanceOf(CollectorMaintenanceFailure)
      expect(restored).toBe(true)
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
      const current = await f.run(f.daemon.inspect())
      expect(current).toMatchObject({ intervalMs: 60000, concurrency: 3 })
      await f.started("restored", current!.pid)
    } finally { await f.run(f.daemon.stop()) }
  }, 30_000)

  it("classifies a spawned child exit only after the fallback is actually ready and the gate is released", async () => {
    const f = await fixture()
    try {
      await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      const failure = await withCollectorMaintenance(f, async () => f.entry, process.env,
        () => f.replace("exits-before-ready", { exitDuringReadiness: true }), {
          readyTimeoutMs: 1_000, recover: () => f.replace("restored")
        }).then(() => undefined, error => error)
      expect(failure).toBeInstanceOf(CollectorMaintenanceFailure)
      expect(failure).toMatchObject({ reason: "start", stage: "candidate-readiness", recovery: "ready" })
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
      await f.started("restored", (await f.run(f.daemon.inspect()))!.pid)
    } finally { await f.run(f.daemon.stop()) }
  })

  it.each(["directory", "malformed", "foreign"] as const)("excludes %s readiness metadata even when fallback succeeds", async readyMarker => {
    const f = await fixture()
    try {
      await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      const failure = await withCollectorMaintenance(f, async () => f.entry, process.env,
        () => f.replace("invalid-marker", { ready: readyMarker === "foreign", readyMarker }), {
          readyTimeoutMs: 1_000, recover: async () => {
            if (readyMarker === "directory") for (const file of await readdir(dirname(f.entry))) {
              if (file.endsWith(".ready")) await rm(join(dirname(f.entry), file), { recursive: true, force: true })
            }
            await f.replace("restored")
          }
        }).then(() => undefined, error => error)
      expect(failure).toMatchObject({ reason: readyMarker === "directory" ? "io" : "identity" })
      expect(failure).not.toBeInstanceOf(CollectorMaintenanceFailure)
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
      await f.started("restored", (await f.run(f.daemon.inspect()))!.pid)
    } finally { await f.run(f.daemon.stop()) }
  })

  it("does not classify a fallback whose restart was cancelled by Stop after candidate exit", async () => {
    const f = await fixture()
    try {
      await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      const failure = await withCollectorMaintenance(f, async () => f.entry, process.env,
        () => f.replace("exits-before-ready", { exitDuringReadiness: true }), {
          readyTimeoutMs: 1_000, recover: async () => { await f.run(f.daemon.stop()); await f.replace("must-stay-stopped") }
        }).then(() => undefined, error => error)
      expect(failure).toMatchObject({ reason: "start" })
      expect(failure).not.toBeInstanceOf(CollectorMaintenanceFailure)
      expect(await f.run(f.daemon.inspect())).toBeUndefined()
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
    } finally { await f.run(f.daemon.stop()) }
  })

  it("does not classify failed fallback readiness and retains its recovery gate", async () => {
    const f = await fixture()
    try {
      await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      const failure = await withCollectorMaintenance(f, async () => f.entry, process.env,
        () => f.replace("exits-before-ready", { exitDuringReadiness: true }), {
          readyTimeoutMs: 500, recover: () => f.replace("fallback-not-ready", { ready: false })
        }).then(() => undefined, error => error)
      expect(failure).toMatchObject({ reason: "start", message: expect.stringContaining("maintenance needs recovery") })
      expect(failure).not.toBeInstanceOf(CollectorMaintenanceFailure)
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(true)
    } finally { await f.run(f.daemon.stop()) }
  })

  it("preserves identity uncertainty when its ps probe consumes the candidate readiness deadline", async () => {
    const f = await fixture(), originalPath = process.env.PATH, fakeBin = join(dirname(f.entry), "bin"), flag = join(dirname(f.entry), "hang-one-ps")
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    await mkdir(fakeBin)
    await writeFile(join(fakeBin, "ps"), `#!/bin/sh
flag=${shellQuote(flag)}
if [ ! -f "$flag" ]; then exec /bin/ps "$@"; fi
IFS= read -r stage < "$flag"
if [ "$stage" = "hang-readiness" ]; then
  /bin/rm "$flag"
  exec ${shellQuote(process.execPath)} -e 'setInterval(() => {}, 1000)'
fi
candidate_command=$(/bin/ps "$@")
case "$candidate_command" in *" __collector-daemon "*) printf '%s' 'hang-readiness' > "$flag" ;; esac
printf '%s\\n' "$candidate_command"
`)
    await chmod(join(fakeBin, "ps"), 0o700)
    try {
      await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      const failure = await withCollectorMaintenance(f, async () => f.entry, process.env, async () => {
        await f.replace("candidate"); await writeFile(flag, "confirm-start"); process.env.PATH = `${fakeBin}:${originalPath}`
      }, { activationTimeoutMs: 2_000, recover: async () => { process.env.PATH = originalPath; await f.replace("restored") } })
        .then(() => undefined, error => error)
      expect(failure, failure?.message).toMatchObject({ reason: "identity" })
      expect(failure).not.toBeInstanceOf(CollectorMaintenanceFailure)
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
      await f.started("restored", (await f.run(f.daemon.inspect()))!.pid)
    } finally { process.env.PATH = originalPath; await f.run(f.daemon.stop()) }
  }, 15_000)

  it("retries a transient live identity mismatch within the existing readiness budget", async () => {
    const f = await fixture(), originalPath = process.env.PATH, fakeBin = join(dirname(f.entry), "bin"), flag = join(dirname(f.entry), "ps-mismatch")
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    await mkdir(fakeBin)
    await writeFile(join(fakeBin, "ps"), `#!/bin/sh
flag=${shellQuote(flag)}
if [ ! -f "$flag" ]; then exec /bin/ps "$@"; fi
IFS= read -r stage < "$flag"
if [ "$stage" = "mismatch" ]; then /bin/rm "$flag"; exit 0; fi
candidate_command=$(/bin/ps "$@")
case "$candidate_command" in *" __collector-daemon "*) printf '%s' 'mismatch' > "$flag" ;; esac
printf '%s\\n' "$candidate_command"
`)
    await chmod(join(fakeBin, "ps"), 0o700)
    try {
      await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      const failure = await withCollectorMaintenance(f, async () => f.entry, process.env, async () => {
        await f.replace("candidate"); await writeFile(flag, "confirm-start"); process.env.PATH = `${fakeBin}:${originalPath}`
      }, { readyTimeoutMs: 2_500, recover: async () => { process.env.PATH = originalPath; await f.replace("restored") } })
        .then(() => undefined, error => error)
      expect(failure).toBeUndefined()
      await expect(readFile(flag)).rejects.toMatchObject({ code: "ENOENT" })
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
      await f.started("candidate", (await f.run(f.daemon.inspect()))!.pid)
    } finally { process.env.PATH = originalPath; await f.run(f.daemon.stop()) }
  }, 15_000)

  it("caps readiness at the remaining activation budget and uses a separate recovery budget", async () => {
    const f = await fixture()
    try {
      await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      const started = performance.now()
      let activationDeadline = 0, recoveryDeadline = 0
      const failure = await withCollectorMaintenance(f, async () => f.entry, process.env,
        async deadline => { activationDeadline = deadline; await f.replace("not-ready", { ready: false }) }, {
          activationTimeoutMs: 300, recoveryTimeoutMs: 1_000,
          recover: async (_, deadline) => { recoveryDeadline = deadline; await f.replace("restored") }
        }).then(() => undefined, error => error)
      expect(["start", "identity"]).toContain(failure?.reason)
      if (failure.reason === "identity") expect(failure).not.toBeInstanceOf(CollectorMaintenanceFailure)
      expect(activationDeadline - started).toBeLessThan(325)
      expect(recoveryDeadline).toBeGreaterThan(activationDeadline)
      expect(performance.now() - started).toBeLessThan(2_000)
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
      const current = await f.run(f.daemon.inspect())
      await f.started("restored", current!.pid)
    } finally { await f.run(f.daemon.stop()) }
  })

  it.each(["activation", "readiness"] as const)("does not launch a candidate after entry resolution consumes the %s budget", async budget => {
    const f = await fixture()
    let delayed = false, activationDeadline = 0
    try {
      const original = await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      await f.started("original", original.pid)
      await expect(withCollectorMaintenance(f, async () => {
        if (!delayed) {
          delayed = true
          await new Promise(resolve => setTimeout(resolve, budget === "activation"
            ? Math.max(0, activationDeadline - performance.now()) + 50 : 2_100))
        }
        return f.entry
      }, process.env, async deadline => { activationDeadline = deadline; await f.replace("must-not-start") }, {
        activationTimeoutMs: budget === "activation" ? 2_000 : 10_000,
        readyTimeoutMs: budget === "activation" ? 10_000 : 2_000,
        recover: async () => {
          expect(JSON.parse(await readFile(join(f.entry, "..", "started.json"), "utf8")).build).toBe("original")
          await f.replace("restored")
        }
      })).rejects.toMatchObject({ reason: "start", message: budget === "activation"
        ? "Collector maintenance deadline expired." : "The updated Collector did not become locally ready." })
      expect(activationDeadline).toBeGreaterThan(0)
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
      await f.started("restored", (await f.run(f.daemon.inspect()))!.pid)
    } finally { await f.run(f.daemon.stop()) }
  }, 15_000)

  it("keeps a recoverable gate when the recovery budget expires before restart", async () => {
    const f = await fixture()
    try {
      await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      await expect(withCollectorMaintenance(f, async () => f.entry, process.env,
        async () => { throw new Error("Activation failed") }, {
          recoveryTimeoutMs: 60,
          recover: async () => { await new Promise(resolve => setTimeout(resolve, 150)) }
        })).rejects.toMatchObject({ reason: "start", message: expect.stringContaining("maintenance needs recovery") })
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(true)
      expect(await f.run(f.daemon.inspect())).toBeUndefined()
      await withCollectorMaintenance(f, async () => f.entry, process.env, () => f.replace("recovered"))
      await f.started("recovered", (await f.run(f.daemon.inspect()))!.pid)
    } finally { await f.run(f.daemon.stop()) }
  })

  it("does not reclaim an aged OS process lock whose owner is still alive", async () => {
    const f = await fixture()
    const lock = `${f.collectorProcessFile}.lock.sqlite`
    const release = (await acquireProcessLock(lock))!
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)
    try {
      await expect(f.run(f.daemon.start({ intervalMs: 30000, concurrency: 4 }))).rejects.toMatchObject({ reason: "io" })
      expect(await acquireProcessLock(lock)).toBeUndefined()
    } finally { release(); await f.run(f.daemon.stop()) }
  })

  it.each(["", '{"pid":', JSON.stringify({ pid: process.pid })])("recovers maintenance despite abandoned legacy lock metadata %#", async legacy => {
    const f = await fixture(), lock = `${f.collectorProcessFile}.lock`
    await writeFile(lock, legacy)
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)
    await expect(withCollectorMaintenance(f, async () => f.entry, process.env, async () => "recovered"))
      .resolves.toBe("recovered")
    expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
    expect(await readFile(lock, "utf8")).toBe(legacy)
  })

  it("recovers an abandoned gate even if its recorded owner PID is alive in an unrelated process", async () => {
    const f = await fixture()
    try {
      await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      await writeFile(`${f.collectorProcessFile}.maintenance.json`, JSON.stringify({ version: 1,
        token: "abandoned-owner", ownerPid: process.pid, generation: 7, phase: "starting",
        resume: { intervalMs: 60000, concurrency: 3 } }))
      await withCollectorMaintenance(f, async () => f.entry, process.env, () => f.replace("recovered-pid"))
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
      const current = await f.run(f.daemon.inspect())
      expect(current).toMatchObject({ intervalMs: 60000, concurrency: 3 })
      await f.started("recovered-pid", current!.pid)
    } finally { await f.run(f.daemon.stop()) }
  })

  it("excludes a live maintenance process and recovers its gate immediately after SIGKILL", async () => {
    const f = await fixture(), marker = join(f.entry, "..", "maintenance-ready")
    const module = fileURLToPath(new URL("./collectorDaemonLayers.ts", import.meta.url))
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
import { withCollectorMaintenance } from ${JSON.stringify(module)};
import { writeFile } from "node:fs/promises";
setInterval(() => {}, 1000);
await withCollectorMaintenance(${JSON.stringify(f)}, async () => ${JSON.stringify(f.entry)}, process.env, async () => {
  await writeFile(${JSON.stringify(marker)}, "ready");
  await new Promise(() => {});
});
`], { stdio: "ignore" })
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
    try {
      await expect.poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 3_000 }).toBe("ready")
      await expect(withCollectorMaintenance(f, async () => f.entry, process.env, async () => {}))
        .rejects.toMatchObject({ reason: "identity" })
      // The whole-handoff owner must not monopolize short process operations.
      expect(await f.run(f.daemon.stop())).toBe(false)
      child.kill("SIGKILL")
      await exited
      await expect(withCollectorMaintenance(f, async () => f.entry, process.env, async () => "recovered"))
        .resolves.toBe("recovered")
      expect(await isCollectorMaintenancePending(f.collectorProcessFile)).toBe(false)
    } finally { child.kill("SIGKILL"); await exited; await f.run(f.daemon.stop()) }
  })

  it("bounds failed identity checks and does not activate when exit cannot be confirmed", async () => {
    const f = await fixture(), originalPath = process.env.PATH
    const fakeBin = join(f.entry, "..", "bin")
    await mkdir(fakeBin)
    const fakePs = join(fakeBin, "ps")
    await writeFile(fakePs, `#!${process.execPath}\nprocess.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n`)
    await chmod(fakePs, 0o700)
    try {
      const original = await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      await f.started("original", original.pid)
      process.env.PATH = `${fakeBin}:${originalPath}`
      let activated = false
      const started = performance.now()
      await expect(withCollectorMaintenance(f, async () => f.entry, process.env,
        async () => { activated = true })).rejects.toMatchObject({ reason: "identity" })
      expect(activated).toBe(false)
      expect(performance.now() - started).toBeLessThan(3_000)
      process.env.PATH = originalPath
      expect((await f.run(f.daemon.inspect()))!.pid).toBe(original.pid)
    } finally { process.env.PATH = originalPath; await f.run(f.daemon.stop()) }
  }, 10_000)

  it("bounds normal startup confirmation and retains the unconfirmed process identity", async () => {
    const f = await fixture(), originalPath = process.env.PATH
    const fakeBin = join(f.entry, "..", "bin")
    await mkdir(fakeBin)
    const fakePs = join(fakeBin, "ps")
    await writeFile(fakePs, `#!${process.execPath}\nprocess.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n`)
    await chmod(fakePs, 0o700)
    try {
      process.env.PATH = `${fakeBin}:${originalPath}`
      const started = performance.now()
      await expect(f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))).rejects.toMatchObject({ reason: "identity" })
      expect(performance.now() - started).toBeLessThan(3_000)
      process.env.PATH = originalPath
      const retained = await f.run(f.daemon.inspect())
      expect(retained).toMatchObject({ intervalMs: 60000, concurrency: 3 })
      await f.started("original", retained!.pid)
    } finally { process.env.PATH = originalPath; await f.run(f.daemon.stop()) }
  }, 10_000)

  it("retains the replacement identity when refresh cannot confirm its startup", async () => {
    const f = await fixture(), originalPath = process.env.PATH
    const fakeBin = join(f.entry, "..", "bin")
    await mkdir(fakeBin)
    let replacementPid: number | undefined
    try {
      const original = await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      await f.started("original", original.pid)
      const fakePs = join(fakeBin, "ps")
      const nodeExecutable = `'${process.execPath.replaceAll("'", "'\"'\"'")}'`
      // Inject failure only for replacement confirmation. Repeated OS ps
      // launches for the original must not consume that unrelated deadline.
      const originalCommand = execFileSync("/bin/ps", ["-p", String(original.pid), "-o", "command="], { encoding: "utf8" })
      const quotedCommand = `'${originalCommand.replaceAll("'", "'\"'\"'")}'`
      await writeFile(fakePs, `#!/bin/sh
if [ "$2" = "${original.pid}" ]; then
  printf '%s' ${quotedCommand}
else
  exec ${nodeExecutable} -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
fi
`)
      await chmod(fakePs, 0o700)
      await f.replace("unconfirmed-replacement")
      process.env.PATH = `${fakeBin}:${originalPath}`
      await expect(f.run(f.daemon.refresh())).rejects.toMatchObject({ reason: "identity" })
      process.env.PATH = originalPath
      const record = JSON.parse(await readFile(f.collectorProcessFile, "utf8"))
      replacementPid = record.pid
      expect(record).toMatchObject({ restartPending: true, intervalMs: 60000, concurrency: 3 })
      expect(replacementPid).not.toBe(original.pid)
      await f.started("unconfirmed-replacement", replacementPid!)
      expect((await f.run(f.daemon.inspect()))!.pid).toBe(replacementPid)
      await f.run(f.daemon.stop())
      expect(await f.run(f.daemon.inspect())).toBeUndefined()
    } finally {
      process.env.PATH = originalPath
      await f.run(f.daemon.stop())
      if (replacementPid) try { process.kill(replacementPid, "SIGKILL") } catch { /* Already stopped. */ }
    }
  }, 10_000)

  it("terminates a spawned child if its process metadata cannot be published", async () => {
    const f = await fixture()
    const processFile = join(f.entry, "..", "p".repeat(220))
    const layer = makeNodeCollectorDaemonLayer({ ...f, collectorProcessFile: processFile }, f.entry)
    const daemon = await Effect.runPromise(CollectorDaemonProcess.pipe(Effect.provide(layer)))
    const ownedPids = () => execFileSync("/bin/ps", ["-axo", "pid,command="], { encoding: "utf8" }).split("\n")
      .filter(line => line.includes(f.entry) && line.includes("__collector-daemon")).map(line => Number(line.trim().split(/\s+/)[0]))
    try {
      await expect(Effect.runPromise(daemon.start({ intervalMs: 30000, concurrency: 4 }))).rejects.toMatchObject({ reason: "io" })
      await expect.poll(ownedPids).toEqual([])
      await expect(readFile(processFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    } finally { for (const pid of ownedPids()) try { process.kill(pid, "SIGKILL") } catch { /* Already exited. */ } }
  })
})
