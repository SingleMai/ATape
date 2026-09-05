import {
  ClientMigration,
  ClientMigrationError,
  type ClientMigrationPlan,
  type LegacyMigrationSource
} from "@atape/application"
import {
  CollectorRawObjectProgress,
  emptyClientConfig
} from "@atape/domain"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import type { Stats } from "node:fs"
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat
} from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Effect, Layer, Schema } from "effect"

const LegacyCheckpoint = Schema.Struct({
  projectId: Schema.String,
  projectCreatedAt: Schema.String,
  adapterId: Schema.String,
  adapterVersion: Schema.String,
  revision: Schema.Number,
  cursor: Schema.NullOr(Schema.String),
  rawObjects: Schema.Array(CollectorRawObjectProgress),
  updatedAt: Schema.String
})
const LegacyCollectorState = Schema.Struct({
  version: Schema.Literal(1),
  installationId: Schema.String,
  checkpoints: Schema.Array(LegacyCheckpoint)
})

export type LegacyClientPaths = {
  readonly configFile: string
  readonly collectorStateFile: string
  readonly collectorProcessFile: string
  readonly collectorStatusFile: string
  readonly collectorLogFile: string
  readonly adapterDirectory: string
}

export type ClientMigrationPaths = {
  readonly atapeHome: string
  readonly configFile: string
  readonly legacy: LegacyClientPaths
}

export const makeClientMigrationLayer = (paths: ClientMigrationPaths) => Layer.succeed(
  ClientMigration,
  ClientMigration.of({
    plan: () => migrationPlan(paths),
    apply: () => Effect.gen(function*() {
      const plan = yield* migrationPlan(paths)
      if (plan.sources.length === 0) {
        return yield* migrationError("not_found", "No v0.1 XDG data was found to migrate.")
      }
      if (!plan.canApply) {
        const reason = plan.blockers.some((blocker) => blocker.includes("Collector"))
          ? "collector_running" as const
          : "conflict" as const
        return yield* migrationError(reason, plan.blockers.join(" "))
      }
      const result = yield* Effect.tryPromise({
        try: async () => {
          await ensurePrivateDirectory(paths.atapeHome)
          const imports = join(paths.atapeHome, "imports")
          await ensurePrivateDirectory(imports)
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
          const importDirectory = join(imports, `v0.1-${timestamp}-${randomUUID().slice(0, 8)}`)
          await mkdir(importDirectory, { mode: 0o700 })
          try {
            for (const source of plan.sources) {
              const category = source.kind === "config" ? "config"
                : source.kind === "adapters" ? "data"
                : source.kind === "collector_log" ? "logs"
                : "state"
              const categoryDirectory = join(importDirectory, category)
              await mkdir(categoryDirectory, { recursive: true, mode: 0o700 })
              const destination = source.kind === "adapters"
                ? join(categoryDirectory, "adapters")
                : join(categoryDirectory, basename(source.path))
              await cp(source.path, destination, {
                recursive: source.kind === "adapters",
                dereference: false,
                verbatimSymlinks: true,
                preserveTimestamps: true,
                errorOnExist: true,
                force: false
              })
            }
            await writeInitialConfig(paths.configFile)
            await syncDirectory(imports)
            return { importDirectory }
          } catch (cause) {
            await rm(importDirectory, { recursive: true, force: true }).catch(() => undefined)
            throw cause
          }
        },
        catch: (cause) => cause instanceof UnsafeMigrationTarget
          ? migrationError("unsafe", "ATAPE_HOME has unsafe ownership, mode, or type.")
          : migrationError("io", "Could not archive the v0.1 client data safely.")
      })
      return {
        ...plan,
        applied: true as const,
        importDirectory: result.importDirectory,
        createdConfig: paths.configFile
      }
    }),
    readCheckpoint: (input) => readArchivedCheckpoint(paths.atapeHome, input)
  })
)

export const legacyDataExists = async (legacy: LegacyClientPaths): Promise<boolean> => {
  for (const path of Object.values(legacy)) {
    try {
      await lstat(path)
      return true
    } catch (cause) {
      if (!hasCode(cause, "ENOENT")) throw cause
    }
  }
  return false
}

const migrationPlan = (paths: ClientMigrationPaths): Effect.Effect<ClientMigrationPlan, ClientMigrationError> =>
  Effect.tryPromise({
    try: async () => {
      const candidates: ReadonlyArray<LegacyMigrationSource> = [
        { kind: "config", path: paths.legacy.configFile },
        { kind: "collector_state", path: paths.legacy.collectorStateFile },
        { kind: "collector_process", path: paths.legacy.collectorProcessFile },
        { kind: "collector_status", path: paths.legacy.collectorStatusFile },
        { kind: "collector_log", path: paths.legacy.collectorLogFile },
        { kind: "adapters", path: paths.legacy.adapterDirectory }
      ]
      const sources: Array<LegacyMigrationSource> = []
      for (const candidate of candidates) {
        try {
          await lstat(candidate.path)
          sources.push(candidate)
        } catch (cause) {
          if (!hasCode(cause, "ENOENT")) throw cause
        }
      }
      const blockers: Array<string> = []
      if (await exists(paths.configFile)) {
        blockers.push("The v0.2 client configuration already exists; migration will not overwrite it.")
      }
      if (await legacyCollectorMayBeRunning(paths.legacy.collectorProcessFile)) {
        blockers.push("The v0.1 Collector may still be running; stop it before migration.")
      }
      if (sources.length === 0) blockers.push("No v0.1 XDG data was found.")
      return {
        version: "atape.local-migration.v1" as const,
        destinationRoot: paths.atapeHome,
        sources,
        canApply: blockers.length === 0,
        blockers,
        discardedAuthority: [
          "v0.1 serverUrl and userId fields",
          "v0.1 Team and Project authority fields",
          "v0.1 Collector checkpoint scope"
        ],
        unresolved: [
          "Run `atape login` for each Instance.",
          "Run `atape setup` to confirm each local directory against server-visible Projects.",
          "Reinstall and explicitly enable required Adapters.",
          "Adopt any archived checkpoint only with the explicit checkpoint adoption command."
        ]
      } satisfies ClientMigrationPlan
    },
    catch: () => migrationError("io", "Could not inspect the v0.1 client data.")
  })

