import {
  CollectorRunState as CollectorRunStateSchema, emptyClientConfig,
  type CollectorRunState, type RedactionConfigurationDescriptor
} from "@atape/domain"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ClientConfigStore } from "./clientManagement.ts"
import { runCollectionCycle } from "./collector.ts"
import { AdapterRuntimes, CollectorConfigurationError, CollectorStateStore, CollectorTransport, SecretRedactor,
  AdapterRuntimeError } from "./collectorContracts.ts"
import { CollectorDaemonProcess, CollectorDaemonProcessError, type CollectorDaemonObservation } from "./collectorDaemonProcess.ts"
import { CollectorRedactionPolicies } from "./collectorRedactionPolicy.ts"
import { scopeCollectorReport } from "./collectorMonitoring.ts"
import { CollectorRunStatusStore, CollectorRunStatusError, inspectCollectorRedaction,
  type CollectorRedactionJobEvent } from "./collectorRunStatus.ts"
import { SourceCaptureCollector } from "./sourceCollector.ts"

const at = "2026-10-10T00:00:00.000Z"
const descriptor = (revision = "saved-1", configFile = "/state/config/redaction.json"): RedactionConfigurationDescriptor => ({
  configFile, origin: "default", revision, exists: true, literalCount: 2, customRuleCount: 1
})
const observation: CollectorDaemonObservation = { generation: "generation-1", pid: 42, startedAt: at }
const config = {
  ...emptyClientConfig(), toolsConfigured: true, enabledAdapterIds: ["fixture"],
  projects: [{ id: "project", instanceOrigin: "https://atape.test", userId: "user", teamId: "team", teamSlug: "team",
    teamName: "Team", name: "Project", type: "directory" as const, path: "/work/project", createdAt: at }],
  adapters: [{ adapterId: "fixture", packageName: "@atape/adapter-fixture", upgradeSpec: "@atape/adapter-fixture",
    displayName: "Fixture", version: "1.0.0", installedAt: at, updatedAt: at }]
}
const state = (): CollectorRunState => ({ version: 1, jobs: [], redaction: {
  generation: observation.generation, configFile: descriptor().configFile, origin: "default", jobs: [{
    projectId: "project", adapterId: "fixture", attemptId: "attempt", startedAt: at, updatedAt: at,
    phase: "active", snapshot: descriptor()
  }]
} })

const inspection = (options: {
  observations?: ReadonlyArray<CollectorDaemonObservation | undefined>
  status?: CollectorRunState
  fail?: "observe" | "read"
} = {}) => {
  let reads = 0
  const observations = [...(options.observations ?? [observation, observation])]
  const layer = Layer.mergeAll(
    Layer.succeed(CollectorDaemonProcess, {
      start: () => Effect.die("Inspection cannot start collection"), resume: () => Effect.die("Inspection cannot resume"),
      pause: () => Effect.die("Inspection cannot pause"), stop: () => Effect.die("Inspection cannot stop"),
      refresh: () => Effect.die("Inspection cannot refresh runtime"), inspect: () => Effect.die("Inspection cannot repair metadata"),
      observe: () => options.fail === "observe"
        ? Effect.fail(new CollectorDaemonProcessError({ reason: "io", message: "PRIVATE_ERROR" }))
        : Effect.sync(() => observations.shift())
    }),
    Layer.succeed(CollectorRunStatusStore, {
      read: () => Effect.suspend(() => { reads++; return options.fail === "read"
        ? Effect.fail(new CollectorRunStatusError({ reason: "decode", message: "PRIVATE_ERROR" }))
        : Effect.succeed(options.status ?? state()) }),
      recordCycle: () => Effect.die("Inspection cannot record a cycle"),
      recordCollectorFailure: () => Effect.die("Inspection cannot record a failure"),
      recordRedactionJob: () => Effect.die("Inspection cannot record a job")
    })
  )
  return { inspect: (target?: { configFile: string; revision: string }) =>
    Effect.runPromise(inspectCollectorRedaction(target).pipe(Effect.provide(layer))), reads: () => reads }
}

