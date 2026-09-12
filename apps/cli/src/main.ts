#!/usr/bin/env node

import { Effect } from "effect"
import { parseCLI } from "./commandInput.ts"
import { runCommand } from "./commands.ts"
import { defaultNodeClientPaths, makeNodeClientLayer, readClientConfigLocale } from "./runtime/clientLayers.ts"
import { requestsGuidedExperience, supportsInteractiveExperience } from "./interactiveEligibility.ts"
import { initializeCliI18n, resolveCliLocale, t } from "./i18n/index.ts"

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
    await Effect.runPromise(
      runCommand(command).pipe(
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
