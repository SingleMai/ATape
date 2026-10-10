import { makeSecretRedactorLayer, makeSourceCaptureCollectorLayer, defaultSourceCollectionLimits, CollectorConfigurationError, AdapterRuntimeError,
  CollectorRedactionPolicies, secretRedactorForPolicy } from "@atape/application"
import { dirname } from "node:path"
import { Effect, Layer } from "effect"
import { makeCaptureJournalsLayer } from "./captureBootstrap.ts"
import { makePublicationTransportLayer } from "./publicationTransport.ts"
import { makeRawPublicationTransportLayer } from "./rawPublicationTransport.ts"
import { makeCollectorStateLayer } from "./collectorState.ts"
import { makeAdapterRuntimeLayer } from "./adapterHost.ts"
import { makeCollectorTransportLayer } from "./collectorTransport.ts"
import { isCollectorMaintenancePending } from "./collectorDaemonLayers.ts"
import { loadNodeRedactionPolicySnapshot } from "./redactionPolicy.ts"
import { runtimeContext } from "./runtimeAdmission.ts"

export { makeCollectorStateLayer, withCollectorInstallation } from "./collectorState.ts"
export { makeAdapterRuntimeLayer } from "./adapterHost.ts"
export { makeCollectorTransportLayer } from "./collectorTransport.ts"
export { environmentSecretValues } from "./redactionPolicy.ts"

export type NodeCollectorPaths = {
  readonly atapeHome?: string
  readonly collectorStateFile: string
  readonly adapterDirectory: string
  readonly collectorProcessFile?: string
}

export const makeNodeCollectorLayer = (
  paths: NodeCollectorPaths,
  environment: NodeJS.ProcessEnv = process.env
) => {
  const runtime = runtimeContext(paths.atapeHome ?? environment.ATAPE_HOME ?? dirname(paths.collectorStateFile))
  const states = makeCollectorStateLayer(paths.collectorStateFile, runtime)
  const journals = makeCaptureJournalsLayer(paths.collectorStateFile, runtime)
  // The compatibility requirement is inert with respect to disk/configuration.
  // Every production job replaces it with a freshly loaded immutable snapshot.
  const redactor = makeSecretRedactorLayer()
  const policies = Layer.succeed(CollectorRedactionPolicies, CollectorRedactionPolicies.of({
    snapshot: () => loadNodeRedactionPolicySnapshot({ mode: "collector", stateFile: paths.collectorStateFile,
      atapeHome: paths.atapeHome ?? environment.ATAPE_HOME ?? dirname(paths.collectorStateFile), environment }).pipe(
      Effect.map(({ policy, descriptor }) => ({ redactor: secretRedactorForPolicy(policy), descriptor })), Effect.mapError(() => new CollectorConfigurationError({ reason: "limits",
        message: "The local redaction policy or its private identity is invalid. Fix the configuration or restore the existing redaction key with Collector state." })))
  }))
  const configured = environment.ATAPE_SOURCE_COLLECTION_LIMITS
  const admission = configured === undefined ? Effect.succeed(defaultSourceCollectionLimits) : Effect.try({
    try: () => {
      if (new TextEncoder().encode(configured).byteLength > 16384) throw new Error("Source admission is too large")
      return JSON.parse(configured) as unknown
    },
    catch: () => new CollectorConfigurationError({ reason: "limits", message: "ATAPE_SOURCE_COLLECTION_LIMITS must be bounded JSON source admission." })
  })
  const sources = Layer.unwrap(admission.pipe(Effect.map(value => makeSourceCaptureCollectorLayer(value)))).pipe(Layer.provide(Layer.mergeAll(
    states, journals, redactor, makePublicationTransportLayer(), makeRawPublicationTransportLayer()
  )))
  const jobAdmission = paths.collectorProcessFile === undefined ? undefined : Effect.tryPromise({
    try: async () => {
      if (await isCollectorMaintenancePending(paths.collectorProcessFile!)) throw new Error("Collector admission is paused for an ATape update.")
    },
    catch: () => new AdapterRuntimeError({ reason: "load", adapterId: "host", retryable: true, message: "Collector admission is paused for an ATape update." })
  })
  return Layer.mergeAll(states, journals, makeAdapterRuntimeLayer(paths.adapterDirectory, jobAdmission), makeCollectorTransportLayer(), redactor, policies, sources)
}
