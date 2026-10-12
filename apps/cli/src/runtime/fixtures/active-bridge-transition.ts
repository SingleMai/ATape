// Setup and inspection use existing caller Interfaces. Automatic update and capture
// execute the genuine installed CLI archives, never the source-checkout runtime.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Logger } from "effect"
import {
  ClientConfigStore, CLICredentialStore, CollectorStateStore, inspectClient,
  inspectManagedCollector, installAdapter, kickAutomaticUpdates, startManagedCollector, stopManagedCollector
} from "@atape/application"
import { defaultNodeClientPaths, makeNodeClientLayer } from "../clientLayers.ts"
import { createUpdateControl, updateControlProtocol } from "../updateControl.ts"
import { readCollectorSyncWanted } from "../collectorDaemonLayers.ts"
import { runtimeEntry } from "../runtimeSelection.ts"

type Input = { phase: string; root: string; baselineCodexTarball: string; baselineClaudeTarball: string; bootstrap: string; version: string }
const input: Input = JSON.parse(readFileSync(process.argv[2]!, "utf8"))
assert.equal(process.env.HOME, join(input.root, "user"), "The helper itself requires disposable HOME")
const paths = defaultNodeClientPaths(), origin = "https://upgrade-fixture.invalid", userId = "upgrade-user"
const layer = makeNodeClientLayer(paths)
const config = () => ClientConfigStore.use(store => store.transact(current => Effect.succeed({ value: current })))
const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  if (input.phase === "seed-old-bootstrap-boundary") {
    const home = join(input.root, "old-bootstrap-boundary"), control = createUpdateControl(home)
    const oldEntry = input.bootstrap
    const ticket = yield* Effect.promise(() => control.prepare({ next: {
      protocol: updateControlProtocol, version: input.version, captureStateContract: "atape.client.v3-capture.v2",
      bootstrapEntry: oldEntry, bootstrapIdentity: createHash("sha256").update(readFileSync(oldEntry)).digest("hex"), adapters: []
    } }))
    yield* Effect.promise(() => control.begin(ticket))
    yield* Effect.promise(() => control.fence(ticket))
    const ledger = join(home, "updates", "capture-migration.json")
    yield* Effect.promise(() => writeFile(ledger, JSON.stringify({ protocol: "atape.capture-migration.v999", opaqueFutureFixture: true }) + "\n"))
    return { home, ledger, oldEntry }
  }
  if (input.phase === "setup") {
    yield* ClientConfigStore.use(store => store.transact(current => Effect.succeed({ value: undefined,
      config: { ...current, autoUpdateEnabled: false, autoStartEnabled: false } })))
    yield* CLICredentialStore.use(store => store.replace({ credential: { version: 1, instanceOrigin: origin,
      apiOrigin: origin, credential: "atc_v1_synthetic_upgrade_credential", credentialId: "upgrade-contract",
      capabilityVersion: "atape-cli.v1", createdAt: "2026-10-11T00:00:00Z", user: { id: userId, displayName: "Upgrade fixture" } } }))
    const installed = yield* installAdapter(input.baselineCodexTarball)
    assert.equal(installed.adapter.version, "0.5.10")
    const claude = yield* installAdapter(input.baselineClaudeTarball)
    assert.equal(claude.adapter.version, "0.5.10")
    yield* Effect.promise(() => mkdir(join(input.root, "workspace"), { recursive: true }))
    yield* ClientConfigStore.use(store => store.transact(current => Effect.succeed({ value: undefined,
      config: { ...current, adapters: current.adapters.map(adapter => ({ ...adapter, upgradeSpec: adapter.packageName })),
        projects: [{ id: "upgrade-project", path: join(input.root, "workspace"), type: "directory", instanceOrigin: origin,
          userId, teamId: "upgrade-team", teamSlug: "upgrade", teamName: "Upgrade fixture", name: "Upgrade Project",
          createdAt: "2026-10-11T00:00:00Z" }], toolsConfigured: true, enabledAdapterIds: ["codex", "claude"] } })))
    const control = createUpdateControl(paths.atapeHome)
    const ticket = yield* Effect.promise(async () => control.prepare({ next: {
      protocol: updateControlProtocol, version: "0.5.10", captureStateContract: "atape.client.v3-capture.v2",
      bootstrapEntry: input.bootstrap, bootstrapIdentity: createHash("sha256").update(await readFile(input.bootstrap)).digest("hex"), adapters: []
    } }))
    yield* Effect.promise(() => control.begin(ticket))
    yield* Effect.promise(() => control.complete(ticket))
    assert.ok(yield* Effect.promise(() => readFile(runtimeEntry(paths.atapeHome, "0.5.10"))))
    yield* startManagedCollector({ intervalMs: 10_000, concurrency: 1 })
    for (let n = 0; n < 200; n++) {
      const status = yield* inspectManagedCollector()
      assert.equal(status.running, true)
      if (status.lastCycleCompletedAt) {
        assert.equal(status.collectorFailure, undefined)
        assert.equal(status.jobs.find(job => job.adapterId === "codex")?.state, "healthy", "Genuine old collection must remain available")
        return status
      }
      yield* Effect.sleep(100)
    }
    throw new Error("The genuine old Collector did not complete its first bounded cycle")
  }
  if (input.phase === "enable-auto" || input.phase === "disable-auto") {
    yield* ClientConfigStore.use(store => store.transact(current => Effect.succeed({ value: undefined,
      config: { ...current, autoUpdateEnabled: input.phase === "enable-auto" } })))
  }
  if (input.phase === "dispatch") { yield* kickAutomaticUpdates(); return { dispatched: true } }
  if (input.phase === "request-stop" || input.phase === "cleanup") {
    yield* stopManagedCollector()
    return { wanted: yield* Effect.promise(() => readCollectorSyncWanted(paths.collectorProcessFile)) }
  }
  if (input.phase === "start") yield* startManagedCollector({ intervalMs: 10_000, concurrency: 1 })
  if (input.phase === "stop") yield* stopManagedCollector()
  const state = yield* CollectorStateStore.use(store => store.snapshot(origin, userId, "upgrade-project", "codex"))
  return { status: yield* inspectManagedCollector(), config: yield* config(), effective: yield* inspectClient(),
    state, wanted: yield* Effect.promise(() => readCollectorSyncWanted(paths.collectorProcessFile)),
    selection: yield* Effect.promise(() => createUpdateControl(paths.atapeHome).readSelection()) }
})).pipe(Effect.provide(layer), Effect.provide(Logger.layer([]))))
process.stdout.write(JSON.stringify(result))
