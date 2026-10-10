import { AdapterRuntimeError, type HostedSourceCapture } from "@atape/application"
import { SourceCaptureHeader, SourceCaptureHeaderV2, SourceCapturePriorThread, SourceCapturePage, SourceDiscoveryPage, SourceCaptureLimits, SourceProjectionLimits, SourceCaptureVersion, SourceCaptureVersion2,
  CanonicalProfileVersion3, type SourceCaptureRuntime, type SourceCaptureView } from "@atape/domain"
import { Effect, Schema } from "effect"

const failure = (adapterId: string, reason: AdapterRuntimeError["reason"], message: string) =>
  new AdapterRuntimeError({ adapterId, reason, retryable: reason === "collect", message })
const bounded = (value: unknown, bytes: number) => {
  const encoded = JSON.stringify(value)
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > bytes) throw new Error("source response exceeds admission")
}
/** Foreign package promises can finish after cancellation. Close a late view
 * instead of handing it to a caller whose Scope has already ended. */
const invoke = <A>(work: (signal: AbortSignal) => A | PromiseLike<A>, signal: AbortSignal, disposeLate?: (value: A) => Promise<unknown>) =>
  new Promise<A>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const abort = () => { reject(signal.reason) }
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(() => work(signal)).then(value => {
      signal.removeEventListener("abort", abort)
      if (signal.aborted) { if (disposeLate) void disposeLate(value).catch(() => process.emitWarning("An Adapter source view failed to close after cancellation.")); return }
      resolve(value)
    }, cause => { signal.removeEventListener("abort", abort); reject(cause) })
  })

