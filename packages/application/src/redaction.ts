import type { AcpContentBlock, AcpSessionUpdate } from "@atape/domain"
import { AdapterObservation, ToolUpdateBytes } from "@atape/domain"
import { Effect, Layer, Schema } from "effect"
import { SecretRedactor, type RedactedText, type SecretRedactorService } from "./collectorContracts.ts"
import { ContentBytes, createEngine, report, stats, UnsafeRedaction, type Engine, type Report } from "./redaction/engine.ts"

export type RedactionPattern = { readonly name: string; readonly type: string; readonly pattern?: string;
  readonly field_pattern?: string; readonly capture_group?: number }
export type RedactionConfiguration = { readonly patterns?: ReadonlyArray<RedactionPattern> }
export type RedactionStats = { readonly matches: number; readonly rules: ReadonlyArray<{ readonly id: string; readonly type: string; readonly matches: number }> }
export type RedactionResult<A> = { readonly value: A; readonly replacements: number; readonly stats: RedactionStats }
export type RawRedactionResult = { readonly row: unknown; readonly replacements: number; readonly stats: RedactionStats } | { readonly gap: "limit" | "redaction" }
export class RedactionPolicyError extends Schema.TaggedError<RedactionPolicyError>()("RedactionPolicyError", {
  reason: Schema.Literals(["configuration", "key", "engine"]), message: Schema.String
}) {}
export class RedactionError extends Schema.TaggedError<RedactionError>()("RedactionError", {
  reason: Schema.Literals(["limit", "redaction"]), message: Schema.String
}) {}
export type CompiledRedactionPolicy = {
  readonly policyId: string
  readonly prepareText: (input: string) => Effect.Effect<RedactionResult<string>, RedactionError>
  readonly prepareFile: (input: { readonly content: string; readonly format: "text" | "json" | "jsonl" }) => Effect.Effect<RedactionResult<string>, RedactionError>
  readonly prepareCanonical: (input: AdapterObservation) => Effect.Effect<RedactionResult<AdapterObservation>, RedactionError>
  readonly prepareRaw: (input: unknown) => RawRedactionResult
  readonly prepareDiagnostic: (input: string) => RedactedText
}
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength
const changedJson = (source: string, value: unknown) => `${/^\s*/.exec(source)?.[0] ?? ""}${JSON.stringify(value)}${/\s*$/.exec(source)?.[0] ?? ""}`
const policyFailure = (reason: RedactionPolicyError["reason"]) => new RedactionPolicyError({ reason, message: "Redaction policy is invalid or exceeds its admitted limits." })
const contentFailure = (cause: unknown) => new RedactionError({ reason: cause instanceof UnsafeRedaction ? cause.reason : "redaction", message: "Content cannot be safely redacted." })
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

export const validateRedactionConfiguration = (input: unknown): Effect.Effect<RedactionConfiguration, RedactionPolicyError> => Effect.try({
  try: () => {
    if (typeof input === "string") {
      if (byteLength(input) > 128 * 1024) throw policyFailure("configuration")
      let tokens = 0
      checkJson(input, 0, () => { if (++tokens > 10_000) throw policyFailure("configuration") })
      input = JSON.parse(input)
    }
    if (!isObject(input) || Object.keys(input).some(key => key !== "patterns") || input.patterns !== undefined && !Array.isArray(input.patterns)) throw policyFailure("configuration")
    const patterns = (input.patterns ?? []) as unknown[]
    if (patterns.length > 128) throw policyFailure("configuration")
    let totalBytes = 0
    const normalized = patterns.map(value => {
      if (!isObject(value) || Object.keys(value).some(key => !["name", "type", "pattern", "field_pattern", "capture_group"].includes(key)) ||
        typeof value.name !== "string" || !value.name.trim() || byteLength(value.name) > 100 || /[\x00-\x1f\x7f]/.test(value.name) ||
        typeof value.type !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(value.type)) throw policyFailure("configuration")
      for (const key of ["pattern", "field_pattern"]) if (value[key] !== undefined &&
        (typeof value[key] !== "string" || !value[key] || byteLength(value[key] as string) > 2048)) throw policyFailure("configuration")
      if (!value.pattern && !value.field_pattern || value.capture_group !== undefined &&
        (!Number.isSafeInteger(value.capture_group) || (value.capture_group as number) < 0 || (value.capture_group as number) > 100 || !value.pattern)) throw policyFailure("configuration")
      totalBytes += byteLength((value.pattern ?? "") as string) + byteLength((value.field_pattern ?? "") as string)
      if (totalBytes > 64 * 1024) throw policyFailure("configuration")
      return Object.freeze({ name: value.name, type: value.type,
        ...(value.pattern === undefined ? {} : { pattern: value.pattern as string }),
        ...(value.field_pattern === undefined ? {} : { field_pattern: value.field_pattern as string }),
        ...(value.capture_group === undefined ? {} : { capture_group: value.capture_group as number }) })
    })
    return Object.freeze({ patterns: Object.freeze(normalized) })
  }, catch: () => policyFailure("configuration")
})

