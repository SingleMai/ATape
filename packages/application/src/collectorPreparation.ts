import type { AcpContentBlock, AcpSessionUpdate, AdapterCollectionPage } from "@atape/domain"
import { AdapterObservation, AdapterCollectionLimits, AdapterProtocolVersion, AdapterSourceFailure,
  MaxSourceFailures, isBoundedToolValue, ToolUpdateBytes } from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import { CollectionContractError, SecretRedactor } from "./collectorContracts.ts"
import { legacySecretRedactor, prepareCanonicalRedaction } from "./redaction.ts"

/** Compatibility for existing callers; production supplies a keyed compiled policy. */
export const makeSecretRedactorLayer = (secretValues: ReadonlyArray<string> = []) =>
  Layer.succeed(SecretRedactor, legacySecretRedactor(secretValues))

export const validatePage = (
  adapterId: string,
  requestCursor: string | null,
  page: AdapterCollectionPage
): Effect.Effect<void, CollectionContractError> => {
  const fail = (message: string) => contractFailure(adapterId, message)
  if (page.progress && [page.progress.sourceFiles, page.progress.pendingCanonicalSessions, page.progress.pendingRawBytes]
    .some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) return fail("returned invalid collection progress counters.")
  if ((page.sourceFailures?.length ?? 0) > MaxSourceFailures ||
    page.sourceFailures?.some(f => !Schema.is(AdapterSourceFailure)(f) || !boundedText(f.source, 4096, false))) {
    return fail("returned invalid or excessive source diagnostics.")
  }
  if (page.observations.length > AdapterCollectionLimits.observations) {
    return fail(`returned ${page.observations.length} observations; limit is ${AdapterCollectionLimits.observations}.`)
  }
  if (page.nextCursor !== null && (page.nextCursor.length === 0 || page.nextCursor.length > 1024 * 1024)) {
    return fail("returned an invalid next cursor.")
  }
  if (page.hasMore && (page.nextCursor === null || page.nextCursor === requestCursor)) {
    return fail("must advance a non-empty cursor when hasMore is true.")
  }
  if (page.observations.length > 0 && (page.nextCursor === null || page.nextCursor === requestCursor)) {
    return fail("must advance to a new committed cursor after emitting observations.")
  }
  const observations = new Set<string>()
  for (const observation of page.observations) {
    if (!boundedIdentity(observation.observationId, 200) || observations.has(observation.observationId)) {
      return fail(`returned an invalid or duplicate observation ID ${JSON.stringify(observation.observationId)}.`)
    }
    observations.add(observation.observationId)
    if (!validTimestamp(observation.observedAt) || !validTimestamp(observation.session.updatedAt)) {
      return fail(`observation ${observation.observationId} contains an invalid timestamp.`)
    }
    if (!boundedIdentity(observation.session.sourceSessionId, 500) ||
      !positiveInteger(observation.session.revision) ||
      !nonNegativeInteger(observation.session.reportedEventCount) ||
      !boundedText(observation.session.actor.name, 200, false) ||
      !boundedText(observation.session.actor.harness, 200, false) ||
      !boundedText(observation.session.title, 2_000, true) ||
      !boundedText(observation.session.summary, 2_000, true) ||
      !boundedText(observation.session.insight, 2_000, true) ||
      !boundedText(observation.session.branch, 2_000, true)) {
      return fail(`observation ${observation.observationId} contains invalid Session counters.`)
    }
    if (utf8Bytes(JSON.stringify({
      session: observation.session,
      threads: observation.threads,
      events: observation.events,
      usage: observation.usage
    })) > AdapterCollectionLimits.canonicalBytesPerObservation) {
      return fail(`observation ${observation.observationId} exceeds the Canonical byte limit.`)
    }
    if (observation.threads.length < 1 || observation.threads.length > AdapterCollectionLimits.threadsPerObservation) {
      return fail(`observation ${observation.observationId} has an invalid Thread count.`)
    }
    if (observation.events.length > AdapterCollectionLimits.eventsPerObservation ||
      observation.rawSegments.length > AdapterCollectionLimits.rawSegmentsPerObservation) {
      return fail(`observation ${observation.observationId} exceeds Event or Raw segment limits.`)
    }
    if (observation.rawSegments.reduce((bytes, segment) => bytes + utf8Bytes(segment.content), 0) >
      AdapterCollectionLimits.rawBytesPerObservation) {
      return fail(`observation ${observation.observationId} exceeds the aggregate Raw byte limit.`)
    }
    const threadIds = new Set(observation.threads.map((thread) => thread.sourceThreadId))
    const roots = observation.threads.filter((thread) => thread.parentSourceThreadId === undefined)
    if (threadIds.size !== observation.threads.length || roots.length !== 1 ||
      observation.threads.some((thread) => !boundedIdentity(thread.sourceThreadId, 500) ||
        !positiveInteger(thread.revision) || !boundedText(thread.label, 200, true) ||
        !boundedText(thread.summary, 2_000, true) ||
        (thread.parentSourceThreadId !== undefined &&
          (thread.parentSourceThreadId === thread.sourceThreadId || !threadIds.has(thread.parentSourceThreadId)))) ||
      hasThreadCycle(observation.threads)) {
      return fail(`observation ${observation.observationId} has an invalid Thread topology.`)
    }
    const eventIds = new Set<string>()
    const usageIds = new Set<string>()
    if ((observation.usage?.length ?? 0) > AdapterCollectionLimits.eventsPerObservation) {
      return fail(`observation ${observation.observationId} exceeds usage limits.`)
    }
    for (const usage of observation.usage ?? []) {
      const key = `${usage.sourceThreadId}\0${usage.sourceUsageId}`
      const counters = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]
      if (!boundedIdentity(usage.sourceUsageId, 500) || usageIds.has(key) ||
        !threadIds.has(usage.sourceThreadId) || !positiveInteger(usage.revision) ||
        !validTimestamp(usage.occurredAt) || !boundedText(usage.model, 200, true) ||
        counters.every(value => value === undefined) ||
        counters.some(value => value !== undefined && !nonNegativeInteger(value)) ||
        (usage.inputTokens !== undefined && (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > usage.inputTokens)) {
        return fail(`observation ${observation.observationId} contains invalid usage.`)
      }
      usageIds.add(key)
    }
    for (const event of observation.events) {
      const eventKey = `${event.sourceThreadId}\0${event.sourceEventId}`
      if (!boundedIdentity(event.sourceEventId, 500) || eventIds.has(eventKey) ||
        !threadIds.has(event.sourceThreadId) || !positiveInteger(event.revision) ||
        !positiveInteger(event.projectionRevision) || !nonNegativeInteger(event.sourceOrder) ||
        !nonNegativeInteger(event.eventIndex) || !validTimestamp(event.occurredAt) ||
        !validAcpUpdate(event.update) ||
        (event.childSourceThreadId !== undefined && !threadIds.has(event.childSourceThreadId)) ||
        (event.rawRef._tag === "object"
          ? !boundedIdentity(event.rawRef.sourceObjectId, 200) ||
            (event.rawRef.fragment !== undefined && !boundedText(event.rawRef.fragment, 1_500, true))
          : !boundedText(event.rawRef.reason, 1_000, false))) {
        return fail(`observation ${observation.observationId} contains an invalid Event.`)
      }
      eventIds.add(eventKey)
    }
    for (const segment of observation.rawSegments) {
      if (!boundedIdentity(segment.sourceObjectId, 200) || !boundedIdentity(segment.sourceGeneration, 200) ||
        !nonNegativeInteger(segment.sourceOffset) || utf8Bytes(segment.content) > AdapterCollectionLimits.rawSegmentBytes ||
        (segment.content.length === 0 && !segment.final) || !boundedText(segment.sourceName, 512, false) ||
        (!segment.final && !segment.content.endsWith("\n")) ||
        !boundedText(segment.mediaType, 512, false) || !supportedRawMediaType(segment.mediaType)) {
        return fail(`observation ${observation.observationId} contains an invalid Raw segment.`)
      }
    }
  }
  return Effect.void
}