describe("Collector redaction observation Interface", () => {
  it.each([
    [descriptor(), "matches"], [descriptor("saved-2"), "different_revision"],
    [descriptor("saved-1", "/another/redaction.json"), "different_file"], [undefined, "unknown"]
  ] as const)("compares the saved file with the observed job snapshot %#", async (target, comparison) => {
    const result = await inspection().inspect(target)
    expect(result).toMatchObject({ state: "running", configFile: descriptor().configFile, origin: "default",
      jobs: [{ scope: "current", comparison, phase: "active", snapshot: descriptor() }] })
    expect(new Date(result.checkedAt).toISOString()).toBe(result.checkedAt)
    expect(result).not.toHaveProperty("generation")
  })

  it.each([
    [observation, { ...observation, generation: "replacement" }],
    [observation, { ...observation, pid: 43 }],
    [observation, { ...observation, startedAt: "2026-10-10T00:00:01Z" }],
    [observation, undefined], [undefined, observation]
  ])("discards jobs when process observations disagree %#", async (before, after) => {
    expect(await inspection({ observations: [before, after] }).inspect(descriptor())).toMatchObject({ state: "unknown", jobs: [] })
  })

  it("does not reuse another generation or legacy status as current policy information", async () => {
    const previous = { ...state(), redaction: { ...state().redaction!, generation: "old" } }
    for (const status of [previous, { version: 1 as const, jobs: [] }]) {
      expect(await inspection({ status }).inspect()).toMatchObject({ state: "unknown", jobs: [] })
    }
  })

  it("labels retained snapshots as historical only after observing a stopped process twice", async () => {
    expect(await inspection({ observations: [undefined, undefined] }).inspect(descriptor())).toMatchObject({ state: "stopped",
      jobs: [{ scope: "historical", comparison: "matches", snapshot: descriptor() }] })
    expect(await inspection({ observations: [undefined, undefined], status: { version: 1, jobs: [] } }).inspect())
      .toMatchObject({ state: "stopped", jobs: [] })
  })

  it("shows loading and load failure without borrowing a previous job snapshot", async () => {
    for (const phase of ["loading", "load_failed"] as const) {
      const original = state(), { snapshot: _, ...job } = original.redaction!.jobs[0]!
      const status = { ...original, redaction: { ...original.redaction!, jobs: [{ ...job, phase }] } }
      expect(await inspection({ status }).inspect(descriptor())).toMatchObject({ state: "running",
        jobs: [{ phase, scope: "current", comparison: "unknown" }] })
    }
  })

  it.each(["observe", "read"] as const)("returns content-free unknown on %s failure", async fail => {
    const result = await inspection({ fail }).inspect(descriptor())
    expect(result).toMatchObject({ state: "unknown", jobs: [] })
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ERROR")
    expect(result).not.toHaveProperty("configFile")
  })

  it("keeps version-1 status compatible and excludes local privacy metadata from device reports", () => {
    const legacy = { version: 1 as const, jobs: [] }
    expect(Schema.decodeUnknownSync(CollectorRunStateSchema)(legacy)).toEqual(legacy)
    const local = Schema.decodeUnknownSync(CollectorRunStateSchema)(state())
    expect(local).toEqual(state())
    const snapshot = { phase: "waiting" as const, jobs: [], jobsTruncated: false }
    const account = { instanceOrigin: "https://atape.test", userId: "user" }
    const remote = scopeCollectorReport(snapshot, config, account, local)
    expect(remote).toEqual(scopeCollectorReport(snapshot, config, account, legacy))
    for (const privateValue of [descriptor().configFile, descriptor().revision, observation.generation]) {
      expect(JSON.stringify(remote)).not.toContain(privateValue)
    }
    expect(remote).not.toHaveProperty("redaction")
  })
})

