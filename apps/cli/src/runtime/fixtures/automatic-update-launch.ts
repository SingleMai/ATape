// Installed-package acceptance binding. The real Node Adapter dispatches a copy
// of the packaged executable; this source fixture is not a public CLI Interface.
import { kickAutomaticUpdates } from "@atape/application"
import { Effect, Layer } from "effect"
import { defaultNodeClientPaths } from "../clientPaths.ts"
import { makeAdapterPackagesLayer } from "../adapterPackages.ts"
import { makeAutomaticUpdatePlatformLayer } from "../managedUpdates.ts"
import { makeSelectedConfigStoreLayer } from "../runtimeSelection.ts"
import { managedStateContract } from "../runtimeSelection.ts"
import { updateControlProtocol } from "../updateControl.ts"
import { createReleaseDiscovery } from "../releaseDiscovery.ts"

const paths = defaultNodeClientPaths()
const version = process.env.UPDATE_FIXTURE_VERSION
const bootstrap = process.env.ATAPE_BOOTSTRAP_ENTRY
if (!version || !bootstrap) throw new Error("Isolated package update fixture metadata is required.")
const discovery = createReleaseDiscovery({ home: paths.atapeHome, runtimeVersion: version,
  captureStateContract: managedStateContract, updateControlProtocol })
await Effect.runPromise(kickAutomaticUpdates().pipe(Effect.provide(Layer.merge(
  makeSelectedConfigStoreLayer(paths),
  makeAutomaticUpdatePlatformLayer(paths, bootstrap, version).pipe(Layer.provide(makeAdapterPackagesLayer(paths.adapterDirectory, globalThis.fetch, async () => [], discovery)))
))))
