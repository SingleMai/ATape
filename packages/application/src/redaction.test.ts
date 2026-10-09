import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { AcpContentBlock, AdapterObservation } from "@atape/domain"
import { compileRedactionPolicy, makeRedactionLayer, validateRedactionConfiguration, type RedactionPattern } from "./redaction.ts"
import { prepareCanonicalSlice, prepareCollectedObservation } from "./collectorPreparation.ts"
import { rawSourceRecord } from "./rawPreparation.ts"

const key = new Uint8Array(32).fill(7)
const compile = (patterns: ReadonlyArray<RedactionPattern> = [], secretValues: ReadonlyArray<string> = []) =>
  Effect.runPromise(compileRedactionPolicy({ installationKey: key, configuration: { patterns }, secretValues }))
const value = async (text: string) => (await Effect.runPromise((await compile()).prepareText(text))).value
const now = "2026-10-09T12:00:00Z"
const observation = (): AdapterObservation => ({ observationId: "observation", observedAt: now,
  session: { sourceSessionId: "session", revision: 1, title: "safe", summary: "", insight: "", actor: { name: "agent", harness: "fixture" }, branch: "main", status: "active", captureStatus: "healthy", updatedAt: now, reportedEventCount: 1 },
  threads: [{ sourceThreadId: "root", revision: 1, label: "root", summary: "", captureStatus: "healthy" }],
  events: [{ sourceEventId: "event", sourceThreadId: "root", revision: 1, projectionRevision: 4, sourceOrder: 0, eventIndex: 0,
    occurredAt: now, orderFidelity: "native", fidelity: "native", rawRef: { _tag: "unavailable", reason: "fixture" },
    update: { sessionUpdate: "tool_call", toolCallId: "call", title: "fixture", kind: "other", status: "completed", rawInput: { password: "short", token: "has spaces here" } } }], rawSegments: [] })