const collection = (projects = 1) => {
  const events: CollectorRedactionJobEvent[] = []
  const usedSnapshots: Array<{ projectId: string; masked: string }> = []
  let selected = descriptor(), opens = 0, failLoad = false, failOpen = false, failObservation = false
  let loading: Effect.Effect<void> = Effect.void
  let collecting: (projectId: string) => Effect.Effect<void> = () => Effect.void
  let opened: () => void = () => {}
  const redactor = { redact: (value: string) => ({ value, replacements: 0 }) }
  const layer = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, { transact: change => change({ ...config,
      projects: Array.from({ length: projects }, (_, index) => ({ ...config.projects[0]!, id: `project-${index}` }))
    }).pipe(Effect.map(result => result.value)) }),
    Layer.succeed(CollectorStateStore, { capturedScopes: () => Effect.succeed([]),
      snapshot: () => Effect.sync(() => {
        if (!failObservation) expect(events.at(-1)).toMatchObject({ kind: "loaded" })
        return { installationId: "installation" }
      }), commit: () => Effect.void }),
    Layer.succeed(SecretRedactor, redactor),
    Layer.succeed(CollectorRedactionPolicies, { snapshot: () => loading.pipe(Effect.andThen(Effect.suspend(() => failLoad
      ? Effect.fail(new CollectorConfigurationError({ reason: "limits", message: "PRIVATE_ERROR" }))
      : Effect.sync(() => {
        const pinned = selected
        return { redactor: { redact: (value: string) => ({ value: `${pinned.revision}:${value}`, replacements: 1 }) }, descriptor: pinned }
      })))) }),
    Layer.succeed(AdapterRuntimes, { open: () => Effect.suspend(() => {
      opens++; opened()
      return failOpen ? Effect.fail(new AdapterRuntimeError({ adapterId: "fixture", reason: "load", retryable: false, message: "Failed" }))
        : Effect.succeed({ attribute: () => Effect.succeed("included" as const), sourceCapture: {
          discover: () => Effect.die("The controlled collector owns discovery"),
          open: () => Effect.die("The controlled collector owns sources")
        } })
    }) }),
    Layer.succeed(SourceCaptureCollector, { collect: (project, adapter) => Effect.gen(function*() {
      usedSnapshots.push({ projectId: project.id, masked: (yield* SecretRedactor).redact("message").value })
      yield* collecting(project.id)
      return { projectId: project.id, adapterId: adapter.adapterId, pages: 1, observations: 0, canonicalBatches: 0,
        rawChunks: 0, redactions: 0, hasMore: false }
    }) }),
    Layer.succeed(CollectorTransport, { rawCaptureEnabled: () => Effect.die("Unexpected legacy transport"),
      submitCanonical: () => Effect.die("Unexpected legacy transport"), appendRaw: () => Effect.die("Unexpected legacy transport") }),
    Layer.succeed(CollectorRunStatusStore, { read: () => Effect.succeed({ version: 1, jobs: [] }),
      recordCycle: () => Effect.void, recordCollectorFailure: () => Effect.void,
      recordRedactionJob: event => Effect.suspend(() => failObservation
        ? Effect.fail(new CollectorRunStatusError({ reason: "io", message: "PRIVATE_OBSERVER_ERROR" }))
        : Effect.sync(() => { events.push(structuredClone(event)) })) })
  )
  return { events, usedSnapshots, opens: () => opens,
    run: <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(effect.pipe(Effect.provide(layer))),
    select: (value: RedactionConfigurationDescriptor) => { selected = value },
    onOpen: (work: () => void) => { opened = work }, onLoad: (work: Effect.Effect<void>) => { loading = work },
    onCollect: (work: (projectId: string) => Effect.Effect<void>) => { collecting = work },
    failLoad: () => { failLoad = true }, failOpen: () => { failOpen = true }, failObservation: () => { failObservation = true }
  }
}

