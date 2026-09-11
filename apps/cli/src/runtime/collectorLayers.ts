import { makeSecretRedactorLayer, makeSourceCaptureCollectorLayer, defaultSourceCollectionLimits, CollectorConfigurationError } from "@atape/application"
import { Effect, Layer } from "effect"
import { makeCaptureJournalsLayer } from "./captureBootstrap.ts"
import { makePublicationTransportLayer } from "./publicationTransport.ts"
import { makeRawPublicationTransportLayer } from "./rawPublicationTransport.ts"
import { makeCollectorStateLayer } from "./collectorState.ts"
import { makeAdapterRuntimeLayer } from "./adapterHost.ts"
import { makeCollectorTransportLayer } from "./collectorTransport.ts"

export { makeCollectorStateLayer, withCollectorInstallation } from "./collectorState.ts"
export { makeAdapterRuntimeLayer } from "./adapterHost.ts"
export { makeCollectorTransportLayer } from "./collectorTransport.ts"

export type NodeCollectorPaths = {
  readonly collectorStateFile: string
  readonly adapterDirectory: string
}

export const makeNodeCollectorLayer = (
  paths: NodeCollectorPaths,
  environment: NodeJS.ProcessEnv = process.env
) => {
  const states = makeCollectorStateLayer(paths.collectorStateFile)
  const journals = makeCaptureJournalsLayer(paths.collectorStateFile)
  const redactor = makeSecretRedactorLayer(environmentSecretValues(environment))
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
  return Layer.mergeAll(states, journals, makeAdapterRuntimeLayer(paths.adapterDirectory), makeCollectorTransportLayer(), redactor, sources)
}

export const environmentSecretValues = (environment: NodeJS.ProcessEnv) => {
  const values = Object.entries(environment)
    .filter(([name, value]) => value !== undefined && name !== "ATAPE_REDACT_VALUES" &&
      /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL|DSN)$/i.test(name))
    .map(([, value]) => value as string)
  const configured = environment.ATAPE_REDACT_VALUES
  if (configured) {
    try {
      const parsed = JSON.parse(configured) as unknown
      if (Array.isArray(parsed)) {
        values.push(...parsed.filter((value): value is string => typeof value === "string"))
      } else {
        values.push(configured)
      }
    } catch {
      values.push(...configured.split(",").map((value) => value.trim()).filter(Boolean))
    }
  }
  return values
}
