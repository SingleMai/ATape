import { SourceCaptureVersion2, type AdapterOpenContext, type SourceAdapterRuntime } from "@atape/domain"
import { Effect } from "effect"
import { discoverClaudeSources, migrateClaudeSources, openClaudeArchive, openClaudeCapture } from "./claudeArchive.ts"

export const createAtapeAdapter = async (
  context: AdapterOpenContext & { readonly signal: AbortSignal }
): Promise<SourceAdapterRuntime<import("@atape/domain").SourceCaptureRuntimeV2>> => {
  const archive = await Effect.runPromise(openClaudeArchive(context), { signal: context.signal })
  const lifetime = new AbortController()
  let stopped = false, active = false, release: (() => Promise<unknown>) | undefined
  const close = async () => { stopped = true; lifetime.abort(); await release?.(); context.signal.removeEventListener("abort", abort) }
  const abort = () => { void close().catch(() => process.emitWarning("Claude source view failed to close after cancellation.")) }
  context.signal.addEventListener("abort", abort, { once: true })
  if (context.signal.aborted) await close()
  const signal = (request: AbortSignal) => AbortSignal.any([context.signal, lifetime.signal, request])
  return {
    close,
    sourceCapture: {
      protocolVersion: SourceCaptureVersion2,
      discover: request => {
        if (stopped) throw new Error("Claude runtime is closed.")
        return Effect.runPromise(discoverClaudeSources(archive, { ...request, signal: signal(request.signal) }), { signal: signal(request.signal) })
      },
      legacyMigration: request => {
        if (stopped) throw new Error("Claude runtime is closed.")
        return Effect.runPromise(migrateClaudeSources(request), { signal: signal(request.signal) })
      },
      open: async request => {
        if (stopped || active) throw new Error("Claude runtime is closed or already has an open view.")
        active = true
        try {
          const view = await Effect.runPromise(openClaudeCapture(archive, { ...request, signal: signal(request.signal) }), { signal: signal(request.signal) })
          let disposed = false
          const dispose = async () => { if (disposed) return; disposed = true; await view.close(); active = false; release = undefined }
          release = dispose
          return { ...view, close: dispose, read: (request: AbortSignal) => {
            if (disposed || stopped) throw new Error("Claude source view is closed.")
            return view.read(signal(request))
          } }
        } catch (cause) { active = false; throw cause }
      }
    }
  }
}
