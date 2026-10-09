import { latestPublishedVersion } from "./publishedVersions.ts"
import { CLIUpgradeError, CLIUpgradePlatform, isNewerReleaseVersion, isStableReleaseVersion } from "@atape/application"
import { Effect, Layer, Schema } from "effect"
import { executeOwnedProcess as execute } from "./ownedProcess.ts"
import { readFile, realpath, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import { preserveSelectedInstallations } from "./runtimeSelection.ts"
import { acquireUpdateWorker } from "./updateOwnership.ts"
import { acquireProcessLock } from "./processLock.ts"

const registry = "https://registry.npmjs.org/"
const Manifest = Schema.Struct({ name: Schema.Literal("@atape/cli"), version: Schema.String })
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
  acquireOwnership: () => Effect.acquireRelease(Effect.tryPromise({
    try: async () => {
      const release = await acquireUpdateWorker(home)
      if (!release) throw new CLIUpgradeError({ reason: "installation",
        message: "Another ATape update is running. Wait for it to finish, then retry in Tools and updates." })
      return release
    },
    catch: cause => cause instanceof CLIUpgradeError ? cause : new CLIUpgradeError({ reason: "installation",
      message: "Could not acquire ATape update ownership. Check local update state and installation permissions." })
  }), release => Effect.sync(release)).pipe(Effect.asVoid),
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
      if (!isStableReleaseVersion(version)) throw new CLIUpgradeError({ reason: "install", message: "Invalid ATape release version." })
      const run = (args: string[]) => execute("npm", args, environment, signal, 180_000)
      const current = await realpath(resolve(entry))
      const prefix = (await run(["prefix", "--global"])).trim()
      const root = (await run(["root", "--global", "--prefix", prefix])).trim()
      const installedEntry = join(root, "@atape", "cli", "dist", "atape.js")
      if (await realpath(installedEntry).catch(() => undefined) !== current) {
        throw new CLIUpgradeError({ reason: "installation",
          message: "This ATape is not the active npm global installation. Update it with the package manager or path used to install it." })
      }
      const release = await acquireProcessLock(join(root, ".atape-upgrade.lock.sqlite")).catch(() => {
        throw new CLIUpgradeError({ reason: "installation", message: "Cannot lock this installation. Check write permissions and whether another upgrade is running." })
      })
      if (!release) throw new CLIUpgradeError({ reason: "installation", message: "Another ATape update owns this npm installation. Wait for it to finish, then retry." })
      try {
        const actual = Schema.decodeUnknownSync(Manifest)(await readBounded(join(dirname(dirname(current)), "package.json")))
        if (!isStableReleaseVersion(actual.version)) throw new CLIUpgradeError({ reason: "installation",
          message: "The installed ATape version is not a stable release. Update it with the package manager used to install it." })
        if (isNewerReleaseVersion(actual.version, version)) throw new CLIUpgradeError({ reason: "installation",
          message: `ATape ${actual.version} is already installed. Check versions again before applying an older release.` })
        await preserveSelectedInstallations(defaultNodeClientPaths({ ...environment, ATAPE_HOME: home }))
        await run(["install", "--global", "--prefix", prefix, `@atape/cli@${version}`, "--ignore-scripts", "--engine-strict", "--no-audit", "--no-fund", "--registry", registry,
          `--@atape:registry=${registry}`])
        const verified = await execute(process.execPath, [installedEntry, "--version"], environment, signal, 15_000)
        if (verified.trim() !== `ATape ${version}`) throw new Error("Installed version mismatch")
      } finally { release() }
    })()
    task.then(() => resume(Effect.void), cause => resume(Effect.fail(cause instanceof CLIUpgradeError ? cause : new CLIUpgradeError({ reason: "install",
      message: "ATape could not be upgraded. Check your connection and installation permissions, then retry in Tools and updates." }))))
    // Effect interruption waits for process termination and lock cleanup.
    return Effect.promise(async () => { cancellation.abort(); await task.catch(() => {}) })
  })
}))
