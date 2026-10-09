import { compileRedactionPolicy, type CompiledRedactionPolicy } from "@atape/application"
import { constants } from "node:fs"
import { lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { Effect, Schema } from "effect"
import { withClientConfigFileLock } from "./clientConfig.ts"

export class RedactionPolicyLoadError extends Schema.TaggedError<RedactionPolicyLoadError>()("RedactionPolicyLoadError", {
  reason: Schema.Literals(["configuration", "identity", "io"]), message: Schema.String
}) {}

const failure = (reason: RedactionPolicyLoadError["reason"], message: string) => new RedactionPolicyLoadError({ reason, message })
const code = (cause: unknown, value: string) => typeof cause === "object" && cause !== null && "code" in cause && cause.code === value
const ConfigBytes = 128 * 1024
const Binding = "atape.redaction-key.v1"
// These reserved nonces have completed their local handshake before collection.
// Including them would change the effective policy on every managed restart.
const handshakeNonces = new Set(["ATAPE_COLLECTOR_READY_TOKEN", "ATAPE_UPDATE_WORKER_TOKEN"])

/** Resolves exact values without logging names or values. Ambient discovery keeps
 * its existing length admission; explicitly supplied values are validated. */
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
    throw failure("configuration", "ATAPE_REDACT_VALUES must contain exact strings of 8 to 4096 characters in a JSON array or comma-separated list.")
  return [...values, ...explicit as string[]]
}

/** Bounded, no-follow reads also reject pipes/devices before consuming bytes.
 * Diagnostic messages deliberately omit user paths and parser exception text. */
const readBounded = async (path: string, maximum: number, privateFile = false): Promise<Uint8Array> => {
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
    if (size > maximum || size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino)
      throw new Error("Local redaction file changed during read")
    return new Uint8Array(buffer.subarray(0, size))
  } finally { await handle.close() }
}

const writePrivate = async (path: string, bytes: Uint8Array) => {
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    if (await exists(path)) throw new Error("Redaction identity already exists")
    await rename(temporary, path)
    const directory = await open(dirname(path), constants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close() }
  } finally { await rm(temporary, { force: true }).catch(() => undefined) }
}

const exists = async (path: string) => {
  try { await lstat(path); return true } catch (cause) { if (code(cause, "ENOENT")) return false; throw cause }
}

/** The ready binding prevents a missing established key from silently becoming
 * a different policy identity. The existing filesystem lock serializes jobs. */
const installationKey = (stateFile: string) => withClientConfigFileLock(`${stateFile}.redaction-key`, async () => {
  const keyFile = `${stateFile}.redaction-key`, bindingFile = `${keyFile}.json`
  const ready = await exists(bindingFile)
  if (!(await exists(keyFile))) {
    if (ready) throw failure("identity", "The established redaction identity key is missing. Restore it with its Collector state.")
    await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 })
    await writePrivate(keyFile, randomBytes(32))
  }
  const key = await readBounded(keyFile, 32, true)
  if (key.byteLength !== 32) throw failure("identity", "The redaction identity key is invalid. Restore it with its Collector state.")
  const digest = createHash("sha256").update(key).digest("hex")
  if (ready) {
    let binding: unknown
    try { binding = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(bindingFile, 256, true))) }
    catch { throw failure("identity", "The redaction identity binding is invalid. Restore its existing state.") }
    if (typeof binding !== "object" || binding === null || !("protocol" in binding) || !("digest" in binding) ||
      binding.protocol !== Binding || binding.digest !== digest)
      throw failure("identity", "The redaction identity key differs from its established binding. Restore its existing state.")
  } else await writePrivate(bindingFile, new TextEncoder().encode(`${JSON.stringify({ protocol: Binding, digest })}\n`))
  return key
})

export type NodeRedactionPolicyOptions = {
  readonly mode: "test" | "collector"
  readonly configFile?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly atapeHome?: string
  readonly stateFile?: string
}

/** File tests compile the same rules with an ephemeral identity and never create
 * ATape state. Collection reloads configuration between immutable job snapshots. */
export const loadNodeRedactionPolicy = (options: NodeRedactionPolicyOptions): Effect.Effect<
  CompiledRedactionPolicy, RedactionPolicyLoadError | import("@atape/application").RedactionPolicyError
> => Effect.gen(function*() {
  const environment = options.environment ?? process.env
  const atapeHome = options.atapeHome ?? environment.ATAPE_HOME ?? join(homedir(), ".atape")
  const explicit = options.configFile ?? environment.ATAPE_REDACTION_CONFIG_FILE
  const configFile = explicit ?? join(atapeHome, "config", "redaction.json")
  const configuration = yield* Effect.tryPromise({
    try: async () => {
      try { return new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(configFile, ConfigBytes)) }
      catch (cause) {
        if (code(cause, "ENOENT") && explicit === undefined) return undefined
        throw failure("configuration", "Could not read a bounded UTF-8 redaction configuration. Check the selected regular file and its permissions.")
      }
    }, catch: cause => cause instanceof RedactionPolicyLoadError ? cause : failure("io", "Could not load the local redaction configuration.")
  })
  const secretValues = yield* Effect.try({ try: () => environmentSecretValues(environment),
    catch: cause => cause instanceof RedactionPolicyLoadError ? cause : failure("configuration", "The configured redaction values are invalid.") })
  // Validate/compile before persistent identity bootstrap so invalid policy input
  // does not modify local state. The second compilation only assigns its stable ID.
  const ephemeral = yield* Effect.sync(() => randomBytes(32))
  const validated = yield* compileRedactionPolicy({ configuration, secretValues, installationKey: ephemeral })
  if (options.mode === "test") return validated
  if (!options.stateFile) return yield* failure("identity", "Collector redaction requires its installation state path.")
  const key = yield* Effect.tryPromise({ try: () => installationKey(options.stateFile!),
    catch: cause => cause instanceof RedactionPolicyLoadError ? cause : failure("identity", "Could not load the private redaction identity. Preserve its existing Collector state.") })
  return yield* compileRedactionPolicy({ configuration, secretValues, installationKey: key })
})