describe("collection job redaction observations through runCollectionCycle", () => {
  it("records the actual pinned snapshot before opening, and a distinct attempt on the next job", async () => {
    const f = collection()
    f.onOpen(() => {
      expect(f.events.at(-1)).toMatchObject({ kind: "loaded", snapshot: descriptor() })
      f.select(descriptor("saved-2"))
    })
    expect((await f.run(runCollectionCycle())).failures).toEqual([])
    f.onOpen(() => {})
    expect((await f.run(runCollectionCycle())).failures).toEqual([])
    expect(f.events.map(event => event.kind)).toEqual(["loading", "loaded", "finished", "loading", "loaded", "finished"])
    expect(f.events[1]).toMatchObject({ snapshot: descriptor() })
    expect(f.events[4]).toMatchObject({ snapshot: descriptor("saved-2") })
    expect(f.usedSnapshots.map(item => item.masked)).toEqual(["saved-1:message", "saved-2:message"])
    expect(f.events[0]!.attemptId).not.toBe(f.events[3]!.attemptId)
    expect(f.events[2]).toMatchObject({ outcome: "completed", attemptId: f.events[0]!.attemptId })
  })

  it("records safe policy-load failure before acquiring an Adapter", async () => {
    const f = collection(); f.failLoad()
    expect((await f.run(runCollectionCycle())).failures).toHaveLength(1)
    expect(f.opens()).toBe(0)
    expect(f.events.map(event => event.kind)).toEqual(["loading", "finished"])
    expect(f.events[1]).toMatchObject({ outcome: "load_failed" })
    expect(JSON.stringify(f.events)).not.toContain("PRIVATE_ERROR")
  })

  it("does not relabel a later collection failure as a policy-load failure", async () => {
    const f = collection(); f.failOpen()
    expect((await f.run(runCollectionCycle())).failures).toHaveLength(1)
    expect(f.events.map(event => event.kind)).toEqual(["loading", "loaded", "finished"])
    expect(f.events[2]).toMatchObject({ outcome: "failed" })
  })

  it.each(["loading", "collection"] as const)("records interruption during %s", async stage => {
    const f = collection(), entered = Deferred.makeUnsafe<void>()
    const block = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
    stage === "loading" ? f.onLoad(block) : f.onCollect(() => block)
    await f.run(Effect.gen(function*() {
      const fiber = yield* runCollectionCycle().pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
    }))
    expect(f.events.at(-1)).toMatchObject({ kind: "finished", outcome: "interrupted" })
    expect(f.events.filter(event => event.kind === "loaded")).toHaveLength(stage === "loading" ? 0 : 1)
  })

  it("keeps concurrent job attempts and their independently pinned revisions distinct", async () => {
    const f = collection(2), bothStarted = Deferred.makeUnsafe<void>(), release = Deferred.makeUnsafe<void>()
    const started = new Set<string>()
    let loads = 0
    f.onLoad(Effect.sync(() => { loads++; f.select(descriptor(`saved-${loads}`)) }))
    f.onCollect(projectId => Effect.gen(function*() {
      started.add(projectId)
      if (started.size === 2) yield* Deferred.succeed(bothStarted, undefined)
      yield* Deferred.await(release)
    }))
    await f.run(Effect.gen(function*() {
      const fiber = yield* runCollectionCycle({ concurrency: 2 }).pipe(Effect.forkChild)
      yield* Deferred.await(bothStarted)
      const loaded = f.events.filter(event => event.kind === "loaded")
      expect(new Set(loaded.map(event => event.projectId)).size).toBe(2)
      expect(new Set(loaded.map(event => event.attemptId)).size).toBe(2)
      expect(loaded.map(event => event.snapshot.revision).sort()).toEqual(["saved-1", "saved-2"])
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(fiber)).failures).toEqual([])
    }))
    expect(f.events.filter(event => event.kind === "finished")).toHaveLength(2)
  })

  it("preserves real collection behavior when only observation writes fail", async () => {
    const f = collection(); f.failObservation()
    expect((await f.run(runCollectionCycle())).failures).toEqual([])
    expect(f.opens()).toBe(1)
    expect(f.events).toEqual([])
  })
})
