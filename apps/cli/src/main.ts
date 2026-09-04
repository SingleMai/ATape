#!/usr/bin/env node

import { Effect } from "effect"
import { parseCLI, runCommand } from "./commands.ts"
import { defaultNodeClientPaths, makeNodeClientLayer } from "./runtime/clientLayers.ts"

const main = async () => {
  let command
  try {
    command = parseCLI(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exitCode = 2
    return
  }

  const cancellation = new AbortController()
  const stop = () => cancellation.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    await Effect.runPromise(
      runCommand(command).pipe(
        Effect.provide(makeNodeClientLayer(defaultNodeClientPaths())),
        Effect.matchEffect({
          onFailure: (error: unknown) => Effect.sync(() => {
            const message = error instanceof Error ? error.message : String(error)
            process.stderr.write(`ATape: ${message}\n`)
            process.exitCode = 1
          }),
          onSuccess: () => Effect.void
        })
      ),
      { signal: cancellation.signal }
    )
  } catch (cause) {
    if (!cancellation.signal.aborted) throw cause
  } finally {
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
  }
}

main().catch((cause) => {
  process.stderr.write(`ATape failed unexpectedly: ${cause instanceof Error ? cause.message : String(cause)}\n`)
  process.exitCode = 1
})
