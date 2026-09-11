import { ClientConfigStore, ClientConfigStoreError, type ClientConfigChange } from "@atape/application"
import { ClientConfig as ClientConfigSchema, emptyClientConfig, type ClientConfig } from "@atape/domain"
import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { Effect, Layer, Schema } from "effect"

export const makeConfigStoreLayer = (configFile: string) => Layer.succeed(
  ClientConfigStore,
  ClientConfigStore.of({
    transact: <A, E, R>(change: (config: ClientConfig) => Effect.Effect<ClientConfigChange<A>, E, R>) =>
      Effect.acquireUseRelease(
        acquireConfigLock(configFile),
        () => readClientConfig(configFile).pipe(
          Effect.flatMap(change),
          Effect.flatMap((result) => result.config === undefined
            ? Effect.succeed(result.value)
            : writeClientConfig(configFile, result.config).pipe(Effect.as(result.value)))
        ),
        (lock) => Effect.promise(async () => {
          await lock.close().catch(() => undefined)
          await rm(lock.path, { force: true }).catch(() => undefined)
        })
      )
  })
)

const acquireConfigLock = (configFile: string) => Effect.tryPromise({
  try: async () => {
    await mkdir(dirname(configFile), { recursive: true, mode: 0o700 })
    const lockPath = `${configFile}.lock`
    const deadline = Date.now() + 5_000
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600)
        try {
          await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`)
          await handle.sync()
          return { path: lockPath, close: () => handle.close() }
        } catch (cause) {
          await handle.close().catch(() => undefined)
          await rm(lockPath, { force: true }).catch(() => undefined)
          throw cause
        }
      } catch (cause) {
        if (!hasCode(cause, "EEXIST")) throw cause
        if (await staleConfigLock(lockPath)) {
          await rm(lockPath, { force: true })
          continue
        }
        if (Date.now() >= deadline) throw cause
        await new Promise((done) => setTimeout(done, 50))
      }
    }
  },
  catch: (cause) => new ClientConfigStoreError({
    reason: "io",
    message: hasCode(cause, "EEXIST")
      ? "Another ATape CLI command is still updating the client configuration."
      : errorMessage("Could not lock the ATape client configuration", cause)
  })
})

const staleConfigLock = async (lockPath: string) => {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown }
    if (typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0) {
      try {
        process.kill(value.pid, 0)
        return false
      } catch (cause) {
        return hasCode(cause, "ESRCH")
      }
    }
  } catch {
    // A process may have created the lock and not written its owner yet. Only
    // remove malformed locks once they are old enough to be unambiguously stale.
  }
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > 30_000
  } catch (cause) {
    return hasCode(cause, "ENOENT")
  }
}

export const readClientConfig = (configFile: string): Effect.Effect<ClientConfig, ClientConfigStoreError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        return JSON.parse(await readFile(configFile, "utf8")) as unknown
      } catch (cause) {
        if (hasCode(cause, "ENOENT")) return emptyClientConfig()
        throw cause
      }
    },
    catch: (cause) => new ClientConfigStoreError({
      reason: "io",
      message: errorMessage("Could not read the ATape client configuration", cause)
    })
  }).pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(ClientConfigSchema)(value)),
    Effect.mapError((error) => error instanceof ClientConfigStoreError
      ? error
      : new ClientConfigStoreError({
        reason: "decode",
        message: `The ATape client configuration is invalid: ${String(error)}`
      }))
  )

// Locale is a presentation preference; a missing or unreadable configuration
// must never prevent the CLI from starting with the default locale.
export const readClientConfigLocale = (configFile: string): Effect.Effect<string | undefined> =>
  readClientConfig(configFile).pipe(
    Effect.map((config) => config.locale),
    Effect.catch(() => Effect.succeed(undefined))
  )

const writeClientConfig = (configFile: string, config: ClientConfig): Effect.Effect<void, ClientConfigStoreError> =>
  Schema.decodeUnknownEffect(ClientConfigSchema)(config).pipe(
    Effect.mapError((error) => new ClientConfigStoreError({
      reason: "decode", message: `ATape refused to persist an invalid client configuration: ${String(error)}`
    })),
    Effect.flatMap((validated) => Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(configFile), { recursive: true, mode: 0o700 })
        const temporary = `${configFile}.${process.pid}.${randomUUID()}.tmp`
        try {
          const file = await open(temporary, "wx", 0o600)
          try { await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`); await file.sync() } finally { await file.close() }
          await rename(temporary, configFile)
          await syncDirectory(dirname(configFile))
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined)
        }
      },
      catch: (cause) => new ClientConfigStoreError({
        reason: "io", message: errorMessage("Could not write the ATape client configuration", cause)
      })
    }).pipe(Effect.uninterruptible))
  )

const syncDirectory = async (path: string) => {
  if (process.platform === "win32") return
  const directory = await open(path, "r")
  try { await directory.sync() } finally { await directory.close() }
}

const hasCode = (cause: unknown, code: string): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === code

const errorMessage = (prefix: string, cause: unknown) =>
  `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}`
