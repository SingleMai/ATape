#!/usr/bin/env node

import { Effect } from "effect"
import { startAgentSession, kickAutomaticUpdates, reconcileLoginStartup, reconcileUpdateWake, UpdateWakePlatform, runAutomaticUpdates, runLoginStartup } from "@atape/application"
import { rm, realpath } from "node:fs/promises"
import { join } from "node:path"
import { parseCLI } from "./commandInput.ts"
import { runCommand, writeInformationalCommand, writeRedactionHelp, writeRedactionTestFailure, writeRedactionTestResult, writeStartHelp, writeStartResult } from "./commands.ts"
import { withTerminalState } from "./runtime/terminalState.ts"
import { testLocalRedactionFile } from "./runtime/redactionTest.ts"
import { defaultNodeClientPaths, makeNodeClientLayer, readClientConfigLocale } from "./runtime/clientLayers.ts"
import { requestsGuidedExperience, supportsInteractiveExperience } from "./interactiveEligibility.ts"
import { initializeCliI18n, resolveCliLocale, t } from "./i18n/index.ts"
import { acquireUpdateWorker, needsUpdateRecovery, recoverPendingUpdate } from "./runtime/managedUpdates.ts"
import { legacyBridgeCaptureContract, readEffectiveRuntimeSelection, resolveRuntimeEntry, selectedBootstrap, updateDirectory } from "./runtime/runtimeSelection.ts"
import { createUpdateControl } from "./runtime/updateControl.ts"
import { assertRuntimeDataAdmission, runtimeContext } from "./runtime/runtimeAdmission.ts"
import { prepareCollectorReadiness } from "./runtime/collectorReadiness.ts"
import { admitCollectorProcess } from "./runtime/collectorDaemonLayers.ts"
import { delegateAdmittedLoginStartup, delegateAdmittedUpdateWake, delegateManagedRuntime } from "./runtime/runtimeLauncher.ts"
import { admitLoginStartup, withLoginStartupRecovery } from "./runtime/loginStartup.ts"
import { admitUpdateWake, makeUpdateWakePlatformLayer } from "./runtime/updateWake.ts"
import { cliVersion, captureStateContract } from "./version.ts"
import { assertManualStateUpgradeReady, prepareManualStateUpgrade, recordV2CollectorAdmission } from "./runtime/manualStateUpgrade.ts"
import { applyCaptureMigrationEntry, preflightCaptureMigrationEntry } from "./runtime/captureMigration.ts"
import { makeCaptureMigrationPrerequisitesLayer } from "./runtime/captureMigrationPrerequisites.ts"

