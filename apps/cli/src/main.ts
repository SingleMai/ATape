#!/usr/bin/env node

import { Effect } from "effect"
import { kickAutomaticUpdates, runAutomaticUpdates } from "@atape/application"
import { rm, realpath } from "node:fs/promises"
import { join } from "node:path"
import { parseCLI } from "./commandInput.ts"
import { runCommand } from "./commands.ts"
import { defaultNodeClientPaths, makeNodeClientLayer, readClientConfigLocale } from "./runtime/clientLayers.ts"
import { requestsGuidedExperience, supportsInteractiveExperience } from "./interactiveEligibility.ts"
import { initializeCliI18n, resolveCliLocale, t } from "./i18n/index.ts"
import { acquireUpdateWorker, needsUpdateRecovery, recoverPendingUpdate } from "./runtime/managedUpdates.ts"
import { readRuntimeSelection, selectedBootstrap, updateDirectory } from "./runtime/runtimeSelection.ts"
import { prepareCollectorReadiness } from "./runtime/collectorReadiness.ts"
import { admitCollectorProcess } from "./runtime/collectorDaemonLayers.ts"
import { delegateManagedRuntime } from "./runtime/runtimeLauncher.ts"
import { cliVersion } from "./version.ts"

const main = async () => {
  let command
  try {
    command = parseCLI(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write(`${t("cli.error.parse", "ATape: {message}", { message: cause instanceof Error ? cause.message : String(cause) })}\n`)
    process.exitCode = 2
    return
  }

  const configLocale = await Effect.runPromise(
    readClientConfigLocale(defaultNodeClientPaths().configFile)
  ).catch(() => undefined)
  initializeCliI18n(resolveCliLocale({
    ...("lang" in command.options && command.options.lang !== undefined ? { flag: command.options.lang } : {}),
    environment: process.env,
    ...(configLocale === undefined ? {} : { config: configLocale })
  }))

  if (requestsGuidedExperience(command) && supportsInteractiveExperience()) {
    const paths = defaultNodeClientPaths()
    if (await needsUpdateRecovery(paths)) {
      const release = await acquireUpdateWorker(paths.atapeHome)
      if (release) {
        try { await recoverPendingUpdate(paths, await selectedBootstrap(paths.atapeHome, process.env.ATAPE_BOOTSTRAP_ENTRY ?? process.argv[1]!), process.env) }
        finally { release() }
        const delegated = await delegateManagedRuntime(process.argv[1]!, process.argv.slice(2), { ...process.env, ATAPE_RUNTIME_DIRECT: "" })
        if (delegated !== undefined) { process.exitCode = delegated; return }
      }
    }
    const { runInteractiveExperience } = await import("./interactive/run.ts")
    await runInteractiveExperience(command)
    return
  }
  if (requestsGuidedExperience(command)) {
    process.stderr.write(`${t("cli.error.interactiveUnsupported", "ATape needs an interactive macOS or Linux terminal. Run atape there to manage projects, tools and settings. Use atape --help for launch options.")}\n`)
    process.exitCode = 2
    return
  }

  const cancellation = new AbortController()
  const stop = () => cancellation.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    if (command.kind === "__automatic-update") {
      const paths = defaultNodeClientPaths()
      const token = command.options.updateToken
      const worker = join(updateDirectory(paths.atapeHome), "workers", `${token}.mjs`)
      if (token !== process.env.ATAPE_UPDATE_WORKER_TOKEN || await realpath(process.argv[1]!) !== await realpath(worker)) {
        throw new Error("This updater entry is reserved for the owning ATape process.")
      }
      try { await Effect.runPromise(Effect.acquireUseRelease(
        Effect.tryPromise({ try: () => acquireUpdateWorker(paths.atapeHome), catch: cause => new Error(String(cause)) }),
        release => release === undefined ? Effect.void : Effect.tryPromise({
          try: async () => recoverPendingUpdate(paths, await selectedBootstrap(paths.atapeHome, process.env.ATAPE_BOOTSTRAP_ENTRY ?? process.argv[1]!), process.env),
          catch: cause => new Error(String(cause))
        }).pipe(Effect.uninterruptible, Effect.andThen(Effect.gen(function*() {
          const current = (yield* Effect.tryPromise({ try: () => readRuntimeSelection(paths.atapeHome), catch: cause => new Error(String(cause)) }))?.version ?? cliVersion
          yield* runAutomaticUpdates(current)
        }))),
        release => Effect.sync(() => release?.())
      ).pipe(Effect.provide(makeNodeClientLayer(paths))), { signal: cancellation.signal }) }
      finally { await rm(worker, { force: true }) }
      return
    }
    const program = command.kind === "__collector-daemon"
      ? Effect.scoped(Effect.gen(function*() {
        yield* admitCollectorProcess(defaultNodeClientPaths().collectorProcessFile, command.options.daemonToken)
        yield* Effect.forkScoped(Effect.forever(kickAutomaticUpdates().pipe(Effect.andThen(Effect.sleep(30_000)))))
        yield* prepareCollectorReadiness(defaultNodeClientPaths(), process.env)
        yield* runCommand(command)
      }))
      : runCommand(command)
    await Effect.runPromise(
      program.pipe(
        Effect.provide(makeNodeClientLayer(defaultNodeClientPaths())),
        Effect.matchEffect({
          onFailure: (error: unknown) => Effect.sync(() => {
            const message = error instanceof Error ? error.message : String(error)
            process.stderr.write(`${t("cli.error.prefix", "ATape: {message}", { message })}\n`)
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
  process.stderr.write(`${t("cli.error.unexpected", "ATape failed unexpectedly: {message}", { message: cause instanceof Error ? cause.message : String(cause) })}\n`)
  process.exitCode = 1
})
