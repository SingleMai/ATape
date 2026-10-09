// Installed-package acceptance binding. Native commands are controlled at the
// external manager Seam; the shipped filesystem and Application Interfaces run.
import {
  CLICredentialStore,
  CollectorDaemonProcess,
  inspectLoginStartup,
  reconcileLoginStartup,
  setLoginStartup,
  startManagedCollector,
  stopManagedCollector
} from "@atape/application"
import { appendFile, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { makeCredentialStoreLayer } from "../authenticationLayers.ts"
import { defaultNodeClientPaths } from "../clientPaths.ts"
import { makeNodeCollectorDaemonLayer } from "../collectorDaemonLayers.ts"
import { makeLoginStartupPlatformLayer } from "../loginStartup.ts"
import { executeOwnedProcess } from "../ownedProcess.ts"
import { makeSelectedConfigStoreLayer, resolveRuntimeEntry } from "../runtimeSelection.ts"

const root = process.env.LOGIN_FIXTURE_ROOT
const bootstrap = process.env.ATAPE_BOOTSTRAP_ENTRY
const modules = process.env.LOGIN_FIXTURE_GLOBAL_ROOT
const userHome = process.env.HOME
if (!root || !bootstrap || !modules || !userHome || !process.env.ATAPE_HOME?.startsWith(`${root}/`)) {
  throw new Error("An isolated login startup package fixture is required.")
}
const paths = defaultNodeClientPaths()
const native = process.argv[3] === "--native"
if (native && !["register", "disable", "inspect"].includes(process.argv[2] ?? "")) {
  throw new Error("Opt-in native acceptance only registers, inspects and unregisters an empty configured client.")
}
const managerStateFile = join(root, "controlled-manager.json")
const execute: typeof executeOwnedProcess = async (file, args, _environment, signal, timeout) => {
  if (signal.aborted || timeout > 10_000) throw new Error("Invalid controlled manager lifetime")
  await appendFile(join(root, "native-commands.jsonl"), `${JSON.stringify({ file, args })}\n`)
  if (file === "npm" && args.join(" ") === "root --global") return `${modules}\n`
  const state = JSON.parse(await readFile(managerStateFile, "utf8")) as { registered: boolean }
  const unavailable = () => Object.assign(new Error("Controlled service is absent"), { code: 1 })
  if (file === "/bin/launchctl") {
    if (args[0] === "print" && args[1]?.split("/").length === 2) return "Controlled GUI domain"
    if (args[0] === "print") { if (!state.registered) throw unavailable(); return "Controlled login service" }
    if (args[0] === "enable") return ""
    if (args[0] === "bootstrap") state.registered = true
    else if (args[0] === "bootout") state.registered = false
    else throw new Error("Unexpected controlled launchctl operation")
  } else if (file === "systemctl") {
    if (args.includes("show-environment") || args.includes("daemon-reload") || args.includes("start")) return ""
    if (args.includes("is-enabled")) { if (!state.registered) throw unavailable(); return "enabled\n" }
    if (args.includes("enable")) state.registered = true
    else if (args.includes("disable")) state.registered = false
    else throw new Error("Unexpected controlled systemctl operation")
  } else throw new Error(`Unexpected external command in login startup acceptance: ${file}`)
  await writeFile(managerStateFile, JSON.stringify(state))
  return ""
}
const layer = Layer.mergeAll(
  makeSelectedConfigStoreLayer(paths),
  makeNodeCollectorDaemonLayer(paths, () => resolveRuntimeEntry(paths.atapeHome, bootstrap), process.env),
  makeCredentialStoreLayer(paths.atapeHome, paths.credentialDirectory),
  makeLoginStartupPlatformLayer(paths, bootstrap, process.env, { homeDirectory: userHome, execute: native ? executeOwnedProcess : execute })
)
const result = await Effect.runPromise(Effect.gen(function*() {
  switch (process.argv[2]) {
    case "register": return yield* reconcileLoginStartup()
    case "enable": return yield* setLoginStartup(true)
    case "disable": return yield* setLoginStartup(false)
    case "inspect": return yield* inspectLoginStartup()
    case "start": return yield* startManagedCollector({ intervalMs: 23_000, concurrency: 2 })
    case "pause": return yield* CollectorDaemonProcess.use(process => process.pause())
    case "stop": return yield* stopManagedCollector()
    case "credential": {
      const origin = process.env.LOGIN_FIXTURE_ORIGIN
      if (!origin) throw new Error("A local fixture origin is required")
      yield* CLICredentialStore.use(store => store.replace({ credential: {
        version: 1, instanceOrigin: origin, apiOrigin: origin,
        credential: "atc_v1_login-startup-fixture", credentialId: "login-startup-credential",
        capabilityVersion: "atape-cli.v1", createdAt: "2026-10-09T00:00:00Z",
        user: { id: "login-startup-user", displayName: "Login Startup Fixture" }
      } }))
      return { saved: true }
    }
    default: throw new Error("Unknown login startup fixture operation")
  }
}).pipe(Effect.provide(layer)))
process.stdout.write(`${JSON.stringify(result)}\n`)
