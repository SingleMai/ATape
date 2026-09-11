import type { AcpContentBlock, AcpSessionUpdate, AdapterCollectionPage } from "@atape/domain"
import { AdapterObservation, AdapterCollectionLimits, AdapterProtocolVersion, AdapterSourceFailure,
  MaxSourceFailures, isBoundedToolValue, ToolUpdateBytes } from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import { CollectionContractError, SecretRedactor, type SecretRedactorService, type RedactedText } from "./collectorContracts.ts"

export const makeSecretRedactorLayer = (secretValues: ReadonlyArray<string> = []) => {
  const values = [...new Set(secretValues.filter((value) => value.length >= 8 && value.length <= 4_096))]
    .sort((left, right) => right.length - left.length)
  return Layer.succeed(SecretRedactor, SecretRedactor.of({
    redact: (input) => redactText(input, values)
  }))
}

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
  const result = redactObservation(redactor, observation)
  yield* validatePage(adapterId, null, page(result.observation))
  return result
})

/** Mask a validated legacy observation and enforce limits on the emitted values. */
export const prepareCollectedObservation = (adapterId: string, observation: AdapterObservation) => Effect.gen(function*() {
  const redactor = yield* SecretRedactor
  const result = redactObservation(redactor, observation)
  if (!result.observation.events.every(event => validAcpUpdate(event.update))) {
    return yield* contractFailure(adapterId, "contains tool or content values exceeding limits after redaction.")
  }
  return result
})

const redactObservation = (redactor: SecretRedactorService, observation: AdapterObservation) => {
  let replacements = 0
  const redact = (value: string) => {
    const result = redactor.redact(value)
    replacements += result.replacements
    return result.value
  }
  const events = observation.events.map((event) => {
    const before = replacements
    const update = redactAcpUpdate(event.update, redact)
    const rawRef = event.rawRef._tag === "object"
      ? {
          ...event.rawRef,
          ...(event.rawRef.fragment === undefined ? {} : { fragment: redact(event.rawRef.fragment) })
        }
      : { ...event.rawRef, reason: redact(event.rawRef.reason) }
    return {
      ...event,
      update,
      rawRef,
      fidelity: replacements > before ? "redacted" as const : event.fidelity
    }
  })
  const redacted: AdapterObservation = {
    ...observation,
    session: {
      ...observation.session,
      title: redact(observation.session.title),
      summary: redact(observation.session.summary),
      insight: redact(observation.session.insight),
      actor: {
        name: redact(observation.session.actor.name),
        harness: redact(observation.session.actor.harness)
      },
      branch: redact(observation.session.branch)
    },
    threads: observation.threads.map((thread) => ({
      ...thread,
      label: redact(thread.label),
      summary: redact(thread.summary)
    })),
    events,
    ...(observation.usage === undefined ? {} : { usage: observation.usage.map(sample => ({ ...sample, model: redact(sample.model) })) }),
    rawSegments: observation.rawSegments.map((segment) => ({
      ...segment,
      sourceName: redact(segment.sourceName),
      content: redact(segment.content)
    }))
  }
  return { observation: redacted, replacements }
}

const redactText = (input: string, secretValues: ReadonlyArray<string>): RedactedText => {
  let value = input
  let replacements = 0
  const replace = (pattern: RegExp, replacement: string | ((...values: Array<string>) => string)) => {
    value = value.replace(pattern, (...args: Array<string>) => {
      replacements++
      return typeof replacement === "string" ? replacement : replacement(...args)
    })
  }
  replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_match, label: string) => `${label} [REDACTED]`)
  replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED]")
  replace(
    /(["']?)(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\b)\1(\s*[:=]\s*)(["']?)[^\s,"'}]{8,}\4/gi,
    (_match, keyQuote: string, key: string, separator: string, valueQuote: string) =>
      `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}`
  )
  replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
  for (const secret of secretValues) {
    replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]")
  }
  return { value, replacements }
}

export const contractFailure = (adapterId: string, message: string) =>
  Effect.fail(new CollectionContractError({ adapterId, message: `Adapter ${adapterId} ${message}` }))

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength
const boundedRedactedTitle = (value: string) => {
  let bytes = 0
  let title = ""
  for (const character of value) {
    bytes += utf8Bytes(character)
    if (bytes > 500) break
    title += character
  }
  return title
}
const positiveInteger = (value: number) => Number.isSafeInteger(value) && value >= 1
const nonNegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0
const validTimestamp = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  !Number.isNaN(Date.parse(value))
const boundedIdentity = (value: string, max: number) => value.trim() !== "" && utf8Bytes(value) <= max
const boundedText = (value: string, max: number, empty: boolean) =>
  (empty || value.trim() !== "") && utf8Bytes(value) <= max
const supportedRawMediaType = (value: string) => /^(?:text\/|application\/(?:json|x-ndjson|[A-Za-z0-9.+-]+\+json)$)/i.test(value)
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

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

const redactAcpUpdate = (
  update: AcpSessionUpdate,
  redact: (value: string) => string
): AcpSessionUpdate => {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return { ...update, content: redactAcpContentBlock(update.content, redact) }
    case "tool_call":
      return { ...update, ...redactToolValues(update, redact), title: boundedRedactedTitle(redact(update.title)) }
    case "tool_call_update":
      return {
        ...update,
        ...redactToolValues(update, redact),
        ...(typeof update.title === "string" ? { title: boundedRedactedTitle(redact(update.title)) } : {})
      }
  }
}

const redactToolValues = (update: Extract<AcpSessionUpdate, { toolCallId: string }>, redact: (value: string) => string) => {
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value)
    if (typeof value === "number") {
      const text = JSON.stringify(value), masked = redact(text)
      return text === masked ? value : masked
    }
    if (Array.isArray(value)) return value.map(visit)
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value).map(([key, item]) => [redact(key), visit(item)] as const)
      // Redacted keys may collide. Do not silently overwrite one value with another.
      return new Set(entries.map(([key]) => key)).size === entries.length ? Object.fromEntries(entries) : "[REDACTED]"
    }
    return value
  }
  const value = (input: unknown): unknown => {
    // Also apply contextual patterns such as {"password":"..."}. If masking
    // breaks JSON, omit the whole value rather than leaking or coercing it.
    const masked = redact(JSON.stringify(visit(input)))
    try { return JSON.parse(masked) }
    catch { return "[REDACTED]" }
  }
  return {
    ...(Object.hasOwn(update, "rawInput") ? { rawInput: value(update.rawInput) } : {}),
    ...(Object.hasOwn(update, "rawOutput") ? { rawOutput: value(update.rawOutput) } : {})
  }
}

const redactAcpContentBlock = (
  content: AcpContentBlock,
  redact: (value: string) => string
): AcpContentBlock => {
  switch (content.type) {
    case "text":
      return { ...content, text: redact(content.text) }
    case "image":
      return {
        ...content,
        ...(typeof content.uri === "string" ? { uri: redact(content.uri) } : {})
      }
    case "audio":
      return content
    case "resource_link":
      return {
        ...content,
        name: redact(content.name),
        uri: redact(content.uri),
        ...(typeof content.title === "string" ? { title: redact(content.title) } : {}),
        ...(typeof content.description === "string" ? { description: redact(content.description) } : {})
      }
    case "resource":
      return {
        ...content,
        resource: "text" in content.resource
          ? { ...content.resource, uri: redact(content.resource.uri), text: redact(content.resource.text) }
          : { ...content.resource, uri: redact(content.resource.uri) }
      }
  }
}
