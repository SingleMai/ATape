import { CLIUpgradeError, CLIUpgradePlatform } from "@atape/application"
import { Effect, Layer, Schema } from "effect"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

// Abort requests termination; only process completion settles the operation.
// In particular, AbortError must not release the installation lock early.
const execute = (file: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, timeout: number) =>
  new Promise<string>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    let stopped: Error | undefined
    let force: ReturnType<typeof setTimeout> | undefined
    const child = execFile(file, args, { env, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      clearTimeout(deadline)
      clearTimeout(force)
      signal.removeEventListener("abort", abort)
      if (stopped || error) reject(stopped ?? error)
      else resolve(stdout)
    })
    const stop = (reason: Error) => {
      if (stopped) return
      stopped = reason
      child.kill("SIGTERM")
      force = setTimeout(() => child.kill("SIGKILL"), 1_000)
    }
    const abort = () => stop(new Error("Upgrade cancelled"))
    const deadline = setTimeout(() => stop(new Error("Upgrade process timed out")), timeout)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
const registry = "https://registry.npmjs.org/"
const Cache = Schema.Struct({ checkedAt: Schema.Number, version: Schema.String })
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
      const file = join(home, "cache", "cli-update.json")
      if (cached) {
        const saved = await readBounded(file).then(value => Schema.decodeUnknownSync(Cache)(value)).catch(() => undefined)
        const age = saved ? Date.now() - saved.checkedAt : -1
        if (saved && validVersion(saved.version) && age >= 0 && age < 12 * 60 * 60 * 1_000) return saved.version
      }
      const response = await fetchMetadata(`${registry}@atape%2fcli/latest`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(cached ? 1_500 : 10_000)]),
        redirect: "error", headers: { accept: "application/json" }
      })
      if (!response.ok || !response.body) throw new Error("Registry unavailable")
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 256 * 1024) throw new Error("Metadata too large")
          chunks.push(chunk.value)
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      const manifest = Schema.decodeUnknownSync(Manifest)(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      if (!validVersion(manifest.version)) throw new Error("Invalid stable version")
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 })
        await writeFile(temporary, JSON.stringify({ checkedAt: Date.now(), version: manifest.version }), { mode: 0o600 })
        await rename(temporary, file)
      } catch { /* An unwritable cache must not hide an available upgrade. */ }
      finally { await rm(temporary, { force: true }).catch(() => {}) }
      return manifest.version
    },
    catch: () => new CLIUpgradeError({ reason: "check", message: "Could not check for updates. Check your connection and try atape upgrade again." })
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
      message: "ATape could not be upgraded. Check your connection and installation permissions, then retry atape upgrade." }))))
    // Effect interruption waits for process termination and lock cleanup.
    return Effect.promise(async () => { cancellation.abort(); await task.catch(() => {}) })
  })
}))
