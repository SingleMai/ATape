import { AdapterReleases, ToolUpdateError } from "@atape/application"
import { Effect, Layer } from "effect"
import { latestPublishedVersion } from "./publishedVersions.ts"

export const makeAdapterReleasesLayer = (home: string, fetchMetadata: typeof globalThis.fetch = globalThis.fetch) =>
  Layer.succeed(AdapterReleases, AdapterReleases.of({
    latest: (packageName, cached) => Effect.tryPromise({
      try: signal => latestPublishedVersion(home, packageName, cached, signal, fetchMetadata),
      catch: () => new ToolUpdateError({ message: "Could not check this tool's latest version. Check your connection and try again." })
    })
  }))
