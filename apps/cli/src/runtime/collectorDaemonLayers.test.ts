import { CollectorRunStatusStore } from "@atape/application"
import { Effect } from "effect"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeCollectorRunStatusLayer } from "./collectorDaemonLayers.ts"

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
      retryable: true,
      progress: first.jobs[0]!.progress
    })])
    expect(status.jobs[0]).not.toHaveProperty("rawBytes")
  })
})