export const hostSourceCapture = (adapterId: string, foreign: SourceCaptureRuntime, lifetime: AbortSignal): HostedSourceCapture => {
  const call = <A>(work: (signal: AbortSignal) => A | PromiseLike<A>, durationMs: number, disposeLate?: (value: A) => Promise<unknown>) => Effect.tryPromise({
    try: signal => invoke(work, AbortSignal.any([signal, lifetime, AbortSignal.timeout(Math.max(1, Math.ceil(durationMs)))]), disposeLate),
    catch: cause => {
      const reason = typeof cause === "object" && cause !== null && "reason" in cause ? cause.reason : undefined
      return typeof reason === "string" && ["format", "unsupported", "attribution", "limit", "closed", "changed"].includes(reason)
        ? new AdapterRuntimeError({ adapterId, reason: "contract", retryable: false,
          sourceFailureReason: reason === "limit" || reason === "attribution" || (reason === "unsupported" || reason === "changed") && foreign.protocolVersion === SourceCaptureVersion2 ? reason : "format",
          message: `Adapter source cannot be captured (${reason}).` })
        : failure(adapterId, "collect", "Adapter source operation failed, was canceled or exceeded its deadline.")
    }
  })
  const decode = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown, bytes: number) => Effect.try({ try: () => bounded(value, bytes),
    catch: () => failure(adapterId, "contract", "Adapter source response exceeds its byte bound.") }).pipe(
      Effect.flatMap(() => Schema.decodeUnknownEffect(schema)(value)),
      Effect.mapError(error => error instanceof AdapterRuntimeError ? error : failure(adapterId, "contract", "Adapter source response has an invalid shape.")))
  const limits = (value: SourceCaptureLimits) => Schema.decodeUnknownEffect(SourceCaptureLimits)(value).pipe(
    Effect.flatMap(value => value.pageBytes >= value.rowBytes ? Effect.succeed(value) : Effect.fail(new Error("page byte admission"))),
    Effect.mapError(() => failure(adapterId, "contract", "Source capture requires valid explicit admission.")))
  const discovery = (value: unknown, request: { readonly cursor: string | null }, admitted: SourceCaptureLimits) => Effect.gen(function*() {
    const page = yield* decode(SourceDiscoveryPage, value, admitted.pageBytes)
    if (page.sources.length > admitted.pageRows || !page.done && (page.cursor === null || page.cursor === request.cursor) || page.done && page.cursor !== null)
      return yield* failure(adapterId, "contract", "Adapter source discovery did not satisfy bounded cursor progress.")
    return page
  })
  return {
    protocolVersion: foreign.protocolVersion,
    ...(foreign.protocolVersion === SourceCaptureVersion2 && foreign.legacyMigration ? { legacyMigration: (request: Parameters<NonNullable<HostedSourceCapture["legacyMigration"]>>[0]) => Effect.gen(function*() {
      const admitted = yield* limits(request.limits)
      if (!request.checkpointCursor || Buffer.byteLength(request.checkpointCursor) > 1024 * 1024)
        return yield* failure(adapterId, "contract", "Legacy migration requires a bounded original checkpoint.")
      const value = yield* call(signal => foreign.legacyMigration!({ ...request, limits: admitted, signal }), admitted.durationMs)
      return yield* discovery(value, request, admitted)
    }) } : {}),
    discover: request => Effect.gen(function*() {
      const admitted = yield* limits(request.limits)
      const value = yield* call(signal => foreign.discover({ ...request, limits: admitted, signal }), admitted.durationMs)
      return yield* discovery(value, request, admitted)
    }),
    open: request => Effect.gen(function*() {
      const admitted = yield* limits(request.limits)
      const projection = yield* Schema.decodeUnknownEffect(SourceProjectionLimits)(request.projection).pipe(
        Effect.mapError(() => failure(adapterId, "contract", "Source projection requires valid explicit admission.")))
      yield* Effect.try({ try: () => bounded(request.priorThreads ?? [], 2 * 1024 * 1024), catch: () => failure(adapterId, "contract", "Prior Thread metadata exceeds its byte bound.") })
      const priorThreads = yield* Schema.decodeUnknownEffect(Schema.Array(SourceCapturePriorThread).check(Schema.isMaxLength(1000)))(request.priorThreads ?? []).pipe(
        Effect.mapError(() => failure(adapterId, "contract", "Source capture requires valid prior Thread metadata.")))
      for (const checkpoint of [request.priorCheckpoint, request.legacyCheckpoint]) if (checkpoint !== undefined && (!checkpoint || Buffer.byteLength(checkpoint) > 1024 * 1024))
        return yield* failure(adapterId, "contract", "Source checkpoint exceeds its opaque byte bound.")
      const deadline = performance.now() + admitted.durationMs
      let cleanup: Promise<unknown> | undefined
      const close = (view: SourceCaptureView) => cleanup ??= Promise.resolve().then(() => typeof view?.close === "function" ? view.close() : undefined)
      const release = (view: SourceCaptureView) => Effect.tryPromise({
        try: () => invoke(() => close(view), AbortSignal.timeout(Math.min(admitted.durationMs, 5000))),
        catch: () => failure(adapterId, "close", "Adapter source view failed to close.")
      }).pipe(Effect.catch(error => Effect.logWarning(error.message)))
      const view = yield* Effect.acquireRelease(call(signal => foreign.protocolVersion === SourceCaptureVersion2
        ? foreign.open({ ...request, priorThreads, limits: admitted, projection, signal })
        : foreign.open({ ...request, limits: admitted, projection, signal }), admitted.durationMs, close), release)
      if (typeof view?.read !== "function" || typeof view?.close !== "function")
        return yield* failure(adapterId, "contract", "Adapter source must return a readable closeable view.")
      const header = yield* decode(foreign.protocolVersion === SourceCaptureVersion2 ? SourceCaptureHeaderV2 : SourceCaptureHeader, view, projection.pageBytes)
      if (header.canonicalProfileVersion !== CanonicalProfileVersion3 && header.session.updatedAt === null)
        return yield* failure(adapterId, "contract", "Unknown source times require an explicit Canonical v3 profile.")
      if ("sourceCheckpoint" in header && Buffer.byteLength(header.sourceCheckpoint as string) > 1024 * 1024)
        return yield* failure(adapterId, "contract", "Source checkpoint exceeds its opaque byte bound.")
      if (header.origin.sourceId !== request.sourceId || header.session.sourceSessionId !== request.sourceId ||
        header.threads.length > admitted.threads || header.target.events > projection.events || header.target.usage > projection.usage)
        return yield* failure(adapterId, "contract", "Adapter source view differs from the requested scope or admission.")
      let closed = false, busy = false, finished = false
      yield* Effect.addFinalizer(() => Effect.sync(() => { closed = true }))
      return { ...header, read: () => Effect.acquireUseRelease(Effect.try({ try: () => {
        if (closed || busy || finished || performance.now() >= deadline) throw failure(adapterId, "contract", "Source view is closed, exhausted, busy or expired.")
        busy = true
      }, catch: cause => cause as AdapterRuntimeError }), () => call(signal => view.read(signal), deadline - performance.now()).pipe(
        Effect.flatMap(value => decode(SourceCapturePage, value, projection.pageBytes)),
        Effect.flatMap(page => {
          if (header.canonicalProfileVersion !== CanonicalProfileVersion3 && page.frames.some(frame => frame.events.some(event => event.occurredAt === null)))
            return Effect.fail(failure(adapterId, "contract", "Unknown source times require an explicit Canonical v3 profile."))
          if (page.frames.length > projection.pageItems || !page.done && page.frames.length === 0 || !request.rawEnabled && page.frames.some(frame => frame.raw !== undefined))
            return Effect.fail(failure(adapterId, "contract", "Adapter source frame page violates its admission or Raw policy."))
          finished = page.done
          return Effect.succeed(page)
        })
      ).pipe(Effect.onError(() => Effect.sync(() => { closed = true }).pipe(Effect.andThen(release(view))))), () => Effect.sync(() => { busy = false })) }
    })
  }
}

export const isSourceCaptureRuntime = (value: unknown): value is SourceCaptureRuntime => typeof value === "object" && value !== null &&
  "protocolVersion" in value && (value.protocolVersion === SourceCaptureVersion || value.protocolVersion === SourceCaptureVersion2) && "discover" in value && typeof value.discover === "function" &&
  "open" in value && typeof value.open === "function"
