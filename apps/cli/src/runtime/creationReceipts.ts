import { CreationReceiptAttempt, CreationReceiptAttemptInput, ConfirmedCreationReceipt, CreationReceiptPrefix,
  CreationReceiptVersion, NewSessionResult, type CreationReceiptReader, type NewSessionStartRequest } from "@atape/domain"
import { AdapterRuntimeError } from "@atape/application"
import { Effect, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { withClientConfigFileLock } from "./clientConfig.ts"
import { guardRuntimeWrite, runtimeContext, type RuntimeContext } from "./runtimeAdmission.ts"
import { createCreationReceiptAdmission } from "./creationReceiptAdmission.ts"

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const missing = (cause: unknown) => typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
const maximum = 32 * 1024
const immutable = <T>(value: T): T => {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) immutable(child); Object.freeze(value) }
  return value
}
const Record = Schema.Union([Schema.Struct({ state: Schema.Literal("pending"), receipt: CreationReceiptAttempt }),
  Schema.Struct({ state: Schema.Literal("abandoned"), receipt: CreationReceiptAttempt }),
  Schema.Struct({ state: Schema.Literal("confirmed"), receipt: ConfirmedCreationReceipt })])

/** Private durable Host metadata. The provider never receives storage paths or write authority outside a start Scope. */
export const makeCreationReceiptStore = (home: string, adapterId: string, runtime: RuntimeContext = runtimeContext(home)) => {
  const base = resolve(home), directory = join(base, "state", "creation-receipts", hash(adapterId))
  const admission = createCreationReceiptAdmission(base)
  const fail = (message: string) => new AdapterRuntimeError({ adapterId, reason: "contract", retryable: false, message })
  const uid = process.getuid?.()
  const directories = async (create: boolean) => {
    if (await realpath(base) !== base) throw fail("Creation receipt home must be canonical.")
    let path = base
    for (const component of ["", "state", "creation-receipts", hash(adapterId)]) {
      path = join(path, component)
      if (create) await mkdir(path, { mode: 0o700 }).catch(cause => { if (!(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")) throw cause })
      try {
        const info = await lstat(path)
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) throw fail("Creation receipt directories must be private, owned directories.")
      } catch (cause) { if (!create && missing(cause)) return false; throw cause }
    }
    return true
  }
  const canonicalRoot = async (value: string) => {
    if (!isAbsolute(value) || value.length > 4096 || value.includes("\0")) throw fail("Invalid creation receipt state root.")
    const canonical = await realpath(value)
    if (canonical !== value || !(await lstat(canonical)).isDirectory()) throw fail("Creation receipt state root must be an existing canonical directory.")
    return canonical
  }
  const location = (root: string, sourceId: string) => join(directory, `${hash(JSON.stringify([root, sourceId]))}.json`)
  const validateIdentity = (receipt: CreationReceiptAttempt, root: string, sourceId: string) => {
    const child = relative(root, receipt.sourcePath)
    if (receipt.adapterId !== adapterId || receipt.stateDirectory !== root || receipt.sourceId !== sourceId ||
      receipt.origin.sourceId !== sourceId || !receipt.origin.originKey || !isAbsolute(receipt.origin.cwd) || receipt.origin.cwd.length > 4096 || receipt.origin.cwd.includes("\0") ||
      receipt.origin.repositoryRemote !== undefined && (receipt.origin.repositoryRemote.length > 4096 || /[\r\n\0]/.test(receipt.origin.repositoryRemote)) ||
      resolve(receipt.sourcePath) !== receipt.sourcePath || child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw fail("Creation receipt identity does not match its storage scope.")
  }
  const read = async (file: string, published = false) => {
    try {
      const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const before = await fd.stat()
        if (!before.isFile() || before.uid !== uid || (before.mode & 0o077) !== 0 || before.size > maximum) throw fail("Unsafe creation receipt file.")
        const bytes = Buffer.alloc(before.size + 1)
        let length = 0
        while (length < bytes.length) { const result = await fd.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead }
        const after = await fd.stat()
        const stable = before.dev === after.dev && before.ino === after.ino && before.uid === after.uid && before.mode === after.mode &&
          before.size === after.size && before.mtimeMs === after.mtimeMs
        const publicationUnlink = published && before.nlink === 1 && after.nlink === 0
        if (length !== before.size || !stable || before.nlink !== after.nlink && !publicationUnlink || before.ctimeMs !== after.ctimeMs && !publicationUnlink) throw fail("Creation receipt changed while reading.")
        return Schema.decodeUnknownSync(Record)(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))))
      } finally { await fd.close() }
    } catch (cause) { if (missing(cause)) return undefined; throw cause }
  }
  const atomic = async (file: string, value: typeof Record.Type) => {
    const bytes = JSON.stringify(value)
    if (Buffer.byteLength(bytes) > maximum) throw fail("Creation receipt exceeds its storage limit.")
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const fd = await open(temporary, "wx", 0o600)
      try { await fd.writeFile(bytes); await fd.sync() } finally { await fd.close() }
      await rename(temporary, file)
      const parent = await open(dirname(file), "r")
      try { await parent.sync() } finally { await parent.close() }
    } finally { await rm(temporary, { force: true }) }
  }
  const mutate = async <A>(file: string, work: (current: typeof Record.Type | undefined) => Promise<{ value: A; record: typeof Record.Type }>, beforeWrite?: () => Promise<void>) => {
    await Effect.runPromise(guardRuntimeWrite(runtime, Effect.tryPromise({ try: () => directories(true), catch: cause => fail(`Could not initialize private creation storage: ${String(cause)}`) }), cause => fail(`Runtime cannot initialize creation storage: ${String(cause)}`)))
    return withClientConfigFileLock(file, async () => {
      const change = await work(await read(file))
      await Effect.runPromise(guardRuntimeWrite(runtime, Effect.tryPromise({ try: async () => { await beforeWrite?.(); await atomic(file, change.record) }, catch: cause => fail(`Could not persist creation receipt: ${String(cause)}`) }), cause => fail(`Runtime cannot write creation receipts: ${String(cause)}`)))
      return change.value
    })
  }
  const reader: CreationReceiptReader = { readConfirmed: async (input, signal) => {
    signal.throwIfAborted()
    const root = await canonicalRoot(input.stateDirectory)
    Schema.decodeUnknownSync(CreationReceiptAttemptInput)({ ...input, sourcePath: join(root, "placeholder"), profile: "lookup" })
    if (!await directories(false)) return undefined
    const current = await read(location(root, input.sourceId), true)
    signal.throwIfAborted()
    if (!current) return undefined
    validateIdentity(current.receipt, root, input.sourceId)
    return current.state === "confirmed" ? immutable(current.receipt) : undefined
  } }
  const scope = (origin: NewSessionStartRequest["origin"], revalidate: Effect.Effect<void, AdapterRuntimeError>,
    lifetime: AbortSignal) => {
    const frozenOrigin = immutable(structuredClone(origin))
    let active = true, claimed = false, attempt: CreationReceiptAttempt | undefined, state: "none" | "pending" | "confirmed" | "abandoned" = "none"
    let pendingLease: (() => void) | undefined
    const releasePending = () => { const release = pendingLease; pendingLease = undefined; release?.() }
    let pending: Promise<unknown> = Promise.resolve()
    const queue = <A>(signal: AbortSignal, work: () => Promise<A>) => {
      const task = pending.then(async () => { if (!active || lifetime.aborted || signal.aborted) throw fail("Creation callback is outside its active start scope."); return work() })
      pending = task.catch(() => undefined)
      return task
    }
    const creation: NewSessionStartRequest["creation"] = {
      recordAttempt: (input, signal) => {
        if (claimed) return Promise.reject(fail("A start scope can record only one creation attempt."))
        claimed = true
        return queue(signal, async () => {
          const decoded = Schema.decodeUnknownSync(CreationReceiptAttemptInput)(input)
          const root = await canonicalRoot(decoded.stateDirectory)
          const receipt: CreationReceiptAttempt = { ...decoded, protocolVersion: CreationReceiptVersion, adapterId,
            attemptId: randomUUID(), origin: { ...frozenOrigin, sourceId: decoded.sourceId, originKey: `creation:${randomUUID()}` }, recordedAt: new Date().toISOString() }
          Schema.decodeUnknownSync(CreationReceiptAttempt)(receipt)
          immutable(receipt)
          validateIdentity(receipt, root, decoded.sourceId)
          let value: CreationReceiptAttempt
          try {
            value = await mutate(location(root, decoded.sourceId), async current => {
              await Effect.runPromise(revalidate, { signal: AbortSignal.any([signal, lifetime]) })
              if (current) throw fail("This source already has a creation attempt; it cannot be adopted or reused.")
              return { value: receipt, record: { state: "pending", receipt } }
            }, async () => { pendingLease = await admission.acquirePending() })
          } catch (cause) { releasePending(); throw cause }
          attempt = value; state = "pending"; return value
        })
      },
      confirm: (input, signal) => queue(signal, async () => {
        if (!attempt || state !== "pending") throw fail("Only the current pending attempt can be confirmed.")
        const prefix = Schema.decodeUnknownSync(CreationReceiptPrefix)(input.prefix)
        const receipt: ConfirmedCreationReceipt = immutable({ ...attempt, prefix: structuredClone(prefix), confirmedAt: new Date().toISOString() })
        await mutate(location(attempt.stateDirectory, attempt.sourceId), async current => {
          if (!current || current.state !== "pending" || !isDeepStrictEqual(current.receipt, attempt)) throw fail("Creation receipt compare-and-set failed.")
          return { value: undefined, record: { state: "confirmed", receipt } }
        })
        state = "confirmed"; releasePending(); return receipt
      }),
      abandon: signal => queue(signal, async () => { await abandon() })
    }
    const abandon = async () => {
      if (!attempt || state !== "pending") return
      await mutate(location(attempt.stateDirectory, attempt.sourceId), async current => {
        if (!current || !isDeepStrictEqual(current.receipt, attempt) || current.state !== "pending") throw fail("Creation receipt compare-and-set failed.")
        return { value: undefined, record: { state: "abandoned", receipt: attempt! } }
      })
      state = "abandoned"
      releasePending()
    }
    let finishing: Promise<void> | undefined
    return { creation,
      finish: () => { active = false; return finishing ??= (async () => { try { await pending; await abandon() } finally { releasePending() } })() },
      result: (value: unknown) => {
        const result = Schema.decodeUnknownSync(NewSessionResult)(value)
        if (!attempt || result.sourceId !== attempt.sourceId || result.creation !== (state === "confirmed" ? "confirmed" : "unconfirmed")) throw fail("Adapter start result does not match Host creation facts.")
        return result
      }
    }
  }
  return { reader, scope }
}
