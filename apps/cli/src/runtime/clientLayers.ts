import { CollectorRunStatusStore, makeGitSourceAttributionLayer } from "@atape/application"
import { cliVersion, captureStateContract } from "../version.ts"
import { hostname, platform, arch } from "node:os"
import { Effect, Layer } from "effect"
import type { AdapterPackageFetch } from "./adapterPackageSource.ts"
import type { NodeClientPaths } from "./clientPaths.ts"
import { makeProjectLocatorLayer } from "./projectLocator.ts"
import { makeAdapterPackagesLayer } from "./adapterPackages.ts"
import { makeNodeCollectorLayer } from "./collectorLayers.ts"
import { makeNodeCollectorDaemonLayer, makeCollectorRunStatusLayer } from "./collectorDaemonLayers.ts"
import { makeNodeAuthenticationLayer } from "./authenticationLayers.ts"
import { makeDeviceMonitoringLayer } from "./deviceMonitoring.ts"
import { makeAuthenticatedHTTPClientLayer } from "./authenticatedHTTPClient.ts"
import { makeProjectSetupGatewayLayer } from "./projectSetupLayers.ts"
import { makeCLISetupPlatformLayer } from "./cliSetupPlatform.ts"
import { makeCLIUpgradePlatformLayer } from "./cliUpgradePlatform.ts"
import { createReleaseDiscovery } from "./releaseDiscovery.ts"
import { runtimeContext } from "./runtimeAdmission.ts"
import { updateControlProtocol } from "./updateControl.ts"
import { makeGitSourceBindingsLayer } from "./gitSourceBindings.ts"
import { makeAutomaticUpdatePlatformLayer, protectedRuntimeSlots } from "./managedUpdates.ts"
import { makeLoginStartupPlatformLayer } from "./loginStartup.ts"
import { makeUpdateWakePlatformLayer } from "./updateWake.ts"
import { makeRedactionSettingsLayer } from "./redactionSettings.ts"
import { makeSelectedConfigStoreLayer, readSelectedClientConfig, resolveRuntimeEntry, selectedBootstrap } from "./runtimeSelection.ts"

// Existing Node caller Interface; implementations live at their own Seams.
export { defaultNodeClientPaths, type NodeClientPaths } from "./clientPaths.ts"
export { makeConfigStoreLayer, readClientConfigLocale } from "./clientConfig.ts"
export { makeProjectLocatorLayer } from "./projectLocator.ts"
export { makeAdapterPackagesLayer } from "./adapterPackages.ts"

export const makeNodeClientLayer = (
  paths: NodeClientPaths,
  environment: NodeJS.ProcessEnv = process.env,
  fetchAdapterPackage: AdapterPackageFetch = globalThis.fetch,
  fetchAuthentication: typeof globalThis.fetch = globalThis.fetch,
  options: { readonly collectorToken?: string } = {}
) => {
  const authentication = makeNodeAuthenticationLayer({
    atapeHome: paths.atapeHome,
    credentialDirectory: paths.credentialDirectory,
    fetch: fetchAuthentication
  })
  const authenticatedHTTP = makeAuthenticatedHTTPClientLayer(
    fetchAuthentication,
    environment.ATAPE_DEVELOPMENT_ALLOW_HTTP === "true",
    Effect.gen(function*() {
      const config = yield* readSelectedClientConfig(paths).pipe(
        Effect.catch(() => Effect.succeed(undefined))
      )
      return { name: hostname(), platform: `${platform()} ${arch()}`, version: cliVersion,
        ...(config === undefined ? {} : { adapters: config.adapters.map((adapter) => ({
          id: adapter.adapterId, version: adapter.version, enabled: config.enabledAdapterIds.includes(adapter.adapterId)
        })) }) }
    })
  ).pipe(
    Layer.provide(authentication)
  )
  const projectSetup = makeProjectSetupGatewayLayer().pipe(
    Layer.provide(authenticatedHTTP)
  )
  const locator = makeProjectLocatorLayer()
  const gitAttribution = makeGitSourceAttributionLayer().pipe(Layer.provide(Layer.mergeAll(
    projectSetup, locator, makeGitSourceBindingsLayer(`${paths.collectorStateFile}.git-attribution`, runtimeContext(paths.atapeHome))
  )))
  const collector = makeNodeCollectorLayer(paths, environment).pipe(
    Layer.provide(Layer.mergeAll(authenticatedHTTP, gitAttribution, locator))
  )
  const discovery = createReleaseDiscovery({ home: paths.atapeHome, runtimeVersion: cliVersion,
    captureStateContract, updateControlProtocol, fetchMetadata: fetchAdapterPackage,
    supportedMigrationPlans: [{ protocol: "atape.capture-migration.v1", id: "journal-v7-to-v8" }] })
  const packages = makeAdapterPackagesLayer(paths.adapterDirectory, fetchAdapterPackage, () => protectedRuntimeSlots(paths.atapeHome), discovery)
  const bootstrapEntry = environment.ATAPE_BOOTSTRAP_ENTRY ?? process.argv[1] ?? ""
  return Layer.mergeAll(
    authentication,
    authenticatedHTTP,
    makeDeviceMonitoringLayer(paths.atapeHome, readSelectedClientConfig(paths), globalThis.fetch,
      CollectorRunStatusStore.use(store => store.read()).pipe(Effect.provide(makeCollectorRunStatusLayer(paths.collectorStatusFile)))).pipe(Layer.provide(authenticatedHTTP)),
    makeSelectedConfigStoreLayer(paths),
    makeRedactionSettingsLayer(paths, environment),
    makeCLISetupPlatformLayer(paths, environment, cliVersion),
    makeCLIUpgradePlatformLayer(paths.atapeHome, bootstrapEntry, environment, globalThis.fetch, cliVersion),
    makeLoginStartupPlatformLayer(paths, bootstrapEntry, environment),
    makeUpdateWakePlatformLayer(paths, bootstrapEntry, environment),
    locator,
    packages,
    makeAutomaticUpdatePlatformLayer(paths, bootstrapEntry, cliVersion, environment).pipe(Layer.provide(packages)),
    projectSetup,
    collector,
    makeNodeCollectorDaemonLayer(paths, async () => resolveRuntimeEntry(paths.atapeHome,
      await selectedBootstrap(paths.atapeHome, bootstrapEntry)), { ...environment, ATAPE_BOOTSTRAP_ENTRY: bootstrapEntry }, options)
  )
}
