import { spawn } from "node:child_process"
import { realpath } from "node:fs/promises"
import { constants } from "node:os"
import { dirname, join } from "node:path"
import { Schema } from "effect"
import { parseCLI } from "../commandInput.ts"
import { supportsInteractiveExperience } from "../interactiveEligibility.ts"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import { decodeLegacyRuntimeSelection, missing, readBoundedJSON, readRuntimeSelection, resolveRuntimeEntry, runtimeSelectionFile } from "./runtimeSelection.ts"

// The npm executable remains a stable bootstrap. This Composition Root helper
// delegates only validated public launches, before constructing the old runtime.
export const delegateManagedRuntime = async (
  entryFile: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env
): Promise<number | undefined> => {
  const command = parseCLI(args)
  if (environment.ATAPE_RUNTIME_DIRECT === "1" ||
    command.kind !== "interactive" && command.kind !== "help" && command.kind !== "version" ||
    command.kind === "interactive" && !supportsInteractiveExperience(environment)) return undefined
  const home = defaultNodeClientPaths(environment).atapeHome
  if (command.kind === "help" || command.kind === "version") {
    try {
      const value = await readBoundedJSON(runtimeSelectionFile(home))
      if (typeof value === "object" && value !== null && "stateContract" in value && value.stateContract === "atape.client.v3-capture.v1") {
        decodeLegacyRuntimeSelection(value)
        return undefined
      }
    } catch (cause) { if (!missing(cause)) throw cause }
  }
  const selected = await readRuntimeSelection(home)
  if (!selected) return undefined
  const entry = await resolveRuntimeEntry(home, selected.bootstrapEntry)
  if (entry === await realpath(entryFile)) return undefined

  return delegate(entry, args, { ...environment, ATAPE_BOOTSTRAP_ENTRY: selected.bootstrapEntry })
}

// This entry is called after private registration admission, before acquiring
// update ownership. The selected child then recovers and rechecks admission
// under that ownership. Never hold the parent's lock while joining this child.
export const delegateAdmittedLoginStartup = async (
  entryFile: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv
): Promise<number | undefined> => {
  if (parseCLI(args).kind !== "__login-start") throw new Error("Expected the admitted login startup entry.")
  const home = defaultNodeClientPaths(environment).atapeHome
  const selected = await readRuntimeSelection(home)
  if (!selected) return undefined
  const entry = await resolveRuntimeEntry(home, selected.bootstrapEntry)
  if (entry === await realpath(entryFile)) return undefined
  const capability = Schema.decodeUnknownSync(Schema.Struct({
    name: Schema.Literal("@atape/cli"),
    atapeRuntime: Schema.optionalKey(Schema.Struct({ loginStartupProtocol: Schema.optionalKey(Schema.String) }))
  }))(await readBoundedJSON(join(dirname(dirname(entry)), "package.json")))
  if (capability.atapeRuntime?.loginStartupProtocol !== "atape.login-startup.v1") return undefined
  return delegate(entry, args, { ...environment, ATAPE_BOOTSTRAP_ENTRY: selected.bootstrapEntry })
}

const delegate = (entry: string, args: ReadonlyArray<string>, environment: NodeJS.ProcessEnv) => {

  // Relinquish input while the parent waits for the selected executable. The
  // child inherits cwd/stdin/stdout/stderr and owns normal terminal interaction.
  process.stdin.pause()
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: "inherit",
      env: environment })
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
    const handlers = signals.map(signal => {
      const forward = () => { child.kill(signal) }
      process.on(signal, forward)
      return { signal, forward }
    })
    const cleanup = () => {
      for (const { signal, forward } of handlers) process.removeListener(signal, forward)
    }
    child.once("error", cause => { cleanup(); reject(cause) })
    child.once("exit", (code, signal) => {
      cleanup()
      resolve(code ?? (signal ? 128 + constants.signals[signal] : 1))
    })
  })
}
