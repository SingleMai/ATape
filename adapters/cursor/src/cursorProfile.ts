import { cursorConfigHome, cursorDataHome } from "@atape/adapter-catalog/node"
import { lstat, mkdir, realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { homedir } from "node:os"
import { Effect, Schema } from "effect"
import { CursorSourceError, type CursorSourceLimits } from "./cursorSource.ts"
import type { SourceCaptureLimits } from "@atape/domain"

export const CursorNativeVersion = "2026.10.01-e373342"
export const CursorNativeProfile = "cursor.cli.jsonl.2026-10-01.v1"
export class CursorRuntimeError extends Schema.TaggedError<CursorRuntimeError>()("CursorRuntimeError", {
  reason: Schema.Literals(["unsupported", "attribution", "closed", "native", "io", "limit", "format", "changed"]), message: Schema.String
}) {}
export const problem = (reason: CursorRuntimeError["reason"], message: string) => new CursorRuntimeError({ reason, message })
const io = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: () => problem("io", "Cursor native storage operation failed.") })
const optional = (path: string) => Effect.tryPromise({ try: () => lstat(path), catch: cause => cause }).pipe(Effect.catch(cause =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT" ? Effect.succeed(undefined) : Effect.fail(problem("io", "Cursor native root could not be inspected."))))

/** Missing identical roots are an idle source, never a reason to initialize them. */
export const cursorRoot = (environment: NodeJS.ProcessEnv, initialize = false) => Effect.gen(function*() {
  const config = cursorConfigHome(environment, homedir()), data = cursorDataHome(environment, homedir())
  if (![config, data].every(path => isAbsolute(path) && !path.includes("\0") && Buffer.byteLength(path) <= 4096))
    return yield* problem("unsupported", "Cursor requires absolute native state roots.")
  const a = resolve(config), b = resolve(data)
  let ca = yield* optional(a), cb = a === b ? ca : yield* optional(b)
  if (ca === undefined || cb === undefined) {
    if (a !== b) return yield* problem("unsupported", "Cursor split native roots are unsupported.")
    if (!initialize) return a
    yield* io(() => mkdir(a, { mode: 0o700 }).catch(cause => { if (cause?.code !== "EEXIST") throw cause }))
    ca = yield* optional(a); cb = ca
  }
  if (!ca?.isDirectory() || !cb?.isDirectory() || ca.isSymbolicLink() || cb.isSymbolicLink())
    return yield* problem("unsupported", "Cursor native state root must be a real directory.")
  const ar = yield* io(() => realpath(a)), br = a === b ? ar : yield* io(() => realpath(b))
  if (ar !== br) return yield* problem("unsupported", "Cursor split native roots are unsupported.")
  return ar
})
export const cursorLimits = (limits?: SourceCaptureLimits): CursorSourceLimits => ({
  inventoryEntries: 100_000, pageSources: Math.min(limits?.pageRows ?? 100, 100), rowBytes: Math.min(limits?.rowBytes ?? 1024 * 1024, 1024 * 1024),
  sourceBytes: 64 * 1024 * 1024, records: Math.min(limits?.records ?? 100_000, 100_000), subagents: 1000,
  durationMs: Math.min(limits?.durationMs ?? 120_000, 120_000)
})
export const workspaceSlug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")
export const sourceProblem = (cause: unknown) => cause instanceof CursorSourceError && cause.reason === "incomplete"
  ? problem("changed", "Cursor source has an incomplete trailing record.") : cause
