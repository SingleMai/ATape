import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { homedir } from "node:os"
import { Schema } from "effect"

export class RedactionPolicyLoadError extends Schema.TaggedError<RedactionPolicyLoadError>()("RedactionPolicyLoadError", {
  reason: Schema.Literals(["configuration", "identity", "io"]), message: Schema.String
}) {}

export const redactionConfigurationBytes = 128 * 1024
export const hasRedactionFileCode = (cause: unknown, value: string) => typeof cause === "object" && cause !== null && "code" in cause && cause.code === value
const handshakeNonces = new Set(["ATAPE_COLLECTOR_READY_TOKEN", "ATAPE_UPDATE_WORKER_TOKEN"])
export const redactionFileRevision = (bytes: Uint8Array, file: { readonly dev: number; readonly ino: number; readonly size: number; readonly mode: number; readonly mtimeMs: number; readonly ctimeMs: number }) =>
  createHash("sha256").update(JSON.stringify([file.dev, file.ino, file.size, file.mode, file.mtimeMs, file.ctimeMs])).update(bytes).digest("hex")

/** Completed local handshake nonces are excluded; user-configured values win. */
export const environmentSecretValues = (environment: NodeJS.ProcessEnv): ReadonlyArray<string> => {
  const values = Object.entries(environment).filter(([name, value]) => name !== "ATAPE_REDACT_VALUES" && !handshakeNonces.has(name) && value !== undefined &&
    /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|DATABASE_URL|DSN)$/i.test(name) && value.length >= 8 && value.length <= 4096)
    .map(([, value]) => value!)
  const configured = environment.ATAPE_REDACT_VALUES
  if (configured === undefined || configured.trim() === "") return values
  let explicit: unknown
  try { explicit = JSON.parse(configured) }
  catch { explicit = configured.split(",").map(value => value.trim()).filter(Boolean) }
  if (!Array.isArray(explicit) || explicit.some(value => typeof value !== "string" || value.length < 8 || value.length > 4096))
    throw new RedactionPolicyLoadError({ reason: "configuration", message: "ATAPE_REDACT_VALUES must contain exact strings of 8 to 4096 characters in a JSON array or comma-separated list." })
  return [...values, ...explicit as string[]]
}

/** Regular-file, no-follow, bounded reads with a stable source revision. */
export const readBoundedRedactionFile = async (path: string, maximum: number, privateFile = false) => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maximum || privateFile && (before.nlink !== 1 || (before.mode & 0o077) !== 0 ||
      typeof process.getuid === "function" && before.uid !== process.getuid())) throw new Error("Invalid local redaction file")
    const buffer = Buffer.alloc(maximum + 1)
    let size = 0
    while (size <= maximum) {
      const result = await handle.read(buffer, size, maximum + 1 - size, size)
      if (result.bytesRead === 0) break
      size += result.bytesRead
    }
    const after = await handle.stat()
    if (size > maximum || size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs || after.ino !== before.ino) throw new Error("Local redaction file changed during read")
    const bytes = new Uint8Array(buffer.subarray(0, size))
    const revision = redactionFileRevision(bytes, before)
    return { bytes, revision }
  } finally { await handle.close() }
}

export type RedactionConfigurationSelection = { readonly configFile: string; readonly origin: "default" | "environment"; readonly explicit: boolean }
export const selectRedactionConfigurationFile = (options: { readonly atapeHome?: string; readonly configFile?: string; readonly environment: NodeJS.ProcessEnv }): RedactionConfigurationSelection => {
  const atapeHome = options.atapeHome ?? options.environment.ATAPE_HOME ?? join(homedir(), ".atape")
  const explicit = options.configFile ?? options.environment.ATAPE_REDACTION_CONFIG_FILE
  return { configFile: explicit ?? join(atapeHome, "config", "redaction.json"), origin: explicit === undefined ? "default" : "environment", explicit: explicit !== undefined }
}

export const readRedactionConfigurationFile = async (selection: RedactionConfigurationSelection) => {
  try {
    const file = await readBoundedRedactionFile(selection.configFile, redactionConfigurationBytes)
    const content = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
    return { content, revision: file.revision, exists: true }
  } catch (cause) {
    if (hasRedactionFileCode(cause, "ENOENT") && !selection.explicit) return { content: undefined, revision: "missing", exists: false }
    throw new RedactionPolicyLoadError({ reason: "configuration", message: "Could not read a bounded UTF-8 redaction configuration. Check the selected regular file and its permissions." })
  }
}
