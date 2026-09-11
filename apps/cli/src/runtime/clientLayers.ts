import { CollectorRunStatusStore, makeGitSourceAttributionLayer } from "@atape/application"
import { cliVersion } from "../version.ts"
import { hostname, platform, arch } from "node:os"
import { Effect, Layer } from "effect"
import type { AdapterPackageFetch } from "./adapterPackageSource.ts"
import type { NodeClientPaths } from "./clientPaths.ts"
import { makeConfigStoreLayer, readClientConfig } from "./clientConfig.ts"
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
import { makeAdapterReleasesLayer } from "./adapterReleases.ts"
import { makeGitSourceBindingsLayer } from "./gitSourceBindings.ts"

// Existing Node caller Interface; implementations live at their own Seams.
export { defaultNodeClientPaths, type NodeClientPaths } from "./clientPaths.ts"
export { makeConfigStoreLayer, readClientConfigLocale } from "./clientConfig.ts"
export { makeProjectLocatorLayer } from "./projectLocator.ts"
export { makeAdapterPackagesLayer } from "./adapterPackages.ts"

export const makeNodeClientLayer = (
  paths: NodeClientPaths,
  environment: NodeJS.ProcessEnv = process.env,
  fetchAdapterPackage: AdapterPackageFetch = globalThis.fetch,
  fetchAuthentication: typeof globalThis.fetch = globalThis.fetch
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
      const config = yield* readClientConfig(paths.configFile).pipe(
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
    projectSetup, locator, makeGitSourceBindingsLayer(`${paths.collectorStateFile}.git-attribution`)
  )))
  const collector = makeNodeCollectorLayer(paths, environment).pipe(
    Layer.provide(Layer.mergeAll(authenticatedHTTP, gitAttribution, locator))
  )
  return Layer.mergeAll(
    authentication,
    authenticatedHTTP,
    makeDeviceMonitoringLayer(paths.atapeHome, readClientConfig(paths.configFile), globalThis.fetch,
      CollectorRunStatusStore.use(store => store.read()).pipe(Effect.provide(makeCollectorRunStatusLayer(paths.collectorStatusFile)))).pipe(Layer.provide(authenticatedHTTP)),
    makeConfigStoreLayer(paths.configFile),
    makeCLISetupPlatformLayer(paths, environment),
    makeCLIUpgradePlatformLayer(paths.atapeHome, process.argv[1] ?? "", environment),
    makeAdapterReleasesLayer(paths.atapeHome),
    locator,
    makeAdapterPackagesLayer(paths.adapterDirectory, fetchAdapterPackage),
    projectSetup,
    collector,
    makeNodeCollectorDaemonLayer(paths, process.argv[1] ?? "", environment)
  )
}