/** The installation key never enters the policy object or serialized report. */
export const compileRedactionPolicy = (input: { readonly configuration?: unknown; readonly secretValues?: ReadonlyArray<string>; readonly installationKey: Uint8Array }):
  Effect.Effect<CompiledRedactionPolicy, RedactionPolicyError> => Effect.gen(function*() {
    const configuration = yield* validateRedactionConfiguration(input.configuration ?? {})
    if (!(input.installationKey instanceof Uint8Array) || input.installationKey.byteLength !== 32) return yield* Effect.fail(policyFailure("key"))
    const literals = yield* Effect.try({ try: () => {
      if (input.secretValues !== undefined && !Array.isArray(input.secretValues)) throw policyFailure("configuration")
      const values = input.secretValues ?? []
      if (values.some(value => typeof value !== "string" || value.length < 8 || value.length > 4096)) throw policyFailure("configuration")
      const normalized = [...new Set(values)].sort()
      if (normalized.length > 2048 || normalized.reduce((size, value) => size + byteLength(value), 0) > 1024 * 1024) throw policyFailure("configuration")
      return normalized
    }, catch: () => policyFailure("configuration") })
    const engine = yield* Effect.try({ try: () => createEngine(configuration.patterns ?? [], literals), catch: () => policyFailure("engine") })
    const policyId = yield* Effect.tryPromise({ try: async () => {
      const key = await globalThis.crypto.subtle.importKey("raw", new Uint8Array(input.installationKey).buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      const material = JSON.stringify(["atape.redaction.v1", "re2js@2.8.6", "confab@8082a7a", configuration, literals])
      const signature = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(material))
      return `redaction_v1_${Array.from(new Uint8Array(signature), value => value.toString(16).padStart(2, "0")).join("")}`
    }, catch: () => policyFailure("key") })
    return makePolicy(engine, policyId)
  })