/** Shared Host boundary for a bounded slice, including headers repeated across a
 * larger publication target. Validate before and after masking; never persist drafts. */
export const prepareCanonicalSlice = (adapterId: string, input: unknown) => Effect.gen(function*() {
  const redactor = yield* SecretRedactor
  const observation = yield* Schema.decodeUnknownEffect(AdapterObservation)(input).pipe(
    Effect.mapError(() => new CollectionContractError({ adapterId, message: "Canonical slice has an invalid Adapter shape." })))
  const page = (value: AdapterObservation) => ({ protocolVersion: AdapterProtocolVersion, nextCursor: "prepared", hasMore: false, observations: [value] })
  if (observation.rawSegments.length !== 0) return yield* contractFailure(adapterId, "must prepare Raw through its independent capture path.")
  yield* validatePage(adapterId, null, page(observation))
  const prepared = yield* prepareCanonicalRedaction(redactor, observation).pipe(
    Effect.mapError(() => new CollectionContractError({ adapterId, message: "Content cannot be safely redacted within its bounds." })))
  const result = { observation: prepared.value, replacements: prepared.replacements }
  yield* validatePage(adapterId, null, page(result.observation))
  return result
})

/** Mask a validated legacy observation and enforce limits on the emitted values. */
export const prepareCollectedObservation = (adapterId: string, observation: AdapterObservation) => Effect.gen(function*() {
  const redactor = yield* SecretRedactor
  const prepared = yield* prepareCanonicalRedaction(redactor, observation).pipe(
    Effect.mapError(() => new CollectionContractError({ adapterId, message: "Content cannot be safely redacted within its bounds." })))
  const result = { observation: prepared.value, replacements: prepared.replacements }
  if (!result.observation.events.every(event => validAcpUpdate(event.update))) {
    return yield* contractFailure(adapterId, "contains tool or content values exceeding limits after redaction.")
  }
  return result
})

