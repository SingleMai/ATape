import { CLIExperienceError, CLISetupPlatform, type DirectorySuggestion } from "@atape/application"
import { AdapterManifest, GitAttributionVersion } from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, mkdir, open, opendir, readFile, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import type { NodeClientPaths } from "./clientLayers.ts"

export const makeCLISetupPlatformLayer = (paths: NodeClientPaths, environment = process.env) => Layer.succeed(
  CLISetupPlatform, CLISetupPlatform.of({
    detectSources: () => localIO(async () => {
      const candidates = [
        ["codex", environment.ATAPE_CODEX_HOME || environment.CODEX_HOME || join(homedir(), ".codex")],
        ["claude", environment.ATAPE_CLAUDE_HOME || join(homedir(), ".claude")]
      ] as const
      const detected: string[] = []
      for (const [id, path] of candidates) {
        try { if ((await stat(path)).isDirectory()) detected.push(id) }
        catch (cause) { if (!hasCode(cause, "ENOENT")) throw cause }
      }
      return detected
    }),
    suggestDirectories: input => localIO(async signal => {
      const expanded = input === "~" || input.startsWith(`~${sep}`) ? homedir() + input.slice(1) : input
      const path = resolve(expanded || ".")
      const browsing = input.endsWith(sep) || input === "" || (await stat(path).catch(() => undefined))?.isDirectory()
      const parent = browsing ? path : dirname(path)
      const prefix = browsing ? "" : basename(path)
      const choices: DirectorySuggestion[] = []
      if (browsing && dirname(path) !== path) {
        const ancestor = dirname(path)
        const git = await stat(join(ancestor, ".git")).catch(() => undefined)
        choices.push({ path: ancestor + sep, git: Boolean(git?.isDirectory() || git?.isFile()), parent: true })
      }
      let count = 0
      const directory = await opendir(parent)
      for await (const entry of directory) {
        signal.throwIfAborted()
        if (++count > 2_000) break
        if (entry.name.startsWith(prefix) && (prefix.startsWith(".") || !entry.name.startsWith(".")) &&
          (entry.isDirectory() || entry.isSymbolicLink() && (await stat(join(parent, entry.name)).catch(() => undefined))?.isDirectory())) {
          const candidate = join(parent, entry.name)
          const git = await stat(join(candidate, ".git")).catch(() => undefined)
          choices.push({ path: candidate + sep, git: Boolean(git?.isDirectory() || git?.isFile()) })
          if (choices.length >= 30) break
        }
      }
      return choices.sort((a, b) => Number(Boolean(b.parent)) - Number(Boolean(a.parent)) || a.path.localeCompare(b.path))
    }),
    supportsGit: adapter => localIO(async () => {
      const manifestPath = join(paths.adapterDirectory, "node_modules", ...adapter.packageName.split("/"), "package.json")
      const details = await stat(manifestPath)
      if (details.size > 256 * 1024) throw new Error("Package manifest too large")
      const packageJSON = JSON.parse(await readFile(manifestPath, "utf8"))
      const manifest = Schema.decodeUnknownSync(AdapterManifest)(packageJSON.atapeAdapter)
      return packageJSON.name === adapter.packageName && packageJSON.version === adapter.version &&
        manifest.adapterId === adapter.adapterId && manifest.gitAttribution === GitAttributionVersion
    }),
    creationKey: scope => localIO(async () => {
      const directory = join(dirname(paths.configFile), "setup-requests")
      const target = join(directory, createHash("sha256").update(JSON.stringify(scope)).digest("hex"))
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = join(directory, `.${randomUUID()}.tmp`)
      try {
        const file = await open(temporary, "wx", 0o600)
        try { await file.writeFile(randomUUID()); await file.sync() } finally { await file.close() }
        try { await link(temporary, target) } catch (cause) { if (!hasCode(cause, "EEXIST")) throw cause }
        const parent = await open(directory, constants.O_RDONLY)
        try { await parent.sync() } finally { await parent.close() }
        const established = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const info = await established.stat()
          if (!info.isFile() || info.size !== 36) throw new Error("Invalid setup request key")
          const bytes = Buffer.alloc(37)
          const { bytesRead } = await established.read(bytes, 0, bytes.length, 0)
          const key = bytes.subarray(0, bytesRead).toString("utf8")
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key)) throw new Error("Invalid setup request key")
          return key
        } finally { await established.close() }
      } finally { await rm(temporary, { force: true }) }
    })
  })
)
const hasCode = (cause: unknown, code: string) => cause instanceof Error && "code" in cause && cause.code === code
const localIO = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({
  try: run,
  catch: () => new CLIExperienceError({ reason: "io", message: "Could not inspect local setup data. Check that the directory exists and is readable, then retry." })
})