/** Duplicate decoded keys must be detected before JSON.parse discards members. */
const checkJson = (text: string, depth: number, chargeNode: () => void) => {
  const stack: Array<{ keys: Set<string> | null; key: boolean }> = []
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g
  for (const token of text.matchAll(tokens)) {
    chargeNode()
    const value = token[0], current = stack[stack.length - 1]
    if (value === "{" || value === "[") {
      if (stack.length + depth >= 32) throw new UnsafeRedaction("limit")
      stack.push({ keys: value === "{" ? new Set() : null, key: true })
    } else if (value === "}" || value === "]") stack.pop()
    else if (value === "," && current) current.key = true
    else if (value.startsWith('"') && current?.keys && current.key) {
      const key = JSON.parse(value) as string
      if (current.keys.has(key)) throw new UnsafeRedaction("redaction")
      current.keys.add(key); current.key = false
    }
  }
}
const traversal = (engine: Engine, output: Report) => {
  let nodes = 0, bytes = 0
  const chargeNode = () => { if (++nodes > 100_000) throw new UnsafeRedaction("limit") }
  const charge = (text: string) => { bytes += byteLength(text); if (bytes > ContentBytes) throw new UnsafeRedaction("limit") }
  const parse = (text: string, depth = 0): unknown => {
    charge(text)
    checkJson(text, depth, chargeNode)
    return JSON.parse(text)
  }
  const walk = (value: unknown, depth = 0, fieldName?: string): { value: unknown; changed: boolean } => {
    chargeNode()
    if (depth > 32) throw new UnsafeRedaction("limit")
    if (value === null || typeof value === "boolean") return { value, changed: false }
    if (typeof value === "number" && Number.isFinite(value)) {
      const source = JSON.stringify(value), masked = engine.text(source, output, fieldName)
      return { value: masked === source ? value : masked, changed: masked !== source }
    }
    if (typeof value === "string") {
      charge(value)
      let text = value
      if (/^\s*[\[{"]/.test(text)) {
        let parsed: unknown, valid = false
        try { parsed = JSON.parse(text); valid = true } catch { /* ordinary text */ }
        if (valid) {
          checkJson(text, depth, chargeNode)
          const nested = walk(parsed, depth + 1, fieldName)
          if (nested.changed) text = changedJson(text, nested.value)
        }
      }
      text = engine.text(text, output, fieldName)
      return { value: text, changed: text !== value }
    }
    if (!Array.isArray(value) && !isObject(value)) throw new UnsafeRedaction("redaction")
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null)
    let changed = false
    for (const [key, child] of Object.entries(value)) {
      charge(key)
      const maskedKey = Array.isArray(value) ? key : engine.text(key, output)
      if (Object.hasOwn(result, maskedKey)) throw new UnsafeRedaction("redaction")
      const nested = walk(child, depth + 1, Array.isArray(value) ? fieldName : key)
      Object.defineProperty(result, maskedKey, { value: nested.value, enumerable: true, configurable: true, writable: true })
      changed ||= key !== maskedKey || nested.changed
    }
    return { value: result, changed }
  }
  return { walk, parse }
}
const prepared = <A>(value: A, output: Report): RedactionResult<A> => ({ value, replacements: output.matches, stats: stats(output) })

const makePolicy = (engine: Engine, policyId: string): CompiledRedactionPolicy => {
  const run = <A>(operation: (output: Report) => A) => Effect.try({ try: () => { const output = report(); return prepared(operation(output), output) }, catch: contentFailure })
  const prepareText = (input: string) => run(output => engine.text(input, output))
  const prepareFile: CompiledRedactionPolicy["prepareFile"] = input => run(output => {
    if (typeof input.content !== "string" || byteLength(input.content) > ContentBytes) throw new UnsafeRedaction("limit")
    if (input.format === "text") return engine.text(input.content, output)
    const visitor = traversal(engine, output)
    const json = (text: string) => {
      const source = visitor.parse(text), masked = visitor.walk(source)
      return masked.changed ? changedJson(text, masked.value) : text
    }
    if (input.format === "json") return json(input.content)
    if (input.format !== "jsonl") throw new UnsafeRedaction("redaction")
    return input.content.split("\n").map(line => line.trim() ? json(line) : line).join("\n")
  })
  const prepareRaw: CompiledRedactionPolicy["prepareRaw"] = input => {
    try {
      if (!isObject(input)) throw new UnsafeRedaction("redaction")
      const output = report(), masked = traversal(engine, output).walk(input)
      return { row: masked.value, replacements: output.matches, stats: stats(output) }
    } catch (cause) { return { gap: contentFailure(cause).reason } }
  }
  const prepareDiagnostic = (input: string): RedactedText => {
    try { const output = report(), value = engine.text(input, output); return { value, replacements: output.matches } }
    catch { return { value: "[REDACTED DIAGNOSTIC]", replacements: 1 } }
  }
  return Object.freeze({ policyId, prepareText, prepareFile, prepareRaw, prepareDiagnostic,
    prepareCanonical: (input: AdapterObservation) => run(output => canonical(input, engine, output)) })
}
export const secretRedactorForPolicy = (policy: CompiledRedactionPolicy): SecretRedactorService => Object.freeze({
  policyId: policy.policyId, policy, redact: policy.prepareDiagnostic, redactDiagnostic: policy.prepareDiagnostic
})
export const makeRedactionLayer = (policy: CompiledRedactionPolicy) => Layer.succeed(SecretRedactor, secretRedactorForPolicy(policy))
export const legacySecretRedactor = (values: ReadonlyArray<string> = []): SecretRedactorService => {
  const literals = [...new Set(values.filter(value => value.length >= 8 && value.length <= 4096))]
  const policy = makePolicy(createEngine([], literals), "compatibility-only")
  return Object.freeze({ policy, redact: policy.prepareDiagnostic, redactDiagnostic: policy.prepareDiagnostic })
}

/** Transitional hand-written Layers retain their existing text policy; all field
 * selection and JSON safety still lives in this Module. */
const compatibleEngine = (redactor: SecretRedactorService): Engine => ({ text: (value, output) => {
  const result = redactor.redact(value)
  output.matches += result.replacements
  if (output.matches > 10_000) throw new UnsafeRedaction("limit")
  return result.value
} })
export const prepareCanonicalRedaction = (redactor: SecretRedactorService, input: AdapterObservation) => redactor.policy?.prepareCanonical(input) ??
  Effect.try({ try: () => { const output = report(); return prepared(canonical(input, compatibleEngine(redactor), output), output) }, catch: contentFailure })
export const prepareRawRedaction = (redactor: SecretRedactorService, input: unknown): RawRedactionResult => {
  if (redactor.policy) return redactor.policy.prepareRaw(input)
  try {
    if (!isObject(input)) throw new UnsafeRedaction("redaction")
    const output = report(), result = traversal(compatibleEngine(redactor), output).walk(input)
    const serialized = JSON.stringify(result.value), masked = redactor.redact(serialized)
    return { row: JSON.parse(masked.value), replacements: output.matches + masked.replacements, stats: stats(output) }
  } catch (cause) { return { gap: contentFailure(cause).reason } }
}

const canonical = (observation: AdapterObservation, engine: Engine, output: Report): AdapterObservation => {
  const visitor = traversal(engine, output)
  const text = (value: string) => visitor.walk(value).value as string
  const tool = (input: unknown) => visitor.walk(input).value
  const content = (value: AcpContentBlock): AcpContentBlock => {
    switch (value.type) {
      case "text": return { ...value, text: text(value.text) }
      case "image": return { ...value, ...(typeof value.uri === "string" ? { uri: text(value.uri) } : {}) }
      case "audio": return value
      case "resource_link": return { ...value, name: text(value.name), uri: text(value.uri),
        ...(typeof value.title === "string" ? { title: text(value.title) } : {}), ...(typeof value.description === "string" ? { description: text(value.description) } : {}) }
      case "resource": return { ...value, resource: "text" in value.resource ? { ...value.resource, uri: text(value.resource.uri), text: text(value.resource.text) } : { ...value.resource, uri: text(value.resource.uri) } }
    }
  }
  const title = (value: string) => { let result = "", size = 0; for (const char of text(value)) { const length = byteLength(char); if (size + length > 500) break; result += char; size += length }; return result }
  const update = (value: AcpSessionUpdate): AcpSessionUpdate => {
    if (value.sessionUpdate === "user_message_chunk" || value.sessionUpdate === "agent_message_chunk" || value.sessionUpdate === "agent_thought_chunk") return { ...value, content: content(value.content) }
    const result = { ...value, ...(typeof value.title === "string" ? { title: title(value.title) } : {}),
      ...(Object.hasOwn(value, "rawInput") ? { rawInput: tool(value.rawInput) } : {}), ...(Object.hasOwn(value, "rawOutput") ? { rawOutput: tool(value.rawOutput) } : {}) }
    if (byteLength(JSON.stringify(result)) > ToolUpdateBytes) throw new UnsafeRedaction("limit")
    return result
  }
  return { ...observation, session: { ...observation.session, title: text(observation.session.title), summary: text(observation.session.summary),
    insight: text(observation.session.insight), branch: text(observation.session.branch), actor: { name: text(observation.session.actor.name), harness: text(observation.session.actor.harness) } },
    threads: observation.threads.map(value => ({ ...value, label: text(value.label), summary: text(value.summary) })),
    events: observation.events.map(event => { const before = output.matches, masked = update(event.update), rawRef = event.rawRef._tag === "object" ?
      { ...event.rawRef, ...(event.rawRef.fragment === undefined ? {} : { fragment: text(event.rawRef.fragment) }) } : { ...event.rawRef, reason: text(event.rawRef.reason) };
      return { ...event, update: masked, rawRef, fidelity: output.matches > before ? "redacted" : event.fidelity } }),
    ...(observation.usage === undefined ? {} : { usage: observation.usage.map(value => ({ ...value, model: text(value.model) })) }),
    rawSegments: observation.rawSegments.map(value => ({ ...value, sourceName: text(value.sourceName), content: (() => {
      if (!/^(?:application\/(?:json|x-ndjson|[A-Za-z0-9.+-]+\+json))$/i.test(value.mediaType)) return text(value.content)
      let parsed: unknown
      try { parsed = visitor.parse(value.content) } catch (cause) {
        if (cause instanceof UnsafeRedaction) throw cause
        // JSONL may contain multiple complete source records. Never return a
        // malformed object-looking payload through a text-only fallback.
        return value.content.split("\n").map(line => line.trim() ? JSON.stringify(visitor.walk(visitor.parse(line)).value) : line).join("\n")
      }
      const masked = visitor.walk(parsed)
      return masked.changed ? changedJson(value.content, masked.value) : value.content
    })() })) }
}