describe("Redaction Module", () => {
  it.each([
    ["Anthropic", `sk-ant-api03-${"a".repeat(80)}`], ["OpenAI", `sk-proj-${"a".repeat(32)}`], ["AWS access", `AKIA${"A".repeat(16)}`],
    ["GitHub classic", `ghp_${"a".repeat(36)}`], ["GitHub fine", `github_pat_${"a".repeat(22)}`], ["GitHub OAuth", `gho_${"a".repeat(36)}`],
    ["GitHub app", `ghs_${"a".repeat(36)}`], ["GitHub user", `ghu_${"a".repeat(36)}`], ["GitHub refresh", `ghr_${"a".repeat(36)}`],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.synthetic_signature"], ["Slack", "xoxb-1234567890-synthetic"],
    ["Slack rotating", "xoxe.xoxb-1234567890-synthetic"], ["Slack app", "xapp-1234567890-synthetic"],
    ["Stripe secret", `sk_test_${"a".repeat(24)}`], ["Stripe restricted", `rk_live_${"a".repeat(24)}`], ["Google", `AIza${"a".repeat(35)}`],
    ["Twilio", `SK${"a".repeat(32)}`], ["SendGrid", `SG.${"a".repeat(22)}.${"a".repeat(43)}`], ["MailChimp", `${"a".repeat(32)}-us12`],
    ["npm", `npm_${"a".repeat(36)}`], ["PyPI", `pypi-AgEIcHlwaS5vcmc${"a".repeat(70)}`], ["Confab", `cfb_${"a".repeat(40)}`]
  ])("masks catalog format %s", async (_label, secret) => {
    const result = await value(`before ${secret} after`)
    expect(result).toBe("before [REDACTED] after")
  })
  it.each(["RSA", "EC", "OPENSSH", ""])("masks %s PEM blocks", async kind => {
    const label = `${kind ? `${kind} ` : ""}PRIVATE KEY`
    expect(await value(`-----BEGIN ${label}-----\nsynthetic\n-----END ${label}-----`)).toBe("[REDACTED PRIVATE KEY]")
  })
  it.each(["postgres", "postgresql", "mysql", "mongodb", "mongodb+srv", "redis", "https"])("masks only %s URL password", async scheme => {
    expect(await value(`${scheme}://demo:syntheticpass@localhost/db`)).toBe(`${scheme}://demo:[REDACTED]@localhost/db`)
  })
  it.each(["aws_secret_access_key", "AWS_SECRET_ACCESS_KEY"])("retains %s assignment around masked capture", async name => {
    expect(await value(`${name} = ${"a".repeat(40)}`)).toBe(`${name} = [REDACTED]`)
  })
  it("preserves legacy Bearer semantics and ordinary near misses", async () => {
    expect(await value("bearer abcdefgh")).toBe("bearer [REDACTED]")
    expect(await value("AIzashort ghp_short SK123 documentation passwordless=false")).toBe("AIzashort ghp_short SK123 documentation passwordless=false")
  })
  it.each(["short", "has spaces here", 'escaped " quote', "slash \\ value"])("masks complete decoded credential values %s", async password => {
    const policy = await compile()
    const source = JSON.stringify({ password, client_secret: password, secret_key: password, token: password })
    const result = await Effect.runPromise(policy.prepareFile({ content: source, format: "json" }))
    expect(JSON.parse(result.value)).toEqual({ password: "[REDACTED]", client_secret: "[REDACTED]", secret_key: "[REDACTED]", token: "[REDACTED]" })
    expect(result.replacements).toBe(4)
  })
  it.each(['password="has spaces here"', String.raw`password="has \"quotes\" here"`, String.raw`password="has \\ slash"`])("masks complete quoted plaintext assignments", async source => {
    expect(await value(source)).toBe('password="[REDACTED]"')
  })
  it.each(['password=""', "password=''", 'token=""', '{"password":""}'])("retains harmless empty credential examples without failing: %s", async source => {
    const policy = await compile()
    expect(await Effect.runPromise(policy.prepareText(source))).toMatchObject({ value: source, replacements: 0 })
    expect((await Effect.runPromise(policy.prepareText(`${source} token=syntheticsecret`))).value).toBe(`${source} token=[REDACTED]`)
  })
  it("still fails closed for a configured empty capture within a nonempty match", async () => {
    const policy = await compile([{ name: "empty capture", type: "local", pattern: "prefix()", capture_group: 1 }])
    expect(await Effect.runPromiseExit(policy.prepareText("prefix"))).toMatchObject({ _tag: "Failure" })
    expect(policy.prepareRaw({ payload: "prefix" })).toEqual({ gap: "redaction" })
    expect(policy.prepareDiagnostic("prefix")).toEqual({ value: "[REDACTED DIAGNOSTIC]", replacements: 1 })
  })
  it("implements custom capture groups and field/value conjunction on arrays", async () => {
    const policy = await compile([
      { name: "capture", type: "local", pattern: "(same:)(same)", capture_group: 2 },
      { name: "field", type: "local", field_pattern: "^private$", pattern: "hide-[a-z]+" }
    ])
    expect((await Effect.runPromise(policy.prepareText("same:same"))).value).toBe("same:[REDACTED:LOCAL]")
    const raw = policy.prepareRaw({ private: ["hide-this", "safe"], public: "hide-this" })
    expect(raw).toMatchObject({ row: { private: ["[REDACTED:LOCAL]", "safe"], public: "hide-this" } })
  })
  it("merges crossing matches without leaking either suffix and reports one operation", async () => {
    const policy = await compile([{ name: "prefix", type: "local", pattern: "abcde" }], ["defghijk"])
    const result = await Effect.runPromise(policy.prepareText("abcdefghijk tail"))
    expect(result.value).toBe("[REDACTED:LOCAL] tail")
    expect(result.replacements).toBe(1)
    expect(result.stats.matches).toBe(1)
    expect(JSON.stringify(result.stats)).not.toContain("abcde")
  })
  it("matches configured literals exactly, including regex punctuation and UTF-16 text", async () => {
    const policy = await compile([], ["a.*+[b]synthetic", "秘密😀synthetic"])
    expect((await Effect.runPromise(policy.prepareText("a.*+[b]synthetic 秘密😀synthetic"))).value).toBe("[REDACTED] [REDACTED]")
  })
  it("rejects malformed declared JSON/JSONL without returning the source", async () => {
    const policy = await compile()
    for (const format of ["json", "jsonl"] as const) {
      expect(await Effect.runPromiseExit(policy.prepareFile({ content: '{"password":"canary"', format }))).toMatchObject({ _tag: "Failure" })
    }
  })
  it("uses the same escaped JSON and nested JSON TEXT path for file, Raw and Canonical tool values", async () => {
    const policy = await compile([], ["synthetic-canary"])
    const source = String.raw`{"payload":"synthetic-\u0063anary"}`
    expect((await Effect.runPromise(policy.prepareFile({ content: source, format: "json" }))).value).not.toContain("anary")
    expect(policy.prepareRaw({ nested: source })).toMatchObject({ row: { nested: '{"payload":"[REDACTED]"}' } })
    const initial = observation()
    const input: AdapterObservation = { ...initial, events: [{ ...initial.events[0]!, update: { sessionUpdate: "tool_call", toolCallId: "call", title: "safe", kind: "other", status: "completed", rawInput: source } }] }
    const result = await Effect.runPromise(prepareCanonicalSlice("fixture", input).pipe(Effect.provide(makeRedactionLayer(policy))))
    expect(result.observation.events[0]!.update).toMatchObject({ rawInput: '{"payload":"[REDACTED]"}' })
  })
  it.each(["text", "resource"] as const)("masks decoded JSON TEXT in Canonical %s content through the public preparation boundary", async kind => {
    const policy = await compile([], ["synthetic-canary"])
    const source = String.raw`{"payload":"synthetic-\u0063anary","password":"short"}`
    const initial = observation()
    const content = kind === "text" ? { type: "text" as const, text: source } : {
      type: "resource" as const, resource: { uri: "fixture://message", mimeType: "application/json", text: source }
    }
    const input: AdapterObservation = { ...initial, events: [{ ...initial.events[0]!, update: { sessionUpdate: "agent_message_chunk", content } }] }
    const result = await Effect.runPromise(prepareCanonicalSlice("fixture", input).pipe(Effect.provide(makeRedactionLayer(policy))))
    const event = result.observation.events[0]!
    expect(event.update).toMatchObject({ content: kind === "text" ? { text: '{"payload":"[REDACTED]","password":"[REDACTED]"}' } : {
      resource: { text: '{"payload":"[REDACTED]","password":"[REDACTED]"}' }
    } })
    expect(event.sourceEventId).toBe("event")
    expect(event.sourceThreadId).toBe("root")
    expect(event.fidelity).toBe("redacted")
  })
  it.each(["text", "resource"] as const)("fails closed on Canonical %s JSON TEXT duplicate keys and excessive nesting", async kind => {
    const policy = await compile()
    const sources = [String.raw`{"key":1,"\u006bey":2}`, "[".repeat(34) + '"safe"' + "]".repeat(34)]
    for (const source of sources) {
      const initial = observation()
      const content = kind === "text" ? { type: "text" as const, text: source } : {
        type: "resource" as const, resource: { uri: "fixture://message", mimeType: "application/json", text: source }
      }
      const input: AdapterObservation = { ...initial, events: [{ ...initial.events[0]!, update: { sessionUpdate: "user_message_chunk", content } }] }
      expect(await Effect.runPromiseExit(prepareCanonicalSlice("fixture", input).pipe(Effect.provide(makeRedactionLayer(policy))))).toMatchObject({ _tag: "Failure" })
    }
  })
  it.each([String.raw`{"key":"first","\u006bey":"second"}`, String.raw`{"outer":"{\"key\":1,\"key\":2}"}`])("fails closed for duplicate decoded JSON keys", async source => {
    const policy = await compile()
    expect(await Effect.runPromiseExit(policy.prepareFile({ content: source, format: "json" }))).toMatchObject({ _tag: "Failure" })
    expect(policy.prepareRaw({ nested: source })).toEqual({ gap: "redaction" })
  })
  it("fails closed for collisions after key masking", async () => {
    const policy = await compile([], ["first-key", "other-key"])
    expect(policy.prepareRaw({ "first-key": 1, "other-key": 2 })).toEqual({ gap: "redaction" })
  })
  it.each([
    { label: "text", sessionUpdate: "user_message_chunk", content: { type: "text", text: "synthetic-canary" },
      expected: { type: "text", text: "[REDACTED]" }, redacted: true },
    { label: "image URI", sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "c3ludGhldGljLWNhbmFyeQ==", mimeType: "image/png", uri: "fixture://synthetic-canary" },
      expected: { type: "image", data: "c3ludGhldGljLWNhbmFyeQ==", mimeType: "image/png", uri: "fixture://[REDACTED]" }, redacted: true },
    { label: "audio body", sessionUpdate: "agent_thought_chunk",
      content: { type: "audio", data: "c3ludGhldGljLWNhbmFyeQ==", mimeType: "audio/wav" },
      expected: { type: "audio", data: "c3ludGhldGljLWNhbmFyeQ==", mimeType: "audio/wav" }, redacted: false },
    { label: "resource link", sessionUpdate: "agent_thought_chunk",
      content: { type: "resource_link", name: "synthetic-canary", uri: "fixture://synthetic-canary", title: "synthetic-canary",
        description: "synthetic-canary", mimeType: "text/plain", size: 23 },
      expected: { type: "resource_link", name: "[REDACTED]", uri: "fixture://[REDACTED]", title: "[REDACTED]",
        description: "[REDACTED]", mimeType: "text/plain", size: 23 }, redacted: true },
    { label: "text resource", sessionUpdate: "agent_message_chunk",
      content: { type: "resource", resource: { uri: "fixture://synthetic-canary", text: "synthetic-canary", mimeType: "text/plain" } },
      expected: { type: "resource", resource: { uri: "fixture://[REDACTED]", text: "[REDACTED]", mimeType: "text/plain" } }, redacted: true },
    { label: "blob resource URI", sessionUpdate: "user_message_chunk",
      content: { type: "resource", resource: { uri: "fixture://synthetic-canary", blob: "c3ludGhldGljLWNhbmFyeQ==", mimeType: "application/octet-stream" } },
      expected: { type: "resource", resource: { uri: "fixture://[REDACTED]", blob: "c3ludGhldGljLWNhbmFyeQ==", mimeType: "application/octet-stream" } }, redacted: true }
  ] satisfies ReadonlyArray<{ label: string; sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk";
    content: AcpContentBlock; expected: AcpContentBlock; redacted: boolean }>)("prepares standard ACP $label without decoding binary bodies", async sample => {
    const policy = await compile([], ["synthetic-canary"]), initial = observation()
    const input: AdapterObservation = { ...initial, events: [{ ...initial.events[0]!, update: {
      sessionUpdate: sample.sessionUpdate, messageId: "synthetic-canary", content: sample.content
    } }] }
    const before = structuredClone(input)
    const result = await Effect.runPromise(prepareCanonicalSlice("fixture", input).pipe(Effect.provide(makeRedactionLayer(policy))))
    expect(result.observation.events[0]).toEqual({ ...input.events[0]!, fidelity: sample.redacted ? "redacted" : "native",
      update: { sessionUpdate: sample.sessionUpdate, messageId: "synthetic-canary", content: sample.expected } })
    expect(input).toEqual(before)
  })
  it.each(["tool_call", "tool_call_update"] as const)("masks %s and Canonical metadata while preserving identity, topology, timestamps and counters", async sessionUpdate => {
    const secret = "identity-canary", masked = "[REDACTED]", initial = observation(), policy = await compile([], [secret])
    const root = `${secret}-root`, child = `${secret}-child`, sourceObjectId = `${secret}-object`
    const input: AdapterObservation = { ...initial, observationId: `${secret}-observation`,
      session: { ...initial.session, sourceSessionId: `${secret}-session`, title: secret, summary: secret, insight: secret,
        branch: secret, actor: { name: secret, harness: secret } },
      threads: [{ ...initial.threads[0]!, sourceThreadId: root, label: secret, summary: secret },
        { ...initial.threads[0]!, sourceThreadId: child, parentSourceThreadId: root, label: secret, summary: secret }],
      events: [{ ...initial.events[0]!, sourceEventId: `${secret}-event`, sourceThreadId: root, childSourceThreadId: child,
        rawRef: sessionUpdate === "tool_call" ? { _tag: "object", sourceObjectId, fragment: `#${secret}` } : { _tag: "unavailable", reason: `gap ${secret}` }, update: {
          sessionUpdate, toolCallId: `${secret}-call`, title: secret, kind: "other", status: "completed",
          rawInput: { password: "short", token: "has spaces here" }, rawOutput: secret
        } }],
      usage: [{ sourceUsageId: `${secret}-usage`, sourceThreadId: child, revision: 2, occurredAt: now, model: secret,
        inputTokens: 20, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 3 }] }
    const before = structuredClone(input)
    const result = await Effect.runPromise(prepareCanonicalSlice("fixture", input).pipe(Effect.provide(makeRedactionLayer(policy))))
    expect(result.observation).toEqual({ ...input,
      session: { ...input.session, title: masked, summary: masked, insight: masked, branch: masked, actor: { name: masked, harness: masked } },
      threads: input.threads.map(thread => ({ ...thread, label: masked, summary: masked })),
      events: [{ ...input.events[0]!, fidelity: "redacted", rawRef: sessionUpdate === "tool_call" ? { _tag: "object", sourceObjectId, fragment: `#${masked}` } : { _tag: "unavailable", reason: `gap ${masked}` },
        update: { sessionUpdate, toolCallId: `${secret}-call`, title: masked, kind: "other", status: "completed",
          rawInput: { password: masked, token: masked }, rawOutput: masked } }],
      usage: [{ ...input.usage![0]!, model: masked }] })
    expect(input).toEqual(before)
    const raw = await Effect.runPromise(rawSourceRecord("record", { id: input.session.sourceSessionId, sourceObjectId }).pipe(Effect.provide(makeRedactionLayer(policy))))
    expect(raw.masked).toEqual({ row: { id: `${masked}-session`, sourceObjectId: `${masked}-object` } })
  })
  it("applies field-only rules to numeric Raw values while retaining booleans, null and other numbers", async () => {
    const policy = await compile([{ name: "account", type: "account", field_pattern: "^account_number$" }])
    const raw = await Effect.runPromise(rawSourceRecord("record", { account_number: [12345, true, null], public: 12345,
      nested: { account_number: 6789 } }).pipe(Effect.provide(makeRedactionLayer(policy))))
    expect(raw.masked).toEqual({ row: { account_number: ["[REDACTED:ACCOUNT]", true, null], public: 12345,
      nested: { account_number: "[REDACTED:ACCOUNT]" } } })
  })
  it("masks legacy Raw JSON escapes while retaining complete-LF bytes", async () => {
    const policy = await compile([], ["synthetic-canary"])
    const input: AdapterObservation = { ...observation(), rawSegments: [{ sourceObjectId: "raw", sourceGeneration: "one", sourceOffset: 0, sourceName: "synthetic-canary.jsonl", mediaType: "application/x-ndjson", final: true,
      content: String.raw`{"payload":"synthetic-\u0063anary"}` + "\n" }] }
    const result = await Effect.runPromise(prepareCollectedObservation("fixture", input).pipe(Effect.provide(makeRedactionLayer(policy))))
    expect(result.observation.rawSegments[0]).toEqual({ ...input.rawSegments[0]!, sourceName: "[REDACTED].jsonl", content: '{"payload":"[REDACTED]"}\n' })
    const raw = await Effect.runPromise(rawSourceRecord("native-id", { payload: "synthetic-canary" }).pipe(Effect.provide(makeRedactionLayer(policy))))
    expect(raw.masked).toEqual({ row: { payload: "[REDACTED]" } })
  })
  it("does not parse ordinary text/plain code as mandatory JSON", async () => {
    const policy = await compile()
    const input: AdapterObservation = { ...observation(), rawSegments: [{ sourceObjectId: "raw", sourceGeneration: "one", sourceOffset: 0, sourceName: "code.txt", mediaType: "text/plain", final: true, content: "{ code() }\n" }] }
    expect((await Effect.runPromise(policy.prepareCanonical(input))).value.rawSegments[0]!.content).toBe("{ code() }\n")
  })
  it("is idempotent on masked output with no inflated retry count", async () => {
    const policy = await compile([{ name: "private", type: "local", pattern: "private-[a-z]+" }])
    const first = await Effect.runPromise(policy.prepareText("private-canary token=syntheticsecret"))
    const second = await Effect.runPromise(policy.prepareText(first.value))
    expect(second.value).toBe(first.value); expect(second.replacements).toBe(0)
  })
  it("does not rematch the inside of markers emitted by this exact policy", async () => {
    const policy = await compile([{ name: "marker word", type: "local", pattern: "REDACTED" }])
    const first = await Effect.runPromise(policy.prepareText("REDACTED"))
    expect(first.value).toBe("[REDACTED:LOCAL]")
    expect(await Effect.runPromise(policy.prepareText(first.value))).toMatchObject({ value: first.value, replacements: 0 })
    expect(policy.prepareDiagnostic("[REDACTED DIAGNOSTIC]")).toEqual({ value: "[REDACTED DIAGNOSTIC]", replacements: 0 })
  })
  it("masks an external secret crossing a known marker rather than skipping its suffix", async () => {
    const policy = await compile([{ name: "crossing", type: "local", pattern: "REDACTED\\]secret" }])
    expect((await Effect.runPromise(policy.prepareText("before [REDACTED]secret after"))).value).toBe("before [REDACTED:LOCAL] after")
  })
  it("does not trust a source-created marker with an unknown credential-shaped label", async () => {
    const secret = `SK${"a".repeat(32)}`, policy = await compile()
    expect((await Effect.runPromise(policy.prepareText(`[REDACTED:${secret}]`))).value).toBe("[REDACTED:[REDACTED]]")
  })
  it("does not exempt an unknown whole marker selected by a custom rule", async () => {
    const policy = await compile([{ name: "unknown marker", type: "local", pattern: "\\[REDACTED:[A-Z_]+\\]" }])
    expect((await Effect.runPromise(policy.prepareText("[REDACTED:PRIVATE_CANARY]"))).value).toBe("[REDACTED:LOCAL]")
  })
  it("binds normalized policy and resolved values to the installation HMAC key", async () => {
    const first = await compile([], ["synthetic-one", "synthetic-two"])
    const same = await compile([], ["synthetic-two", "synthetic-one", "synthetic-one"])
    const changed = await compile([], ["synthetic-three"])
    const otherKey = await Effect.runPromise(compileRedactionPolicy({ installationKey: new Uint8Array(32).fill(9), secretValues: ["synthetic-one", "synthetic-two"] }))
    expect(first.policyId).toBe(same.policyId); expect(first.policyId).not.toBe(changed.policyId); expect(first.policyId).not.toBe(otherKey.policyId)
    expect(first.policyId).toMatch(/^redaction_v1_[a-f0-9]{64}$/)
    expect(Object.isFrozen(first)).toBe(true)
  })
  it.each(["(?<=prefix)secret", "(a)\\1", "[", "a*"])("rejects invalid or unsupported expressions safely", async pattern => {
    const result = await Effect.runPromise(Effect.flip(compileRedactionPolicy({ installationKey: key, configuration: { patterns: [{ name: "test", type: "test", pattern }] } })))
    expect(result.reason).toBe("engine")
    expect(result.message).toBe("Redaction policy is invalid or exceeds its admitted limits.")
  })
  it.each([7, 4097])("rejects explicit literal length %i without silently disabling protection", async size => {
    expect(await Effect.runPromiseExit(compileRedactionPolicy({ installationKey: key, secretValues: ["a".repeat(size)] }))).toMatchObject({ _tag: "Failure" })
  })
  it.each([8, 4096])("accepts exact literal length %i", async size => {
    const policy = await compile([], ["a".repeat(size)])
    expect((await Effect.runPromise(policy.prepareText("a".repeat(size)))).value).toBe("[REDACTED]")
  })
  it("rejects excessive rules, bad capture groups, duplicate config keys and invalid installation keys", async () => {
    for (const configuration of [ { patterns: Array.from({ length: 129 }, () => ({ name: "x", type: "x", pattern: "x" })) },
      { patterns: [{ name: "x", type: "x", pattern: "(x)", capture_group: 2 }] }, String.raw`{"patterns":[],"\u0070atterns":[]}` ]) {
      expect(await Effect.runPromiseExit(compileRedactionPolicy({ installationKey: key, configuration }))).toMatchObject({ _tag: "Failure" })
    }
    expect(await Effect.runPromiseExit(compileRedactionPolicy({ installationKey: new Uint8Array(31) }))).toMatchObject({ _tag: "Failure" })
    expect(await Effect.runPromise(validateRedactionConfiguration('{"patterns":[]}'))).toEqual({ patterns: [] })
  })
  it("reports bounded work exhaustion as failures, Raw gaps and a safe diagnostic placeholder", async () => {
    const policy = await compile()
    let nested: unknown = "safe"
    for (let depth = 0; depth < 34; depth++) nested = { next: nested }
    expect(policy.prepareRaw({ nested })).toEqual({ gap: "limit" })
    expect(policy.prepareRaw({ values: Array.from({ length: 100_001 }, () => null) })).toEqual({ gap: "limit" })
    expect(await Effect.runPromiseExit(policy.prepareText("x".repeat(32 * 1024 * 1024 + 1)))).toMatchObject({ _tag: "Failure" })
    expect(policy.prepareDiagnostic("x".repeat(32 * 1024 * 1024 + 1))).toEqual({ value: "[REDACTED DIAGNOSTIC]", replacements: 1 })
  })
  it("handles a representative 31MiB noncandidate tool payload without scanning every regex", async () => {
    const policy = await compile()
    const source = "z".repeat(31 * 1024 * 1024)
    const result = policy.prepareRaw({ output: source })
    expect("row" in result && result.row).toEqual({ output: source })
  }, 30_000)
})
