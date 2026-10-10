import { compileRedactionPolicy, validateRedactionConfiguration, type CompiledRedactionPolicy } from "@atape/application"
import type { RedactionConfigurationDescriptor } from "@atape/domain"
import { constants } from "node:fs"
import { lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { dirname } from "node:path"
import { Effect } from "effect"
import { withClientConfigFileLock } from "./clientConfig.ts"
import { environmentSecretValues, hasRedactionFileCode as code, readBoundedRedactionFile, readRedactionConfigurationFile,
  RedactionPolicyLoadError, selectRedactionConfigurationFile } from "./redactionConfigurationFile.ts"
export { environmentSecretValues, RedactionPolicyLoadError } from "./redactionConfigurationFile.ts"

const failure = (reason: RedactionPolicyLoadError["reason"], message: string) => new RedactionPolicyLoadError({ reason, message })
const Binding = "atape.redaction-key.v1"

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
  const { bytes: key } = await readBoundedRedactionFile(keyFile, 32, true)
  if (key.byteLength !== 32) throw failure("identity", "The redaction identity key is invalid. Restore it with its Collector state.")
  const digest = createHash("sha256").update(key).digest("hex")
  if (ready) {
    let binding: unknown
    try { binding = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode((await readBoundedRedactionFile(bindingFile, 256, true)).bytes)) }
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
export const loadNodeRedactionPolicySnapshot = (options: NodeRedactionPolicyOptions): Effect.Effect<
  { readonly policy: CompiledRedactionPolicy; readonly descriptor: RedactionConfigurationDescriptor },
  RedactionPolicyLoadError | import("@atape/application").RedactionPolicyError
> => Effect.gen(function*() {
  const environment = options.environment ?? process.env
  const selection = selectRedactionConfigurationFile({ ...options, environment })
  const source = yield* Effect.tryPromise({
    try: () => readRedactionConfigurationFile(selection),
    catch: cause => cause instanceof RedactionPolicyLoadError ? cause : failure("io", "Could not load the local redaction configuration.")
  })
  const secretValues = yield* Effect.try({ try: () => environmentSecretValues(environment),
    catch: cause => cause instanceof RedactionPolicyLoadError ? cause : failure("configuration", "The configured redaction values are invalid.") })
  const configuration = yield* validateRedactionConfiguration(source.content ?? {})
  const descriptor: RedactionConfigurationDescriptor = Object.freeze({ configFile: selection.configFile,
    origin: selection.origin, revision: source.revision, exists: source.exists,
    literalCount: new Set(secretValues).size, customRuleCount: configuration.patterns?.length ?? 0 })
  // Validate/compile before persistent identity bootstrap so invalid policy input
  // does not modify local state. The second compilation only assigns its stable ID.
  const ephemeral = yield* Effect.sync(() => randomBytes(32))
  const validated = yield* compileRedactionPolicy({ configuration, secretValues, installationKey: ephemeral })
  if (options.mode === "test") return { policy: validated, descriptor }
  if (!options.stateFile) return yield* failure("identity", "Collector redaction requires its installation state path.")
  const key = yield* Effect.tryPromise({ try: () => installationKey(options.stateFile!),
    catch: cause => cause instanceof RedactionPolicyLoadError ? cause : failure("identity", "Could not load the private redaction identity. Preserve its existing Collector state.") })
  const policy = yield* compileRedactionPolicy({ configuration, secretValues, installationKey: key })
  return { policy, descriptor }
})

export const loadNodeRedactionPolicy = (options: NodeRedactionPolicyOptions) =>
  loadNodeRedactionPolicySnapshot(options).pipe(Effect.map(snapshot => snapshot.policy))
