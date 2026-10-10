import { NewSessionVersion, SourceCaptureVersion2, type AdapterOpenContext, type SourceAdapterRuntime, type SourceCaptureRuntimeV2, type NewSessionRuntime } from "@atape/domain"
import { Effect } from "effect"
import { discover, openCapture } from "./capture.ts"
import { problem, sourceProblem } from "./cursorProfile.ts"
import { startNativeSession } from "./newSession.ts"

/** Foreign SDK binding. The factory owns all view/process operations until close. */
export const createAtapeAdapter = async (context: AdapterOpenContext & { readonly signal: AbortSignal }): Promise<SourceAdapterRuntime<SourceCaptureRuntimeV2> & { readonly newSession: NewSessionRuntime }> => {
  if (!context.creationReceipts) throw problem("unsupported", "Cursor requires a Host with creation receipts.")
  const environment = { ...process.env }, lifetime = new AbortController(), operations = new Set<Promise<unknown>>()
  let stopped = false, activeView = false, activeStart = false, release: (() => Promise<void>) | undefined, closing: Promise<void> | undefined
  const combined = (signal: AbortSignal) => AbortSignal.any([signal, context.signal, lifetime.signal])
  const run = <A, E, R extends never>(effect: Effect.Effect<A, E, R>, signal: AbortSignal): Promise<A> => {
    if (stopped) return Promise.reject(problem("closed", "Cursor runtime is closed."))
    const operationSignal = combined(signal)
    if (operationSignal.aborted) return Promise.reject(new DOMException("Cursor operation cancelled.", "AbortError"))
    const operation = Effect.runPromise(effect.pipe(Effect.mapError(sourceProblem)), { signal: operationSignal })
    operations.add(operation)
    void operation.then(() => operations.delete(operation), () => operations.delete(operation))
    return operation
  }
  const close = () => closing ??= (async () => {
    stopped = true; lifetime.abort(); await release?.()
    await Promise.allSettled([...operations]); context.signal.removeEventListener("abort", abort)
  })()
  const abort = () => { void close() }
  context.signal.addEventListener("abort", abort, { once: true })
  if (context.signal.aborted) await close()
  return { close, newSession: { protocolVersion: NewSessionVersion, start: request => {
    if (activeStart) return Promise.reject(problem("closed", "Cursor already has an active native session."))
    activeStart = true
    const signal = combined(request.signal)
    return run(Effect.scoped(startNativeSession(environment, { ...request, signal })), signal).finally(() => { activeStart = false })
  } }, sourceCapture: { protocolVersion: SourceCaptureVersion2,
    discover: request => { const signal = combined(request.signal); return run(discover(context, environment, { ...request, signal }), signal) },
    open: async request => {
      if (activeView) throw problem("closed", "Cursor already has an open source view.")
      activeView = true
      try {
        const signal = combined(request.signal), planned = await run(openCapture(context, environment, { ...request, signal }), signal)
        if (stopped || signal.aborted) throw problem("closed", "Cursor runtime is closed.")
        let frames = planned.frames, at = 0, disposed = false
        const deadline = performance.now() + request.limits.durationMs
        const dispose = async () => { if (disposed) return; disposed = true; frames = []; activeView = false; release = undefined }
        release = dispose
        return { ...planned.header, close: dispose, read: (signal: AbortSignal) => run(Effect.try({ try: () => {
          if (disposed) throw problem("closed", "Cursor source view is closed.")
          if (performance.now() > deadline) throw problem("limit", "Cursor source view exceeded its operation deadline.")
          const page: typeof frames = []
          const maxFrames = Math.min(request.limits.pageRows, request.projection.pageItems, 100), maxBytes = Math.min(request.limits.pageBytes, request.projection.pageBytes)
          while (at < frames.length && page.length < maxFrames) {
            const next = [...page, frames[at]!]
            if (Buffer.byteLength(JSON.stringify({ frames: next, done: at + 1 === frames.length })) > maxBytes) {
              if (page.length === 0) throw problem("limit", "Cursor frame exceeds its page byte bound.")
              break
            }
            page.push(frames[at++]!)
          }
          return { frames: page, done: at === frames.length }
        }, catch: cause => cause }), signal) }
      } catch (cause) { activeView = false; throw cause }
    }
  } }
}
