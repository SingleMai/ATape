import { latestPublishedVersion } from "./publishedVersions.ts"
import { CLIUpgradeError, CLIUpgradePlatform } from "@atape/application"
import { Effect, Layer, Schema } from "effect"
import { executeOwnedProcess as execute } from "./ownedProcess.ts"
import { open, readFile, realpath, rm, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

const registry = "https://registry.npmjs.org/"
const Manifest = Schema.Struct({ name: Schema.Literal("@atape/cli"), version: Schema.String })
const validVersion = (value: string) => /^\d+\.\d+\.\d+$/.test(value) && value.length < 40
const readBounded = async (file: string) => {
  if ((await stat(file)).size > 256 * 1024) throw new Error("Metadata too large")
  return JSON.parse(await readFile(file, "utf8"))
}

export const makeCLIUpgradePlatformLayer = (
  home: string,
  entry: string,
  environment: NodeJS.ProcessEnv = process.env,
  fetchMetadata: typeof globalThis.fetch = globalThis.fetch
) => Layer.succeed(CLIUpgradePlatform, CLIUpgradePlatform.of({
  latest: cached => Effect.tryPromise({
    try: async signal => {
      return latestPublishedVersion(home, "@atape/cli", cached, signal, fetchMetadata)
    },
    catch: () => new CLIUpgradeError({ reason: "check", message: "Could not check for updates. Check your connection and try the update again in Tools and updates." })
  }),
  install: version => Effect.callback<void, CLIUpgradeError>(resume => {
    const cancellation = new AbortController()
    const signal = cancellation.signal
    const task = (async () => {
      if (!validVersion(version)) throw new CLIUpgradeError({ reason: "install", message: "Invalid ATape release version." })
      const run = (args: string[]) => execute("npm", args, environment, signal, 180_000)
      const current = await realpath(resolve(entry))
      const prefix = (await run(["prefix", "--global"])).trim()
      const root = (await run(["root", "--global", "--prefix", prefix])).trim()
      const installedEntry = join(root, "@atape", "cli", "dist", "atape.js")
      if (await realpath(installedEntry).catch(() => undefined) !== current) {
        throw new CLIUpgradeError({ reason: "installation",
          message: "This ATape is not the active npm global installation. Update it with the package manager or path used to install it." })
      }
      Schema.decodeUnknownSync(Manifest)(await readBounded(join(dirname(dirname(current)), "package.json")))
      const lockPath = join(root, ".atape-upgrade.lock")
      const lock = await open(lockPath, "wx", 0o600).catch(() => {
        throw new CLIUpgradeError({ reason: "installation", message: "Cannot lock this installation. Check write permissions and whether another upgrade is running." })
      })
      try {
        await run(["install", "--global", "--prefix", prefix, `@atape/cli@${version}`, "--ignore-scripts", "--engine-strict", "--no-audit", "--no-fund", "--registry", registry])
        const verified = await execute(process.execPath, [installedEntry, "--version"], environment, signal, 15_000)
        if (verified.trim() !== `ATape ${version}`) throw new Error("Installed version mismatch")
      } finally { await lock.close(); await rm(lockPath, { force: true }) }
    })()
    task.then(() => resume(Effect.void), cause => resume(Effect.fail(cause instanceof CLIUpgradeError ? cause : new CLIUpgradeError({ reason: "install",
      message: "ATape could not be upgraded. Check your connection and installation permissions, then retry in Tools and updates." }))))
    // Effect interruption waits for process termination and lock cleanup.
    return Effect.promise(async () => { cancellation.abort(); await task.catch(() => {}) })
  })
}))
