// Installed-package acceptance uses the shipped registration and lifecycle
// Interfaces. The external command Adapter is confined to the isolated fixture.
import {
  configureAutomaticUpdates,
  inspectUpdateWake,
  reconcileUpdateWake,
  stopManagedCollector
} from "@atape/application"
import { isAbsolute, join } from "node:path"
import { Effect, Layer } from "effect"
import { defaultNodeClientPaths } from "../clientPaths.ts"
import { makeNodeCollectorDaemonLayer } from "../collectorDaemonLayers.ts"
import { executeOwnedProcess } from "../ownedProcess.ts"
import { makeSelectedConfigStoreLayer, resolveRuntimeEntry } from "../runtimeSelection.ts"
import { makeUpdateWakePlatformLayer } from "../updateWake.ts"

const root = process.env.UPDATE_WAKE_FIXTURE_ROOT
const bootstrap = process.env.ATAPE_BOOTSTRAP_ENTRY
const adapter = process.env.UPDATE_WAKE_FIXTURE_COMMAND_ADAPTER
const userHome = process.env.HOME
if (!root || !bootstrap || !adapter || !userHome ||
  ![bootstrap, adapter, userHome, process.env.ATAPE_HOME ?? ""].every(path => isAbsolute(path) && path.startsWith(`${root}/`)) ||
  adapter !== join(root, "controlled-manager.mjs")) {
  throw new Error("An isolated scheduled-update package fixture is required.")
}
const paths = defaultNodeClientPaths()
const execute: typeof executeOwnedProcess = (file, args, environment, signal, timeout) => {
  if (timeout > 10_000) throw new Error("Invalid controlled manager lifetime")
  return executeOwnedProcess(process.execPath, [adapter, file, ...args], environment, signal, timeout)
}
const layer = Layer.mergeAll(
  makeSelectedConfigStoreLayer(paths),
  makeNodeCollectorDaemonLayer(paths, () => resolveRuntimeEntry(paths.atapeHome, bootstrap), process.env),
  makeUpdateWakePlatformLayer(paths, bootstrap, process.env, { homeDirectory: userHome, execute })
)
const result = await Effect.runPromise(Effect.gen(function*() {
  switch (process.argv[2]) {
    case "register": return yield* reconcileUpdateWake()
    case "enable": return yield* configureAutomaticUpdates(true)
    case "disable": return yield* configureAutomaticUpdates(false)
    case "inspect": return yield* inspectUpdateWake()
    case "stop": return yield* stopManagedCollector()
    default: throw new Error("Unknown scheduled-update fixture operation")
  }
}).pipe(Effect.provide(layer)))
process.stdout.write(`${JSON.stringify(result)}\n`)