export const contractFailure = (adapterId: string, message: string) =>
  Effect.fail(new CollectionContractError({ adapterId, message: `Adapter ${adapterId} ${message}` }))

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength
const positiveInteger = (value: number) => Number.isSafeInteger(value) && value >= 1
const nonNegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0
const validTimestamp = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  !Number.isNaN(Date.parse(value))
const boundedIdentity = (value: string, max: number) => value.trim() !== "" && utf8Bytes(value) <= max
const boundedText = (value: string, max: number, empty: boolean) =>
  (empty || value.trim() !== "") && utf8Bytes(value) <= max
const supportedRawMediaType = (value: string) => /^(?:text\/|application\/(?:json|x-ndjson|[A-Za-z0-9.+-]+\+json)$)/i.test(value)

const hasThreadCycle = (threads: AdapterObservation["threads"]) => {
  const parents = new Map(threads.map((thread) => [thread.sourceThreadId, thread.parentSourceThreadId]))
  for (const id of parents.keys()) {
    const seen = new Set<string>()
    let current: string | undefined = id
    while (current !== undefined) {
      if (seen.has(current)) return true
      seen.add(current)
      current = parents.get(current)
    }
  }
  return false
}


const validAcpUpdate = (update: AcpSessionUpdate) => {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return (update.messageId === undefined || update.messageId === null || boundedIdentity(update.messageId, 500)) &&
        validAcpContentBlock(update.content)
    case "tool_call":
      return validToolValues(update) && boundedIdentity(update.toolCallId, 500) && boundedText(update.title, 500, false)
    case "tool_call_update":
      return validToolValues(update) && boundedIdentity(update.toolCallId, 500) &&
        (update.title === undefined || update.title === null || boundedText(update.title, 500, true))
  }
}

const validToolValues = (update: Extract<AcpSessionUpdate, { toolCallId: string }>) =>
  (!Object.hasOwn(update, "rawInput") || isBoundedToolValue(update.rawInput)) &&
  (!Object.hasOwn(update, "rawOutput") || isBoundedToolValue(update.rawOutput)) &&
  utf8Bytes(JSON.stringify(update)) <= ToolUpdateBytes

const validAcpContentBlock = (content: AcpContentBlock) => {
  switch (content.type) {
    case "text":
      return boundedText(content.text, 1 << 20, false)
    case "image":
      return boundedText(content.mimeType, 200, false) &&
        (content.uri === undefined || content.uri === null || boundedText(content.uri, 2_000, false))
    case "audio":
      return boundedText(content.mimeType, 200, false)
    case "resource_link":
      return boundedText(content.name, 500, false) && boundedText(content.uri, 2_000, false)
    case "resource":
      return boundedText(content.resource.uri, 2_000, false) &&
        ("text" in content.resource ? boundedText(content.resource.text, 1 << 20, true) : true)
  }
}
