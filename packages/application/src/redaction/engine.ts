import { RE2JS } from "re2js"
import type { RedactionPattern, RedactionStats } from "../redaction.ts"
import { catalog } from "./catalog.ts"

export class UnsafeRedaction extends Error {
  readonly reason: "limit" | "redaction"
  constructor(reason: "limit" | "redaction") { super("Content cannot be safely redacted."); this.reason = reason }
}
const bytes = (text: string) => new TextEncoder().encode(text).byteLength
export const ContentBytes = 32 * 1024 * 1024
type Rule = { id: string; type: string; value?: RE2JS; field?: RE2JS; groups: ReadonlyArray<number>; marker: string; skipEmptyCapture: boolean; candidate?: (text: string) => boolean }
type Span = { start: number; end: number; rule: Rule; priority: number }
export type Report = { matches: number; rules: Map<string, { id: string; type: string; matches: number }> }
export const report = (): Report => ({ matches: 0, rules: new Map() })
export const stats = (value: Report): RedactionStats => ({ matches: value.matches, rules: [...value.rules.values()].map(rule => ({ ...rule })) })
const record = (value: Report, rule: Rule) => {
  if (++value.matches > 10_000) throw new UnsafeRedaction("limit")
  const prior = value.rules.get(rule.id)
  value.rules.set(rule.id, { id: rule.id, type: rule.type, matches: (prior?.matches ?? 0) + 1 })
}
const legacy: ReadonlyArray<RedactionPattern & { groups?: ReadonlyArray<number>; marker?: string }> = [
  { name: "ATape Bearer", type: "bearer_token", pattern: "(?i)\\b(Bearer)\\s+([A-Za-z0-9._~+/=-]{8,})", capture_group: 2 },
  { name: "ATape token formats", type: "api_key", pattern: "\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\\b" },
  { name: "ATape credential assignment", type: "sensitive_field", pattern: String.raw`(?i)["']?\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|secret|password|passwd|token)\b["']?\s*[:=]\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s,"'}]{8,}))`, groups: [1, 2, 3] },
  { name: "ATape private key", type: "private_key", pattern: "(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", marker: "[REDACTED PRIVATE KEY]" },
  { name: "ATape sensitive fields", type: "sensitive_field", field_pattern: "(?i)^(client[_-]?secret|secret[_-]?key|api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|token)$" }
]

/** Literal matching is an Aho-Corasick scan: resolved environment values do not
 * multiply source scanning time or become regular expressions. */
const literalMatcher = (values: ReadonlyArray<string>) => {
  type Node = { next: Map<string, number>; fail: number; lengths: number[] }
  const nodes: Node[] = [{ next: new Map(), fail: 0, lengths: [] }]
  for (const value of values) {
    let index = 0
    for (let position = 0; position < value.length; position++) {
      const char = value[position]!
      let next = nodes[index]!.next.get(char)
      if (next === undefined) { next = nodes.length; nodes[index]!.next.set(char, next); nodes.push({ next: new Map(), fail: 0, lengths: [] }) }
      index = next
    }
    nodes[index]!.lengths.push(value.length)
  }
  const queue = [...nodes[0]!.next.values()]
  for (let offset = 0; offset < queue.length; offset++) {
    const parent = queue[offset]!
    for (const [char, child] of nodes[parent]!.next) {
      queue.push(child)
      let failure = nodes[parent]!.fail
      while (failure !== 0 && !nodes[failure]!.next.has(char)) failure = nodes[failure]!.fail
      nodes[child]!.fail = nodes[failure]!.next.get(char) ?? 0
      nodes[child]!.lengths.push(...nodes[nodes[child]!.fail]!.lengths)
    }
  }
  return (text: string, add: (start: number, end: number) => void) => {
    let index = 0
    for (let position = 0; position < text.length; position++) {
      const char = text[position]!
      while (index !== 0 && !nodes[index]!.next.has(char)) index = nodes[index]!.fail
      index = nodes[index]!.next.get(char) ?? 0
      for (const length of nodes[index]!.lengths) add(position + 1 - length, position + 1)
    }
  }
}