const main = async () => {
  let command
  try {
    command = parseCLI(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write(`${t("cli.error.parse", "ATape: {message}", { message: cause instanceof Error ? cause.message : String(cause) })}\n`)
    process.exitCode = 2
    return
  }

  if (command.kind === "__capture-migration-preflight" || command.kind === "__capture-migration-apply") {
    const paths = defaultNodeClientPaths(), context = runtimeContext(paths.atapeHome)
    const signal = AbortSignal.timeout(20_000)
    try {
      const result = command.kind === "__capture-migration-preflight"
        ? await Effect.runPromise(preflightCaptureMigrationEntry(context, command.options).pipe(
          Effect.provide(makeCaptureMigrationPrerequisitesLayer(paths))), { signal })
        : await Effect.runPromise(applyCaptureMigrationEntry(context, command.options), { signal })
      process.stdout.write(`${JSON.stringify(result)}\n`)
    } catch {
      process.stderr.write("ATape capture migration could not complete. Recovery will retry.\n")
      process.exitCode = 1
    }
    return
  }

  if (command.kind === "start-help") {
    initializeCliI18n(resolveCliLocale({ ...(command.options.lang === undefined ? {} : { flag: command.options.lang }), environment: process.env }))
    await Effect.runPromise(writeStartHelp)
    return
  }
  if (command.kind === "start" && !supportsInteractiveExperience()) {
    initializeCliI18n(resolveCliLocale({ ...(command.options.lang === undefined ? {} : { flag: command.options.lang }), environment: process.env }))
    process.stderr.write(`ATape: ${t("cli.start.terminalRequired")}\n`)
    process.exitCode = 2
    return
  }
  if (command.kind === "redaction-test" || command.kind === "redaction-help") {
    initializeCliI18n(resolveCliLocale({
      ...(command.options.lang === undefined ? {} : { flag: command.options.lang }), environment: process.env
    }))
    try {
      const program = command.kind === "redaction-help" ? writeRedactionHelp :
        testLocalRedactionFile(command.options).pipe(Effect.flatMap(writeRedactionTestResult))
      await Effect.runPromise(program.pipe(Effect.catch(writeRedactionTestFailure)))
    } catch {
      // File/config/parser errors may contain source data or a secret pathname.
      // The public error deliberately reports neither the input nor the cause.
      await Effect.runPromise(writeRedactionTestFailure(undefined))
    }
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

  if (command.kind === "help" || command.kind === "version") {
    await Effect.runPromise(writeInformationalCommand(command))
    return
  }

  if ((requestsGuidedExperience(command) || command.kind === "start") && supportsInteractiveExperience()) {
    const paths = defaultNodeClientPaths()
    const controlRecovery = await createUpdateControl(paths.atapeHome).recoveryPending()
    if (captureStateContract === legacyBridgeCaptureContract && !controlRecovery && !await createUpdateControl(paths.atapeHome).readSelection()) {
      await assertRuntimeDataAdmission(runtimeContext(paths.atapeHome))
      await Effect.runPromise(prepareManualStateUpgrade(paths))
    }
    if (await needsUpdateRecovery(paths)) {
      const release = await acquireUpdateWorker(paths.atapeHome)
      if (release) {
        try { await recoverPendingUpdate(paths, await selectedBootstrap(paths.atapeHome, process.env.ATAPE_BOOTSTRAP_ENTRY ?? process.argv[1]!), process.env) }
        finally { release() }
        const delegated = await delegateManagedRuntime(process.argv[1]!, process.argv.slice(2), { ...process.env, ATAPE_RUNTIME_DIRECT: "" })
        if (delegated !== undefined) { process.exitCode = delegated; return }
      }
    }
    await assertRuntimeDataAdmission(runtimeContext(paths.atapeHome))
    if (captureStateContract === legacyBridgeCaptureContract) await Effect.runPromise(prepareManualStateUpgrade(paths))
    if (command.kind === "interactive") {
      const { runInteractiveExperience } = await import("./interactive/run.ts")
      await runInteractiveExperience(command)
      return
    }
  }
  if (requestsGuidedExperience(command)) {
    process.stderr.write(`${t("cli.error.interactiveUnsupported", "ATape needs an interactive macOS or Linux terminal. Run atape there to manage projects, tools and settings. Use atape --help for launch options.")}\n`)
    process.exitCode = 2
    return
  }

  const cancellation = new AbortController()
  const wakeDeadline = command.kind === "__update-wake" ? setTimeout(() => cancellation.abort(), 600_000) : undefined
  const stop = () => cancellation.abort()
  if (command.kind === "start") { process.on("SIGINT", stop); process.on("SIGTERM", stop) }
  else { process.once("SIGINT", stop); process.once("SIGTERM", stop) }
  try {
    if (command.kind === "start") {
      await Effect.runPromise(withTerminalState(Effect.scoped(startAgentSession({ ...command.options, cwd: process.cwd() }).pipe(
        Effect.flatMap(writeStartResult), Effect.provide(makeNodeClientLayer(defaultNodeClientPaths(), process.env))
      ))), { signal: cancellation.signal })
      return
    }
    if (command.kind === "__update-wake") {
      const admitted = await admitUpdateWake(defaultNodeClientPaths(), command.options.wakeToken, process.argv[1]!, process.env)
      if (admitted === undefined) return
      const paths = defaultNodeClientPaths(admitted)
      for (let attempt = 0; attempt < 3; attempt++) {
        const delegated = await delegateAdmittedUpdateWake(process.argv[1]!, process.argv.slice(2), admitted, cancellation.signal)
        if (delegated !== undefined) { process.exitCode = delegated; return }
        const release = await acquireUpdateWorker(paths.atapeHome)
        if (!release) return // The active owner, or the next hourly wake, finishes the work.
        let selectedElsewhere = false, recoveryOnly = false
        try {
          // Recovery is joined even after preference-off. A queued invocation
          // must never abandon an earlier maintenance gate or migration fence.
          await recoverPendingUpdate(paths, admitted.ATAPE_BOOTSTRAP_ENTRY!, admitted)
          const selectedEntry = await resolveRuntimeEntry(paths.atapeHome, admitted.ATAPE_BOOTSTRAP_ENTRY!)
          if (await realpath(selectedEntry) !== await realpath(process.argv[1]!) &&
            selectedEntry !== admitted.ATAPE_BOOTSTRAP_ENTRY) {
            selectedElsewhere = true
          } else {
            const current = await admitUpdateWake(paths, command.options.wakeToken, process.argv[1]!, admitted)
            if (!current) return
            recoveryOnly = current.ATAPE_UPDATE_WAKE_RECOVERY_ONLY === "1"
            if (!recoveryOnly) {
              await assertRuntimeDataAdmission(runtimeContext(paths.atapeHome))
              await Effect.runPromise(runAutomaticUpdates(cliVersion).pipe(
                Effect.provide(makeNodeClientLayer(paths, current))), { signal: cancellation.signal })
            }
            selectedElsewhere = await resolveRuntimeEntry(paths.atapeHome, current.ATAPE_BOOTSTRAP_ENTRY!) !== selectedEntry
          }
        } finally { release() }
        // Never wait for a delegated child while holding its update ownership.
        if (selectedElsewhere) continue
        await Effect.runPromise(recoveryOnly
          ? UpdateWakePlatform.use(platform => platform.reconcile(false)).pipe(
            Effect.provide(makeUpdateWakePlatformLayer(paths, admitted.ATAPE_BOOTSTRAP_ENTRY!, admitted)))
          : reconcileUpdateWake().pipe(Effect.provide(makeNodeClientLayer(paths, admitted))), { signal: cancellation.signal })
        return
      }
      throw new Error("Update runtime selection changed repeatedly. The next scheduled wake will retry.")
    }
    if (command.kind === "__login-start") {
      const admitted = await admitLoginStartup(defaultNodeClientPaths(), command.options.startupToken, process.argv[1]!, process.env)
      if (admitted === undefined) return
      const paths = defaultNodeClientPaths(admitted)
      const delegated = await delegateAdmittedLoginStartup(process.argv[1]!, process.argv.slice(2), admitted)
      if (delegated !== undefined) { process.exitCode = delegated; return }
      for (let attempt = 0; attempt < 3; attempt++) {
        let completed = false, delegateAfterRecovery = false
        await withLoginStartupRecovery(paths, admitted.ATAPE_BOOTSTRAP_ENTRY!, admitted, async () => {
          const selection = await readEffectiveRuntimeSelection(paths.atapeHome)
          if (selection) {
            const entry = await resolveRuntimeEntry(paths.atapeHome, admitted.ATAPE_BOOTSTRAP_ENTRY!)
            if (await realpath(entry) !== await realpath(process.argv[1]!)) { delegateAfterRecovery = true; return }
          }
          await assertRuntimeDataAdmission(runtimeContext(paths.atapeHome))
          await Effect.runPromise(assertManualStateUpgradeReady(paths))
          const current = await admitLoginStartup(paths, command.options.startupToken, process.argv[1]!, admitted)
          if (current === undefined) return
          await Effect.runPromise(runLoginStartup().pipe(Effect.provide(makeNodeClientLayer(defaultNodeClientPaths(current), current))), { signal: cancellation.signal })
          completed = true
        })
        // Never join a selected child while holding its update ownership. The
        // child re-admits the registration and recovers under that same lock.
        if (delegateAfterRecovery) {
          const selected = await delegateAdmittedLoginStartup(process.argv[1]!, process.argv.slice(2), admitted)
          if (selected !== undefined) { process.exitCode = selected; return }
          continue
        }
        if (completed) await Effect.runPromise(kickAutomaticUpdates().pipe(Effect.provide(makeNodeClientLayer(paths, admitted))), { signal: cancellation.signal })
        return
      }
      throw new Error("ATape runtime selection changed repeatedly during login recovery. Login startup will retry.")
    }
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
          // The copied old worker may repair control state, but must not begin
          // another capture-dependent update using the selected runtime's name.
          yield* Effect.tryPromise({ try: () => assertRuntimeDataAdmission(runtimeContext(paths.atapeHome)),
            catch: cause => cause instanceof Error ? cause : new Error(String(cause)) })
          const current = (yield* Effect.tryPromise({ try: () => readEffectiveRuntimeSelection(paths.atapeHome), catch: cause => new Error(String(cause)) }))?.version ?? cliVersion
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
        yield* Effect.tryPromise({
          try: () => assertRuntimeDataAdmission(runtimeContext(defaultNodeClientPaths().atapeHome)),
          catch: cause => cause instanceof Error ? cause : new Error(String(cause))
        })
        if (captureStateContract === legacyBridgeCaptureContract) yield* recordV2CollectorAdmission(defaultNodeClientPaths(), command.options.daemonToken)
        yield* Effect.forkScoped(Effect.forever(reconcileLoginStartup().pipe(
          Effect.catch(() => Effect.logWarning("Login startup registration needs attention; inspect Settings")),
          Effect.andThen(Effect.sleep(300_000))
        )))
        yield* Effect.forkScoped(Effect.forever(reconcileUpdateWake().pipe(
          Effect.catch(() => Effect.logWarning("Automatic update wakeup needs attention; inspect Settings")),
          Effect.andThen(Effect.sleep(300_000))
        )))
        yield* Effect.forkScoped(Effect.forever(kickAutomaticUpdates().pipe(Effect.andThen(Effect.sleep(30_000)))))
        yield* prepareCollectorReadiness(defaultNodeClientPaths(), process.env)
        yield* runCommand(command)
      }))
      : runCommand(command)
    await Effect.runPromise(
      program.pipe(
        Effect.provide(makeNodeClientLayer(defaultNodeClientPaths(), process.env, globalThis.fetch, globalThis.fetch,
          command.kind === "__collector-daemon" ? { collectorToken: command.options.daemonToken } : {})),
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
    if (command.kind === "start") process.exitCode = 130
  } finally {
    if (wakeDeadline) clearTimeout(wakeDeadline)
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
  }
}

main().catch((cause) => {
  process.stderr.write(`${t("cli.error.unexpected", "ATape failed unexpectedly: {message}", { message: cause instanceof Error ? cause.message : String(cause) })}\n`)
  process.exitCode = 1
})
