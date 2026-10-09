import { RedactionConfigurationStore, RedactionSettingsError, type RedactionConfiguration, type RedactionConfigurationSource } from "@atape/application"
import { constants } from "node:fs"
import { mkdir, open, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"
import { Effect, Layer } from "effect"
import { withClientConfigFileLock } from "./clientConfig.ts"
import { environmentSecretValues, readRedactionConfigurationFile, redactionConfigurationBytes,
  redactionFileRevision, selectRedactionConfigurationFile } from "./redactionConfigurationFile.ts"

const ioFailure = () => new RedactionSettingsError({ reason: "io", message: "Could not safely read or write the selected redaction configuration." })
const environmentFailure = () => new RedactionSettingsError({ reason: "environment", message: "The effective redaction environment values are invalid or exceed their admitted limits." })
const conflictFailure = () => new RedactionSettingsError({ reason: "conflict", message: "The redaction configuration changed. Reload it before saving again." })

/** Shares selection, environment resolution and bounded no-follow reads with the
 * Collector. This Layer has no Collector identity or progress dependency. */
export const makeRedactionSettingsLayer = (paths: { readonly atapeHome: string }, environment: NodeJS.ProcessEnv) => {
  const inherited = { ...environment }
  const selection = selectRedactionConfigurationFile({ atapeHome: paths.atapeHome, environment: inherited })
  const read = async (): Promise<RedactionConfigurationSource> => {
    let secretValues: ReadonlyArray<string>
    try { secretValues = environmentSecretValues(inherited) } catch { throw environmentFailure() }
    try { return { ...selection, ...await readRedactionConfigurationFile(selection), secretValues } }
    catch { throw ioFailure() }
  }
  const replace = async (expectedRevision: string, configuration: RedactionConfiguration): Promise<RedactionConfigurationSource> =>
    withClientConfigFileLock(selection.configFile, async () => {
      const current = await read()
      if (current.revision !== expectedRevision) throw conflictFailure()
      const content = `${JSON.stringify(configuration)}\n`
      const bytes = new TextEncoder().encode(content)
      if (bytes.byteLength > redactionConfigurationBytes) throw new RedactionSettingsError({ reason: "configuration", message: "The redaction configuration is invalid or exceeds its admitted limits." })
      await mkdir(dirname(selection.configFile), { recursive: true, mode: 0o700 })
      const temporary = `${selection.configFile}.${randomUUID()}.tmp`
      try {
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try {
          await file.writeFile(bytes); await file.sync()
          // Detect observable external edits after preparation, immediately before
          // rename. The lock serializes ATape writers, not uncooperative editors.
          if ((await read()).revision !== expectedRevision) throw conflictFailure()
          await rename(temporary, selection.configFile)
          const directory = await open(dirname(selection.configFile), constants.O_RDONLY)
          try { await directory.sync() } finally { await directory.close() }
          // Describe this write through its open handle. A later external edit
          // must not be returned as if it had been the caller's saved policy.
          return { ...current, content, revision: redactionFileRevision(bytes, await file.stat()), exists: true }
        } finally { await file.close() }
      } finally { await rm(temporary, { force: true }).catch(() => undefined) }
    })
  return Layer.succeed(RedactionConfigurationStore, RedactionConfigurationStore.of({
    read: () => Effect.tryPromise({ try: read, catch: cause => cause instanceof RedactionSettingsError ? cause : ioFailure() }),
    replace: (expectedRevision, configuration) => Effect.tryPromise({
      try: () => replace(expectedRevision, configuration), catch: cause => cause instanceof RedactionSettingsError ? cause : ioFailure()
    }).pipe(Effect.uninterruptible)
  }))
}
