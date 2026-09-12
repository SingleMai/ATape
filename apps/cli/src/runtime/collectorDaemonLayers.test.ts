import { CollectorDaemonProcess, CollectorRunStatusStore } from "@atape/application"
import { Effect } from "effect"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeNodeCollectorDaemonLayer, makeCollectorRunStatusLayer } from "./collectorDaemonLayers.ts"

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("Node Collector run status Adapter", () => {
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
    const replace = (build: string) => writeFile(entry, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({build:${JSON.stringify(build)},pid:process.pid}));
setInterval(() => {}, 1000);
`)
    await replace("original")
    const layer = makeNodeCollectorDaemonLayer(paths, entry)
    const run = <A, E>(effect: Effect.Effect<A, E, CollectorDaemonProcess>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)))
    const daemon = await run(CollectorDaemonProcess)
    return { ...paths, entry, replace, run, daemon,
      started: async (build: string, pid: number) => {
        await expect.poll(async () => JSON.parse(await readFile(marker, "utf8"))).toEqual({ build, pid })
      } }
  }

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

  it("resumes persisted restart intent after process exit and lets explicit stop cancel it", async () => {
    const f = await fixture()
    try {
      await f.run(f.daemon.start({ intervalMs: 60000, concurrency: 3 }))
      const record = JSON.parse(await readFile(f.collectorProcessFile, "utf8"))
      await f.run(f.daemon.stop())
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
})
