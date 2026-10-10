import { emptyClientConfig, type ClientConfig, type CollectorRunState } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { ClientConfigStore } from "./clientManagement.ts"
import {
  CollectorDaemonProcess,
  CollectorRunStatusStore,
  inspectManagedCollector,
  resumeManagedCollector,
  startManagedCollector,
  stopManagedCollector
} from "./collectorDaemon.ts"

const now = "2026-09-05T02:30:00.000Z"

const configuredClient = (): ClientConfig => ({
  ...emptyClientConfig(),
  toolsConfigured: true,
  enabledAdapterIds: ["codex"],
  activeInstanceOrigin: "https://atape.net",
  projects: [{
    id: "atape",
    instanceOrigin: "https://atape.net",
    userId: "user-1",
    teamId: "team",
    teamSlug: "team",
    teamName: "Team",
    name: "ATape",
    type: "git",
    path: "/work/atape",
    createdAt: now
  }],
  adapters: [{
    adapterId: "codex",
    packageName: "@atape/adapter-codex",
    upgradeSpec: "@atape/adapter-codex",
    displayName: "Codex",
    version: "0.1.0",
    installedAt: now,
    updatedAt: now
  }]
})

const fixture = (config: ClientConfig, status: CollectorRunState) => {
  let running = false
  let resumes = 0
  let options: { readonly intervalMs: number; readonly concurrency: number } | undefined
  const layer = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, ClientConfigStore.of({
      transact: (change) => change(config).pipe(Effect.map((result) => result.value))
    })),
    Layer.succeed(CollectorDaemonProcess, CollectorDaemonProcess.of({
      observe: () => Effect.die("Unexpected pure process observation"),
      pause: () => Effect.die("Unexpected pause"),
      resume: () => Effect.sync(() => {
        resumes++
        return running ? { ...(options ?? { intervalMs: 30_000, concurrency: 4 }),
          pid: 412, startedAt: now, logFile: "/state/collector.log", created: false } : undefined
      }),
      refresh: () => Effect.succeed(false),
      start: (requested) => Effect.sync(() => {
        running = true
        options = requested
        return {
          ...requested,
          pid: 412,
          startedAt: now,
          logFile: "/state/collector.log",
          created: true
        }
      }),
      stop: () => Effect.sync(() => {
        const stopped = running
        running = false
        return stopped
      }),
      inspect: () => Effect.sync(() => running ? {
        ...(options ?? { intervalMs: 30_000, concurrency: 4 }),
        pid: 412,
        startedAt: now,
        logFile: "/state/collector.log"
      } : undefined)
    })),
    Layer.succeed(CollectorRunStatusStore, CollectorRunStatusStore.of({
      read: () => Effect.succeed(status),
      recordCycle: () => Effect.void,
      recordRedactionJob: () => Effect.void,
      recordCollectorFailure: () => Effect.void
    }))
  )
  return {
    run: <A, E>(effect: Effect.Effect<
      A,
      E,
      ClientConfigStore | CollectorDaemonProcess | CollectorRunStatusStore
    >) =>
      effect.pipe(Effect.provide(layer), Effect.runPromise),
    options: () => options,
    resumes: () => resumes
  }
}

describe("managed Collector Module", () => {
  it("exposes source diagnostics as partial health, not a healthy or failed job", async () => {
    const sourceFailures = [{ source: "/history/unsupported.jsonl", reason: "unsupported" as const }]
    const client = fixture(configuredClient(), { version: 1, jobs: [{
      projectId: "atape", adapterId: "codex", lastAttemptAt: now, lastSuccessAt: now,
      sourceFailures, sourceFailuresTruncated: true
    }] })
    expect((await client.run(inspectManagedCollector())).jobs).toEqual([expect.objectContaining({
      state: "partial", sourceFailures, sourceFailuresTruncated: true
    })])
  })

  it("starts idempotent process management and projects current job health", async () => {
    const status: CollectorRunState = {
      version: 1,
      lastCycleStartedAt: now,
      lastCycleCompletedAt: now,
      jobs: [{
        projectId: "atape",
        adapterId: "codex",
        lastAttemptAt: now,
        lastSuccessAt: now,
        pages: 1,
        observations: 2,
        canonicalBatches: 2,
        rawChunks: 3,
        redactions: 1,
        hasMore: false
      }]
    }
    const client = fixture(configuredClient(), status)

    const started = await client.run(startManagedCollector({ intervalMs: 10_000, concurrency: 2 }))
    const inspected = await client.run(inspectManagedCollector())
    const stopped = await client.run(stopManagedCollector())

    expect(started).toMatchObject({ created: true, pid: 412 })
    expect(client.options()).toEqual({ intervalMs: 10_000, concurrency: 2 })
    expect(inspected).toMatchObject({
      running: true,
      jobs: [{ projectId: "atape", adapterId: "codex", state: "healthy", lastSuccessAt: now }]
    })
    expect(stopped).toBe(true)
  })

  it("refuses to start without a configured Project/Adapter job", async () => {
    const client = fixture(emptyClientConfig(), { version: 1, jobs: [] })
    await expect(client.run(startManagedCollector())).rejects.toMatchObject({
      _tag: "CollectorConfigurationError",
      reason: "project"
    })
  })

  it.each([
    emptyClientConfig(),
    { ...configuredClient(), toolsConfigured: false },
    { ...configuredClient(), projects: [] },
    { ...configuredClient(), enabledAdapterIds: [] }
  ])("does not resume incomplete setup or an empty collection scope %#", async config => {
    const client = fixture(config, { version: 1, jobs: [] })
    expect(await client.run(resumeManagedCollector())).toBeUndefined()
    expect(client.resumes()).toBe(0)
  })

  it("validates local jobs before resuming without a remote or interactive authentication dependency", async () => {
    const client = fixture(configuredClient(), { version: 1, jobs: [] })
    await client.run(startManagedCollector({ intervalMs: 45_000, concurrency: 2 }))
    expect(await client.run(resumeManagedCollector())).toMatchObject({ pid: 412, intervalMs: 45_000, concurrency: 2, created: false })
    await client.run(stopManagedCollector())
    expect(await client.run(resumeManagedCollector())).toBeUndefined()
    expect(client.resumes()).toBe(2)
  })

  it("does not resume a Project whose enabled Adapter is missing", async () => {
    const client = fixture({ ...configuredClient(), adapters: [] }, { version: 1, jobs: [] })
    await expect(client.run(resumeManagedCollector())).rejects.toMatchObject({ reason: "project" })
    expect(client.resumes()).toBe(0)
  })
})
