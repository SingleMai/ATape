import { CreationReceiptAttempt, ConfirmedCreationReceipt, type NewSessionStartRequest } from "@atape/domain"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import { Effect, Fiber, Schema } from "effect"
import { assertCursorSourceAbsent, readCursorSource, CursorSourceError, type CursorSourceSnapshot } from "./cursorSource.ts"
import { CursorNativeProfile, CursorNativeVersion, CursorRuntimeError, cursorLimits, cursorRoot, problem, workspaceSlug } from "./cursorProfile.ts"

type Outcome = { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly failed?: true }
type OwnedChild = { readonly child: ChildProcess; readonly exit: Promise<Outcome>; outcome: Outcome | undefined }
const execute = promisify(execFile)
const ownedChild = (file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): OwnedChild => {
  const child = spawn(file, args, { cwd, env, stdio: "inherit" })
  let settle!: (outcome: Outcome) => void
  const owned: OwnedChild = { child, outcome: undefined, exit: new Promise(resolve => { settle = resolve }) }
  const finish = (outcome: Outcome) => { if (owned.outcome === undefined) { owned.outcome = outcome; settle(outcome) } }
  child.once("exit", (code, signal) => finish({ code, signal }))
  child.once("error", () => finish({ code: null, signal: null, failed: true }))
  return owned
}
const terminateAndJoin = async (owned: OwnedChild) => {
  if (owned.outcome !== undefined) { await owned.exit; return }
  owned.child.kill("SIGTERM")
  let timeout: ReturnType<typeof setTimeout> | undefined
  await Promise.race([owned.exit, new Promise<void>(resolve => { timeout = setTimeout(resolve, 1500) })])
  if (timeout !== undefined) clearTimeout(timeout)
  if (owned.outcome === undefined) owned.child.kill("SIGKILL")
  await owned.exit
}
const temporary = (error: unknown) => error instanceof CursorSourceError && ["missing", "changed", "incomplete"].includes(error.reason)
const safeFailure = (cause: unknown) => cause instanceof Error ? cause : problem("native", "Cursor native operation failed.")

/** Owns the immediate interactive child and its bounded proof attempts. Human
 * idle time has no total deadline; proof errors never terminate a valid chat. */
