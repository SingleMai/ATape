import { SourceCaptureLimits, SourceCaptureVersion, SourceProjectionLimits, type AdapterOpenContext, type SourceAdapterRuntime, type SourceCaptureFrame } from "@atape/domain"
import { codeBuddyHome } from "@atape/adapter-catalog/node"
import { homedir } from "node:os"
import { Effect, Schema } from "effect"
import { discover, fail, snapshot, sourceError } from "./source.ts"
import { project } from "./projection.ts"

/** Foreign SDK binding; the Effect owns cancellation and typed source failures. */
export const createAtapeAdapter = async (context: AdapterOpenContext & { readonly signal: AbortSignal }): Promise<SourceAdapterRuntime> => {
  const home = codeBuddyHome(process.env, homedir()), lifetime = new AbortController()
  let stopped = false, active = false, release = () => {}
  const close = async () => { stopped = true; lifetime.abort(); release(); context.signal.removeEventListener("abort", abort) }
  const abort = () => { void close() }
  context.signal.addEventListener("abort", abort, { once: true })
  if (context.signal.aborted) await close()
  const run = <A>(f: (signal: AbortSignal) => Promise<A>, signal: AbortSignal) => Effect.runPromise(Effect.tryPromise({
    try: async signal => { if (stopped) fail("closed", "CodeBuddy runtime is closed."); return f(signal) }, catch: sourceError
  }), { signal: AbortSignal.any([signal, context.signal, lifetime.signal]) })
  return { close, sourceCapture: { protocolVersion: SourceCaptureVersion,
    discover: request => run(signal => discover(home, request.cursor, Schema.decodeUnknownSync(SourceCaptureLimits)(request.limits), signal), request.signal),
    open: request => run(async signal => {
      if (active) fail("closed", "CodeBuddy runtime already has an open view.")
      active = true
      try {
        const limits = Schema.decodeUnknownSync(SourceCaptureLimits)(request.limits), projection = Schema.decodeUnknownSync(SourceProjectionLimits)(request.projection)
        const source = await snapshot(home, request.sourceId, limits, signal)
        const planned = project(source, { ...request, limits, projection, signal })
        let frames: ReadonlyArray<SourceCaptureFrame> = planned.frames, at = 0, disposed = false
        const dispose = () => { if (disposed) return; disposed = true; frames = []; active = false }
        release = dispose
        const started = performance.now()
        return { ...planned.header,
          read: (signal: AbortSignal) => run(async signal => {
            if (disposed) fail("closed", "CodeBuddy view is closed.")
            if (performance.now() - started > limits.durationMs) fail("limit", "CodeBuddy view exceeded its deadline.")
            const page: SourceCaptureFrame[] = []
            let bytes = Buffer.byteLength(JSON.stringify({ frames: [], done: false }))
            while (at < frames.length && page.length < projection.pageItems) {
              signal.throwIfAborted()
              const frame = frames[at]!, size = Buffer.byteLength(JSON.stringify(frame)) + (page.length ? 1 : 0)
              if (bytes + size > projection.pageBytes) break
              page.push(frame); bytes += size; at++
            }
            return { frames: page, done: at === frames.length }
          }, signal),
          close: async () => { dispose() }
        }
      } catch (e) { active = false; throw e }
    }, request.signal)
  } }
}