const legacyCollectorMayBeRunning = async (processFile: string): Promise<boolean> => {
  let value: unknown
  try {
    const metadata = await lstat(processFile)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) return true
    value = JSON.parse(await readFile(processFile, "utf8")) as unknown
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return false
    return true
  }
  if (typeof value !== "object" || value === null || !("pid" in value) ||
    typeof (value as { pid?: unknown }).pid !== "number") return true
  const pid = (value as { pid: number }).pid
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return !hasCode(cause, "ESRCH")
  }
}

const writeInitialConfig = async (configFile: string) => {
  await ensurePrivateDirectory(dirname(configFile))
  if (await exists(configFile)) throw new Error("target config exists")
  const temporary = join(dirname(configFile), `.${randomUUID()}.client.tmp`)
  let handle
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o600
    )
    await handle.writeFile(`${JSON.stringify(emptyClientConfig(), null, 2)}\n`, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, configFile)
    await syncDirectory(dirname(configFile))
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

const readArchivedCheckpoint = (
  atapeHome: string,
  input: { readonly importId: string; readonly projectId: string; readonly adapterId: string }
) => Effect.gen(function*() {
  if (!/^v0\.1-[0-9TZ-]+-[0-9a-f]{8}$/.test(input.importId)) {
    return yield* migrationError("unsafe", "The migration import ID is invalid.")
  }
  const imports = join(atapeHome, "imports")
  const imported = join(imports, input.importId)
  const stateFile = join(imported, "state", "collector.json")
  const bytes = yield* Effect.tryPromise({
    try: async () => {
      await assertPrivateDirectory(imports)
      await assertPrivateDirectory(imported)
      const metadata = await lstat(stateFile)
      if (metadata.isSymbolicLink() || !metadata.isFile() || !ownedByCurrentUser(metadata) ||
        metadata.size > 32 * 1024 * 1024) throw new UnsafeMigrationTarget()
      const handle = await open(stateFile, constants.O_RDONLY | noFollowFlag())
      try {
        return await handle.readFile()
      } finally {
        await handle.close()
      }
    },
    catch: (cause) => cause instanceof UnsafeMigrationTarget
      ? migrationError("unsafe", "The archived checkpoint file is unsafe.")
      : hasCode(cause, "ENOENT")
      ? migrationError("not_found", "The migration import has no archived Collector state.")
      : migrationError("io", "Could not read the archived Collector state.")
  })
  const value = yield* Effect.try({
    try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    catch: () => migrationError("io", "The archived Collector state is invalid.")
  })
  const state = yield* Schema.decodeUnknownEffect(LegacyCollectorState)(value).pipe(
    Effect.mapError(() => migrationError("io", "The archived Collector state is invalid."))
  )
  const matches = state.checkpoints.filter((checkpoint) =>
    checkpoint.projectId === input.projectId && checkpoint.adapterId === input.adapterId)
  if (matches.length !== 1) {
    return yield* migrationError(
      matches.length === 0 ? "not_found" : "conflict",
      matches.length === 0
        ? "The requested v0.1 Project/Adapter checkpoint was not found."
        : "The archived state contains ambiguous Project/Adapter checkpoints."
    )
  }
  return matches[0] as NonNullable<(typeof matches)[number]>
})

const ensurePrivateDirectory = async (path: string) => {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (cause) {
    if (!hasCode(cause, "EEXIST")) throw cause
  }
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !ownedByCurrentUser(metadata) ||
    (metadata.mode & 0o777) !== 0o700) throw new UnsafeMigrationTarget()
}

const assertPrivateDirectory = async (path: string) => {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !ownedByCurrentUser(metadata) ||
    (metadata.mode & 0o777) !== 0o700) throw new UnsafeMigrationTarget()
}

const ownedByCurrentUser = (metadata: Stats) => process.getuid === undefined || metadata.uid === process.getuid()

const exists = async (path: string) => {
  try {
    await lstat(path)
    return true
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return false
    throw cause
  }
}

const syncDirectory = async (path: string) => {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const noFollowFlag = () => typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
class UnsafeMigrationTarget extends Error {}

const migrationError = (reason: ClientMigrationError["reason"], message: string) =>
  new ClientMigrationError({ reason, message })

const hasCode = (cause: unknown, code: string): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === code