export const createEngine = (patterns: ReadonlyArray<RedactionPattern>, literals: ReadonlyArray<string>) => {
  // Necessary literal hints only skip impossible built-in matches. Custom
  // expressions always use RE2. Large tool output commonly contains none of
  // these credential prefixes, so it need not enter dozens of NFA scans.
  const candidates: Record<string, (text: string) => boolean> = {
    api_key: text => text.includes("sk-"), aws_key: text => text.includes("AKIA"),
    aws_secret: text => /aws_secret_access_key/i.test(text), github_token: text => /gh[pousr]_|github_pat_/.test(text),
    jwt: text => text.includes("eyJ"), bearer_token: text => /bearer/i.test(text), private_key: text => text.includes("PRIVATE KEY-----"),
    password: text => text.includes("://"), slack_token: text => /xox|xapp-/.test(text), stripe_key: text => /[sr]k_/.test(text),
    google_api_key: text => text.includes("AIza"), twilio_key: text => text.includes("SK"), sendgrid_key: text => text.includes("SG."),
    mailchimp_key: text => text.includes("-us"), npm_token: text => text.includes("npm_"), pypi_token: text => text.includes("pypi-"), confab_key: text => text.includes("cfb_")
  }
  const compile = (pattern: RedactionPattern, id: string, builtin: boolean): Rule => {
    const value = pattern.pattern === undefined ? undefined : RE2JS.compile(pattern.pattern)
    const field = pattern.field_pattern === undefined ? undefined : RE2JS.compile(pattern.field_pattern)
    const group = pattern.capture_group ?? 0
    if (group > (value?.groupCount() ?? 0) || value?.matcher("").find()) throw new UnsafeRedaction("redaction")
    const special = pattern as typeof legacy[number]
    const candidate = !builtin ? undefined : pattern.name === "ATape token formats" ? (text: string) => /sk-|gh[pousr]_|github_pat_|AKIA/.test(text) :
      pattern.name === "ATape credential assignment" ? (text: string) => /[:=]/.test(text) && /api|access|auth|client|secret|password|passwd|token/i.test(text) : candidates[pattern.type]
    return { id, type: pattern.type, skipEmptyCapture: builtin, ...(value ? { value } : {}), ...(field ? { field } : {}), ...(candidate ? { candidate } : {}),
      groups: special.groups ?? [group], marker: builtin ? special.marker ?? "[REDACTED]" : `[REDACTED:${pattern.type.toUpperCase()}]` }
  }
  const rules = [...legacy.map((pattern, index) => compile(pattern, `atape:${index}`, true)),
    ...catalog.map((pattern, index) => compile(pattern, `catalog:${index}`, true)),
    ...patterns.map((pattern, index) => compile(pattern, `custom:${index}`, false))]
  const literalRule: Rule = { id: "exact", type: "exact_value", groups: [0], marker: "[REDACTED]", skipEmptyCapture: false }
  const exact = literalMatcher(literals)
  const markers = [...new Set([...rules.map(rule => rule.marker), "[REDACTED]", "[REDACTED PRIVATE KEY]", "[REDACTED DIAGNOSTIC]"])]
  const text = (input: string, output: Report, fieldName?: string): string => {
    if (bytes(input) > ContentBytes) throw new UnsafeRedaction("limit")
    const spans: Span[] = []
    const protectedSpans: Array<{ start: number; end: number }> = []
    if (input.includes("[REDACTED")) for (const marker of markers) {
      let offset = 0
      while ((offset = input.indexOf(marker, offset)) !== -1) {
        if (protectedSpans.length >= 10_000) throw new UnsafeRedaction("limit")
        protectedSpans.push({ start: offset, end: offset + marker.length }); offset += marker.length
      }
    }
    protectedSpans.sort((left, right) => left.start - right.start)
    let candidatesSeen = 0
    const add = (span: Span) => {
      if (++candidatesSeen > 100_000) throw new UnsafeRedaction("limit")
      let low = 0, high = protectedSpans.length
      while (low < high) { const middle = (low + high) >>> 1; if (protectedSpans[middle]!.end <= span.start) low = middle + 1; else high = middle }
      const first = protectedSpans[low]
      if (first && span.start >= first.start && span.end <= first.end) return
      // A match crossing a marker still contains unprotected source content.
      // Mask its entire union rather than treating that suffix as already safe.
      for (let index = low; index < protectedSpans.length; index++) {
        const marker = protectedSpans[index]!
        if (marker.start >= span.end) break
        if (marker.end > span.start) { span.start = Math.min(span.start, marker.start); span.end = Math.max(span.end, marker.end) }
      }
      if (spans.length >= 10_000) throw new UnsafeRedaction("limit")
      spans.push(span)
    }
    for (const [priority, rule] of rules.entries()) {
      if (rule.field && (!fieldName || !rule.field.matcher(fieldName).find())) continue
      if (!rule.value) {
        if (rule.field && !markers.includes(input)) { record(output, rule); return rule.marker }
        continue
      }
      if (rule.candidate && !rule.candidate(input)) continue
      const matcher = rule.value.matcher(input)
      while (matcher.find()) {
        const group = rule.groups.find(index => matcher.start(index) >= 0)
        if (group === undefined) continue
        const start = matcher.start(group), end = matcher.end(group)
        if (end === start) {
          if (rule.skipEmptyCapture) continue
          throw new UnsafeRedaction("redaction")
        }
        add({ start, end, rule, priority })
      }
    }
    exact(input, (start, end) => add({ start, end, rule: literalRule, priority: rules.length }))
    spans.sort((left, right) => left.start - right.start || right.end - left.end || left.priority - right.priority)
    const merged: Span[] = []
    for (const span of spans) {
      const prior = merged[merged.length - 1]
      if (prior && span.start < prior.end) {
        prior.end = Math.max(prior.end, span.end)
        if (span.priority < prior.priority) { prior.rule = span.rule; prior.priority = span.priority }
      } else merged.push({ ...span })
    }
    let end = 0, result = ""
    for (const span of merged) {
      result += input.slice(end, span.start) + span.rule.marker
      end = span.end
      record(output, span.rule)
    }
    result += input.slice(end)
    if (bytes(result) > ContentBytes) throw new UnsafeRedaction("limit")
    return result
  }
  return Object.freeze({ text })
}
export type Engine = ReturnType<typeof createEngine>
