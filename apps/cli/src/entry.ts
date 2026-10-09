#!/usr/bin/env node

import { delegateManagedRuntime } from "./runtime/runtimeLauncher.ts"
import { parseCLI } from "./commandInput.ts"
import { Effect } from "effect"
import { supportsInteractiveExperience } from "./interactiveEligibility.ts"
import { defaultNodeClientPaths } from "./runtime/clientPaths.ts"
import { prepareManualStateUpgrade } from "./runtime/manualStateUpgrade.ts"
import { createUpdateControl } from "./runtime/updateControl.ts"

// Preserve the public parser's plain exit-2 response before reading selection
// state. Invalid input never enters bootstrap recovery or update dispatch.
let valid = true
try { parseCLI(process.argv.slice(2)) } catch { valid = false }
try {
  if (valid && parseCLI(process.argv.slice(2)).kind === "interactive" && supportsInteractiveExperience()) {
    const paths = defaultNodeClientPaths()
    // An interrupted capable handoff must recover before the legacy manual
    // transition checks a stopped Collector or its temporary maintenance gate.
    if (!await createUpdateControl(paths.atapeHome).recoveryPending()) await Effect.runPromise(prepareManualStateUpgrade(paths))
  }
  const delegated = valid ? await delegateManagedRuntime(process.argv[1] ?? "", process.argv.slice(2)) : undefined
  if (delegated === undefined) await import("./main.ts")
  else process.exitCode = delegated
} catch (cause) {
  process.stderr.write(`ATape: ${cause instanceof Error ? cause.message : String(cause)}\n`)
  process.exitCode = 1
}
