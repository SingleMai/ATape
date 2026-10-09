// A real update owner used to exercise abrupt process death through the same
// validation Interface as automatic preparation and Collector readiness.
import { Effect } from "effect"
import { defaultNodeClientPaths } from "../clientPaths.ts"
import { validateCollectorAdapters } from "../collectorReadiness.ts"
import { readSelectedClientConfig } from "../runtimeSelection.ts"
import { acquireUpdateWorker } from "../updateOwnership.ts"

const paths = defaultNodeClientPaths()
await Effect.runPromise(Effect.acquireUseRelease(
  Effect.tryPromise({
    try: () => acquireUpdateWorker(paths.atapeHome),
    catch: cause => cause instanceof Error ? cause : new Error(String(cause))
  }),
  release => release === undefined
    ? Effect.fail(new Error("The test update owner could not acquire update ownership."))
    : readSelectedClientConfig(paths).pipe(Effect.flatMap(config => validateCollectorAdapters(paths, config))),
  release => Effect.sync(() => release?.())
))
