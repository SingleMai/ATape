import { SourceCaptureVersion, type AdapterOpenContext, type SourceAdapterRuntime } from "@atape/domain"
import { Effect, Exit, Scope } from "effect"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { openOpenCodeCapture } from "./capture.ts"
import { discoverOpenCodeSources, OpenCodeSourceError } from "./source.ts"

const closed = () => new OpenCodeSourceError({ reason: "closed", message: "OpenCode source runtime is closed or already has an open view." })
/** SDK boundary for this local source. Effect owns all source resource lifetimes;
 * the foreign Interface exposes promises and AbortSignals without upload logic. */
export const createOpenCodeRuntime = async (options: { readonly path: string; readonly signal: AbortSignal }): Promise<SourceAdapterRuntime> => {
  const parent = await Effect.runPromise(Scope.make())
  const lifetime = new AbortController()
  let stopped = false, active = false
  const close = () => {
    stopped = true; lifetime.abort()
    options.signal.removeEventListener("abort", abort)
    return Effect.runPromise(Scope.close(parent, Exit.void))
  }
  const abort = () => { void close().catch(() => process.emitWarning("OpenCode source runtime failed to close after cancellation.")) }
  options.signal.addEventListener("abort", abort, { once: true })
  if (options.signal.aborted) await close()
  const run = <A, E>(effect: Effect.Effect<A, E>, signal: AbortSignal) => Effect.runPromise(effect, { signal: AbortSignal.any([signal, options.signal, lifetime.signal]) })
  return {
    close,
    sourceCapture: {
      protocolVersion: SourceCaptureVersion,
      discover: request => run(Effect.suspend(() => stopped ? Effect.fail(closed()) : discoverOpenCodeSources(options.path, request)), request.signal),
      open: request => run(Effect.uninterruptibleMask(restore => Effect.gen(function*() {
        if (stopped || active) return yield* closed()
        active = true
        const scope = yield* Scope.fork(parent)
        let disposed = false
        yield* Scope.addFinalizer(scope, Effect.sync(() => { active = false; disposed = true }))
        const view = yield* restore(openOpenCodeCapture({ path: options.path, sessionId: request.sourceId, rawEnabled: request.rawEnabled,
          limits: request.limits, projection: request.projection }).pipe(Scope.provide(scope))).pipe(
            Effect.onError(cause => Scope.close(scope, Exit.failCause(cause))))
        return { ...view,
          read: (signal: AbortSignal) => run(Effect.suspend(() => disposed || stopped ? Effect.fail(closed()) : view.read()), signal),
          close: () => Effect.runPromise(Scope.close(scope, Exit.void))
        }
      })), request.signal)
    }
  }
}

/** Matches the native stable-channel data location; OPENCODE_DB also supports a
 * named database relative to the native data directory. Other channel databases
 * require that explicit override. No directory, database or native process is created. */
export const createAtapeAdapter = (context: AdapterOpenContext & { readonly signal: AbortSignal }) => {
  const data = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode")
  const configured = process.env.OPENCODE_DB
  const path = configured ? isAbsolute(configured) || configured === ":memory:" ? configured : join(data, configured) : join(data, "opencode.db")
  return createOpenCodeRuntime({ path, signal: context.signal })
}