export const startNativeSession = (environment: NodeJS.ProcessEnv, request: NewSessionStartRequest) => Effect.gen(function*() {
  if (!isAbsolute(request.origin.cwd) || request.origin.cwd.includes("\0") || Buffer.byteLength(request.origin.cwd) > 4096 ||
    request.initialPrompt !== undefined && (request.initialPrompt.includes("\0") || Buffer.byteLength(request.initialPrompt) > 64 * 1024))
    return yield* problem("format", "Cursor start input is invalid.")
  const cwd = yield* Effect.tryPromise({ try: () => realpath(request.origin.cwd), catch: () => problem("io", "Cursor workspace is unavailable.") })
  if (cwd !== request.origin.cwd) return yield* problem("attribution", "Cursor workspace differs from its frozen origin.")
  const slug = workspaceSlug(cwd)
  if (!slug) return yield* problem("unsupported", "Cursor native workspace locator is unsupported.")
  const file = environment.ATAPE_CURSOR_EXECUTABLE
  if (!file?.trim()) return yield* new CursorSourceError({ reason: "missing", message: "Configure the Cursor native executable before starting." })
  if (!isAbsolute(file) || file.includes("\0")) return yield* problem("unsupported", "Cursor native executable must be an absolute path.")
  const selected = yield* cursorRoot(environment)
  const nativeEnvironment: NodeJS.ProcessEnv = { ...environment, CURSOR_CONFIG_DIR: selected, CURSOR_DATA_DIR: selected }
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV"]) delete nativeEnvironment[key]
  const version = yield* Effect.tryPromise({ try: signal => execute(file, ["--disable-auto-update", "--version"], {
    cwd, env: nativeEnvironment, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 4096, encoding: "utf8", signal
  }), catch: cause => typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
    ? new CursorSourceError({ reason: "missing", message: "Cursor native executable is unavailable." })
    : problem("native", "Could not verify the Cursor native executable.") })
  if (version.stdout.trim() !== CursorNativeVersion) return yield* problem("unsupported", "Cursor native version is unsupported.")
  const root = yield* cursorRoot(environment, true)
  nativeEnvironment.CURSOR_CONFIG_DIR = root; nativeEnvironment.CURSOR_DATA_DIR = root
  const sourceId = randomUUID(), sourcePath = join(root, "projects", slug, "agent-transcripts", sourceId, `${sourceId}.jsonl`)
  const chatDirectory = join(root, "chats", createHash("md5").update(cwd).digest("hex"), sourceId)
  yield* assertCursorSourceAbsent({ stateDirectory: root, sourceId, chatDirectory, limits: cursorLimits() })
  const attempt = yield* Effect.tryPromise({ try: () => request.creation.recordAttempt({ sourceId, stateDirectory: root, profile: CursorNativeProfile, sourcePath }, request.signal), catch: safeFailure }).pipe(
    Effect.flatMap(value => Schema.decodeUnknownEffect(CreationReceiptAttempt)(value)),
    Effect.mapError(() => problem("attribution", "Cursor creation attempt could not be bound.")))
  let confirmed = false, deferred: Error | undefined
  const abandon = Effect.tryPromise({ try: () => request.creation.abandon(request.signal), catch: safeFailure })
  if (attempt.sourceId !== sourceId || attempt.adapterId !== "cursor" || attempt.stateDirectory !== root || attempt.sourcePath !== sourcePath ||
    attempt.profile !== CursorNativeProfile || attempt.origin.sourceId !== sourceId || attempt.origin.cwd !== cwd ||
    attempt.origin.repositoryRemote !== request.origin.repositoryRemote) {
    yield* abandon.pipe(Effect.ignore)
    return yield* problem("attribution", "Cursor creation attempt differs from its native launch.")
  }
  const read = (): Effect.Effect<CursorSourceSnapshot, CursorSourceError | CursorRuntimeError> => readCursorSource({ stateDirectory: root, sourceId, limits: cursorLimits() }).pipe(Effect.flatMap((snapshot): Effect.Effect<CursorSourceSnapshot, CursorSourceError | CursorRuntimeError> => {
    if (snapshot.source.transcriptPath !== sourcePath) return Effect.fail(problem("attribution", "Cursor transcript is outside its expected native locator."))
    if (snapshot.currentFullPrefix.rows === 0) return Effect.fail(new CursorSourceError({ reason: "missing", message: "Cursor has not written conversation evidence." }))
    return Effect.succeed(snapshot)
  }))
  const confirm = (snapshot: CursorSourceSnapshot) => Effect.uninterruptible(Effect.tryPromise({
    try: () => request.creation.confirm({ prefix: snapshot.currentFullPrefix }, request.signal), catch: safeFailure
  }).pipe(Effect.flatMap(value => Schema.decodeUnknownEffect(ConfirmedCreationReceipt)(value)), Effect.flatMap(receipt => {
    if (receipt.attemptId !== attempt.attemptId || receipt.adapterId !== attempt.adapterId || receipt.recordedAt !== attempt.recordedAt || receipt.sourceId !== sourceId || receipt.stateDirectory !== root || receipt.sourcePath !== sourcePath ||
      receipt.profile !== CursorNativeProfile || receipt.origin.originKey !== attempt.origin.originKey || receipt.origin.sourceId !== sourceId || receipt.origin.cwd !== cwd || receipt.origin.repositoryRemote !== attempt.origin.repositoryRemote ||
      receipt.prefix.bytes !== snapshot.currentFullPrefix.bytes || receipt.prefix.rows !== snapshot.currentFullPrefix.rows || receipt.prefix.sha256 !== snapshot.currentFullPrefix.sha256)
      return Effect.fail(problem("attribution", "Cursor confirmation differs from its frozen native evidence."))
    confirmed = true
    return Effect.void
  }), Effect.mapError(safeFailure)))
  const args = ["--disable-auto-update", "--new-session-id", sourceId, ...(request.initialPrompt === undefined ? [] : ["--", request.initialPrompt])]
  return yield* Effect.acquireUseRelease(Effect.try({ try: () => ownedChild(file, args, cwd, nativeEnvironment), catch: safeFailure }), owned => Effect.gen(function*() {
    const monitor = yield* Effect.forkScoped(Effect.gen(function*() {
      let delay = 250
      while (owned.outcome === undefined && !confirmed) {
        const snapshot = yield* read().pipe(Effect.catch(error => {
          if (temporary(error)) return Effect.succeed(undefined)
          deferred = safeFailure(error); return Effect.succeed(undefined)
        }))
        if (deferred) { yield* abandon.pipe(Effect.catch(error => { deferred ??= error; return Effect.void })); return }
        // An observed failed exit fences a read which completed late.
        if (snapshot !== undefined && owned.outcome === undefined) {
          yield* confirm(snapshot).pipe(Effect.catch(error => { deferred = error; return abandon.pipe(Effect.ignore) }))
          return
        }
        if (owned.outcome === undefined) yield* Effect.sleep(delay)
        delay = Math.min(delay * 2, 2000)
      }
    }))
    const outcome = yield* Effect.promise(() => owned.exit)
    yield* Fiber.interrupt(monitor)
    if (!confirmed && deferred === undefined && outcome.code === 0 && outcome.signal === null && !outcome.failed) {
      const snapshot = yield* read().pipe(Effect.catch(error => { if (!temporary(error)) deferred = safeFailure(error); return Effect.succeed(undefined) }))
      if (snapshot !== undefined) yield* confirm(snapshot).pipe(Effect.catch(error => { deferred = error; return Effect.void }))
    }
    if (!confirmed) yield* abandon.pipe(Effect.catch(error => { deferred ??= error; return Effect.void }))
    if (deferred !== undefined) return yield* Effect.fail(deferred)
    if (outcome.failed || outcome.signal !== null || outcome.code === null) return yield* problem("native", "Cursor native process did not exit normally.")
    return { sourceId, creation: confirmed ? "confirmed" as const : "unconfirmed" as const, exitCode: outcome.code }
  }), owned => Effect.promise(() => terminateAndJoin(owned))).pipe(
    Effect.onExit(() => confirmed ? Effect.void : abandon.pipe(Effect.ignore)))
})
