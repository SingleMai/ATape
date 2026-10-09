import { SourceCaptureHeaderV2, SourceCapturePage, SourceCaptureVersion2, type AdapterOpenContext, type SourceCaptureFrame } from "@atape/domain"
import { Schema } from "effect"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"
type Row = Record<string, any>
type Round = { trigger: "auto" | "manual"; tools: number; files: number; gap: number; reverse?: boolean; toolFirst?: boolean }
type Generated = { rows: Row[]; text: string; lines: string[]; eventIds: string[]; usages: Map<string, Row>; canonical: Set<number>;
  groups: { originals: number[]; copies: number[]; boundary: number; summary: number; answer: number }[] }
let manual: Row[], auto: Row[], directory: string, file: string, context: AdapterOpenContext & { signal: AbortSignal }
beforeAll(async () => {
  const parse = (text: string): Row[] => text.trimEnd().split("\n").map(line => JSON.parse(line))
  ;[manual, auto] = await Promise.all(["native-manual-read-reinjection-2.1.263/secondcontinue.jsonl", "native-auto-read-replay-2.1.263/auto/secondcontinue.jsonl"]
    .map(async name => parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8")))) as [Row[], Row[]]
})
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-current-compaction-")); file = join(directory, "session.jsonl")
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.2" }, project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
// GENERATED contract sources, not native captures. These pure constructors clone
// known native record schemas, then assign new identities/values and serialize
// new bytes. No checked-in native snapshot is changed or presented as N-round
// native evidence. The oracle records intended ordinary Events and API samples
// while constructing a conversation, independently of the Adapter parser.
const generate = (rounds: Round[]): Generated => {
  const rows: Row[] = [], canonical = new Set<number>(), groups: Generated["groups"] = []
  const usages = new Map<string, Row>(), eventIds: string[] = []
  let sequence = 0, leaf: string | null = null, slug: string | undefined
  const sid = "00000000-0000-4000-8000-000000000001"
  const id = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`
  const fresh = (template: Row, parent = leaf): Row => {
    const row = structuredClone(template)
    row.uuid = id(); row.parentUuid = parent; row.sessionId = sid; row.cwd = directory
    row.timestamp = new Date(Date.UTC(2026, 9, 9, 0, 0, sequence)).toISOString()
    if (slug) row.slug = slug; else delete row.slug
    return row
  }
  const add = (row: Row, ordinary = false) => {
    rows.push(row)
    if (typeof row.uuid === "string") leaf = row.uuid
    if (ordinary) {
      canonical.add(rows.length - 1); eventIds.push(`${row.uuid}:0`)
      if (row.type === "assistant") usages.set(row.message.id, structuredClone(row.message.usage))
    }
    return row
  }
  const assistant = (text: string, api: string, index = 0, stop = "end_turn") => {
    const row = fresh(manual[45]!)
    row.message.id = api; row.message.content = [{ type: "text", text }]
    row.message.stop_reason = stop; row.apiBlockIndex = index
    row.message.usage.input_tokens = 20 + sequence; row.message.usage.output_tokens = 10 + sequence
    return row
  }
  const ordinary = (label: string) => {
    const user = fresh(manual[43]!); user.promptId = id(); user.message.content = `GEN_USER ${label}`; add(user, true)
    add(fresh(manual[44]!))
    add(assistant(`GEN_ASSISTANT ${label}`, `generated_api_${sequence}`), true)
  }
  const call = (api: string, index: number, label: string, parent = leaf) => {
    const row = fresh(auto[22]!, parent)
    row.message.id = api; row.apiBlockIndex = index
    row.message.content[0].id = `generated_call_${sequence}`
    // Deliberate path reuse across rounds: source ownership is carried by UUID
    // and tool-use identity, rather than requiring globally fresh filenames.
    row.message.content[0].input.file_path = join(directory, `reused-${index % 2}.txt`)
    row.message.usage.input_tokens = 30 + sequence; row.message.usage.output_tokens = 12 + sequence
    row.unknownSourceValue = { round: label, nested: [null, false, { retained: true }] }
    return row
  }
  const receipt = (tool: Row, prompt: string, parent = tool.uuid) => {
    const row = fresh(auto[24]!, parent), marker = `GEN_READ ${tool.message.content[0].id}\n`
    row.promptId = prompt; row.sourceToolAssistantUUID = tool.uuid
    row.message.content[0].tool_use_id = tool.message.content[0].id
    row.message.content[0].content = `1\t${marker}2\t`
    row.toolUseResult.file.filePath = tool.message.content[0].input.file_path
    row.toolUseResult.file.content = marker
    row.toolUseResult.unknownSourceValue = { nested: [null, { retained: true }] }
    return row
  }
  ordinary("seed")
  for (const [roundIndex, config] of rounds.entries()) {
    for (let n = 0; n < config.gap; n++) ordinary(`gap-${roundIndex}-${n}`)
    const originals: number[] = [], prompt = id()
    const remember = (row: Row, isCanonical = false) => { originals.push(rows.length); return add(row, isCanonical) }
    const user = fresh(auto[19]!); user.promptId = prompt; user.message.content = `GEN_USER round-${roundIndex}`; remember(user, true)
    remember(fresh(auto[20]!))
    if (!config.tools) {
      remember(assistant(`GEN_ASSISTANT before-${roundIndex}`, `generated_before_${roundIndex}`), true)
    } else if (config.tools <= 2) {
      const api = `generated_plan_${roundIndex}`
      remember(assistant(`GEN_PLAN ${roundIndex}`, api, 0, "tool_use"), true)
      const calls = Array.from({ length: config.tools }, (_, index) => remember(call(api, index + 1, `${roundIndex}`), true))
      const ordered = config.reverse ? [...calls].reverse() : calls
      for (const tool of ordered) remember(receipt(tool, prompt), true)
      remember(fresh(auto[26]!))
    } else {
      // Three-plus tools are linear ordinary calls/results from known schemas,
      // not an invented claim about arbitrary parallel provider batches.
      for (let n = 0; n < config.tools; n++) {
        const tool = remember(call(`generated_plan_${roundIndex}_${n}`, 0, `${roundIndex}`), true)
        remember(receipt(tool, prompt), true)
      }
      remember(fresh(auto[26]!))
    }
    const previousLeaf = leaf, copies: number[] = []
    if (config.trigger === "auto") {
      slug ??= "generated-stable-slug"
      for (const index of originals) {
        const copy = structuredClone(rows[index]!); copy.slug ??= slug
        copies.push(rows.length); rows.push(copy) // duplicate records do not change the semantic leaf or oracle
      }
    }
    const boundary = fresh(config.trigger === "manual" ? manual[31]! : auto[35]!, null), summaryId = id()
    boundary.logicalParentUuid = previousLeaf; boundary.compactMetadata.trigger = config.trigger
    const retained = originals.slice(config.trigger === "manual" ? -1 : 0).map(index => rows[index]!.uuid)
    boundary.compactMetadata.preservedSegment = { headUuid: retained[0], tailUuid: retained.at(-1), anchorUuid: summaryId }
    boundary.compactMetadata.preservedMessages = { anchorUuid: summaryId, uuids: retained, allUuids: [...retained] }
    if (slug) boundary.slug = slug
    const boundaryIndex = rows.length; add(boundary)
    const summary = fresh(config.trigger === "manual" ? manual[32]! : auto[36]!)
    summary.uuid = summaryId; summary.promptId = prompt
    summary.message.content = `GEN_INTERNAL_SUMMARY round-${roundIndex}`
    const summaryIndex = rows.length; add(summary)
    if (config.trigger === "manual") {
      for (const template of manual.slice(33, 36)) { const control = fresh(template); control.promptId = prompt; add(control) }
    }
    for (let n = 0; n < config.files; n++) {
      const frame = fresh(manual[36]!), path = join(directory, `reinjected-${n % 2}.txt`)
      frame.attachment.filename = path; frame.attachment.displayPath = path
      frame.attachment.content.file.filePath = path
      frame.attachment.content.file.content = `GEN_INTERNAL_FILE ${roundIndex}/${n}\n`
      // Typed reinjections remain Raw source even when the filename/whole body
      // does not identify an earlier Read receipt.
      frame.attachment.content.unknownSourceValue = { retained: [n, roundIndex] }; add(frame)
    }
    if (config.trigger === "manual") {
      const meta = fresh(manual[41]!); meta.promptId = prompt; add(meta)
      const synthetic = fresh(manual[42]!); synthetic.message.id = `generated_synthetic_${roundIndex}`; add(synthetic)
    }
    const answerIndex = rows.length
    if (config.trigger === "manual") ordinary(`resumed-${roundIndex}`)
    else if (config.toolFirst) {
      const tool = add(call(`generated_final_${roundIndex}`, 0, `answer-${roundIndex}`), true)
      add(receipt(tool, prompt), true)
      add(assistant(`GEN_ASSISTANT final-${roundIndex}`, `generated_after_tool_${roundIndex}`), true)
    } else {
      const api = `generated_final_${roundIndex}`
      add(assistant(`GEN_ASSISTANT final-${roundIndex}-0`, api), true)
      // A later original physical block revises the same API sample. Copies
      // must not create a newer revision or sum this API twice.
      add(assistant(`GEN_ASSISTANT final-${roundIndex}-1`, api, 1), true)
    }
    groups.push({ originals, copies, boundary: boundaryIndex, summary: summaryIndex, answer: answerIndex })
  }
  const lines = rows.map(row => JSON.stringify(row) + "\n")
  return { rows, lines, text: lines.join(""), eventIds, usages, canonical, groups }
}
const serialize = (rows: Row[]) => rows.map(row => JSON.stringify(row) + "\n").join("")
const limits = { rowBytes: 16 * 1024 * 1024, pageBytes: 32 * 1024 * 1024, pageRows: 100, records: 100000, threads: 100, durationMs: 300000 }
const capture = async (priorCheckpoint?: string, rawEnabled = true, priorThreads: any[] = []) => {
  const runtime = await createAtapeAdapter(context)
  if (runtime.sourceCapture.protocolVersion !== SourceCaptureVersion2) throw new Error("Expected current public v2 factory")
  try {
    const root = (await readFile(file, "utf8")).split("\n").slice(0, -1).filter(Boolean).map(line => JSON.parse(line) as Row).find(row => typeof row.uuid === "string")!
    const view = await runtime.sourceCapture.open({ sourceId: root.sessionId, rawEnabled, priorThreads, ...(priorCheckpoint === undefined ? {} : { priorCheckpoint }), limits,
      projection: { events: 100000, usage: 100000, pageItems: 1, pageBytes: 32 * 1024 * 1024 }, signal: context.signal })
    try {
      const header = Schema.decodeUnknownSync(SourceCaptureHeaderV2)(view), frames: SourceCaptureFrame[] = []
      for (;;) { const page = Schema.decodeUnknownSync(SourceCapturePage)(await view.read(context.signal)); frames.push(...page.frames); if (page.done) break }
      const events = frames.flatMap(frame => frame.events), usage = frames.flatMap(frame => frame.usage)
      expect(events).toHaveLength(header.target.events); expect(usage).toHaveLength(header.target.usage)
      expect(events.map(event => event.eventIndex)).toEqual(events.map((_, index) => index))
      return { header, frames, events, usage }
    } finally { await view.close() }
  } finally { await runtime.close() }
}
type Captured = Awaited<ReturnType<typeof capture>>
const rawText = (actual: Captured, thread = "root") => actual.frames.flatMap(frame => { const raw = frame.raw as Row | undefined;
  return raw?.format === "claude.jsonl.v1" && raw.sourceThreadId === thread ? [raw.jsonl as string] : [] }).join("")
const assertComplete = (generated: Generated, actual: Captured, thread = "root") => {
  const events = actual.events.filter(event => event.sourceThreadId === thread), usage = actual.usage.filter(sample => sample.sourceThreadId === thread)
  expect(events.map(event => event.sourceEventId)).toEqual(generated.eventIds)
  expect(usage.map(sample => sample.sourceUsageId).sort()).toEqual([...generated.usages.keys()].sort())
  for (const [api, expected] of generated.usages) expect(usage.find(sample => sample.sourceUsageId === api)).toMatchObject({ inputTokens: expected.input_tokens, outputTokens: expected.output_tokens })
  expect(JSON.stringify(events)).not.toMatch(/GEN_INTERNAL_|No response requested|local-command|command-name/)
  expect(rawText(actual, thread)).toBe(generated.text)
}
it.each([1, 2, 3, 10, 100])("captures %i generated compaction cycles through the shipped factory", async count => {
  const generated = generate(Array.from({ length: count }, (_, index) => ({ trigger: index % 3 === 1 ? "manual" : "auto", tools: index % 4, files: [0, 1, 3, 5][index % 4]!, gap: index % 3, reverse: index % 2 === 1 })))
  await writeFile(file, generated.text); const actual = await capture(); assertComplete(generated, actual)
  expect(await capture(actual.header.sourceCheckpoint)).toEqual(actual)
}, 180000)
it.each([0, 1, 2, 3, 5])("normalizes %i Read calls, reversed results and reused paths", async tools => {
  const generated = generate([{ trigger: "auto", tools, files: 4, gap: 0, reverse: true }, { trigger: "auto", tools, files: 0, gap: 2 }])
  await writeFile(file, generated.text); const actual = await capture(); assertComplete(generated, actual)
  expect(actual.events.filter(event => event.update.sessionUpdate === "tool_call_update")).toHaveLength(tools * 2)
})
it.each([false, true])("accepts tool-first continuation and compatible generated version (new version %s)", async nextVersion => {
  const generated = generate([{ trigger: "auto", tools: 1, files: 3, gap: 0, toolFirst: true }, { trigger: "manual", tools: 1, files: 0, gap: 2 }])
  if (nextVersion) { for (const row of generated.rows) row.version = "2.1.264"; generated.text = serialize(generated.rows) }
  await writeFile(file, generated.text); assertComplete(generated, await capture())
})
it("continues every complete-line cut and ignores partial LF tails with authenticated public checkpoints", async () => {
  const generated = generate([{ trigger: "auto", tools: 2, files: 3, gap: 0, reverse: true }, { trigger: "manual", tools: 3, files: 1, gap: 1 }])
  let prior: string | undefined
  for (let index = 3; index <= generated.lines.length; index++) {
    const text = generated.lines.slice(0, index).join(""), partial = generated.lines[index]?.slice(0, 30) ?? ""
    await writeFile(file, text + partial)
    const actual = await capture(prior)
    expect(actual.events.map(event => event.sourceEventId)).toEqual(generated.rows.slice(0, index).filter((_, n) => generated.canonical.has(n)).map(row => `${row.uuid}:0`))
    expect(rawText(actual)).toBe(text); prior = actual.header.sourceCheckpoint
  }
}, 60000)
it("backfills every physical row after Raw-off without changing the complete canonical view", async () => {
  const generated = generate([{ trigger: "auto", tools: 2, files: 3, gap: 0 }, { trigger: "manual", tools: 3, files: 0, gap: 2 }])
  await writeFile(file, generated.text); const off = await capture(undefined, false)
  expect(off.frames.every(frame => frame.raw === undefined)).toBe(true)
  const on = await capture(off.header.sourceCheckpoint); assertComplete(generated, on)
  expect(on.events).toEqual(off.events); expect(on.usage).toEqual(off.usage); expect(on.header).toEqual(off.header)
})
const rejectAppend = async (generated: Generated, mutate: (rows: Row[], group: Generated["groups"][number]) => void, cutAt?: "boundary" | "summary") => {
  const group = generated.groups.at(-1)!, cut = cutAt === "boundary" ? group.boundary : cutAt === "summary" ? group.summary : group.copies[0]!
  await writeFile(file, generated.lines.slice(0, cut).join("")); const before = await capture()
  const rows = structuredClone(generated.rows); mutate(rows, group); await writeFile(file, serialize(rows))
  await expect(capture(before.header.sourceCheckpoint)).rejects.toMatchObject({ reason: "unsupported" })
  await writeFile(file, generated.text); assertComplete(generated, await capture(before.header.sourceCheckpoint))
}
it.each(["value", "parent", "session", "cwd", "slug"])("rejects a changed duplicate %s without replacing authenticated proof", async field => {
  await rejectAppend(generate([{ trigger: "auto", tools: 2, files: 1, gap: 0 }, { trigger: "auto", tools: 2, files: 1, gap: 1 }]), (rows, group) => {
    const copy = rows[group.copies[0]!]!
    if (field === "value") copy.unknownSourceValue = { changed: true }
    if (field === "parent") copy.parentUuid = rows[0]!.uuid
    if (field === "session") copy.sessionId = "foreign-session"
    if (field === "cwd") copy.cwd = directory + "-foreign"
    if (field === "slug") copy.slug = "conflicting-slug"
  })
})
it.each(["logical-leaf", "unknown-preserved", "head", "anchor", "summary-parent", "summary-flags"])("rejects invalid boundary/summary %s", async variant => {
  await rejectAppend(generate([{ trigger: "auto", tools: 1, files: 0, gap: 0 }]), (rows, group) => {
    const boundary = rows[group.boundary]!, summary = rows[group.summary]!
    if (variant === "logical-leaf") boundary.logicalParentUuid = rows[0]!.uuid
    if (variant === "unknown-preserved") boundary.compactMetadata.preservedMessages.allUuids.push("unproved-uuid")
    if (variant === "head") boundary.compactMetadata.preservedSegment.headUuid = rows[0]!.uuid
    if (variant === "anchor") boundary.compactMetadata.preservedMessages.anchorUuid = rows[0]!.uuid
    if (variant === "summary-parent") summary.parentUuid = rows[0]!.uuid
    if (variant === "summary-flags") summary.isCompactSummary = false
  }, variant.startsWith("summary-") ? "summary" : "boundary")
})
const withLiteralUnknown = (line: string, value: string) => line.slice(0, -2) + `,"generatedUnknown":${value}}\n`
it.each(["nested", "reordered-keys", "wide"])("authenticates whole %s unknown copy values", async shape => {
  const generated = generate([{ trigger: "auto", tools: 1, files: 3, gap: 0 }]), group = generated.groups[0]!
  const nested = (leaf: string) => "[".repeat(10000) + leaf + "]".repeat(10000)
  const first = shape === "wide" ? JSON.stringify("w".repeat(120 * 1024)) : nested('{"first":1,"second":[null,true]}')
  generated.lines[group.originals[0]!] = withLiteralUnknown(generated.lines[group.originals[0]!]!, first)
  generated.lines[group.copies[0]!] = withLiteralUnknown(generated.lines[group.copies[0]!]!, shape === "reordered-keys" ? nested('{"second":[null,true],"first":1}') : first)
  generated.text = generated.lines.join(""); await writeFile(file, generated.text); assertComplete(generated, await capture())
})
it("rejects changed leaves in deep unknown copy values and changed acknowledged prefixes", async () => {
  const generated = generate([{ trigger: "auto", tools: 1, files: 0, gap: 0 }]), group = generated.groups[0]!
  const nested = (leaf: string) => "[".repeat(10000) + leaf + "]".repeat(10000)
  generated.lines[group.originals[0]!] = withLiteralUnknown(generated.lines[group.originals[0]!]!, nested('{"leaf":true}'))
  generated.lines[group.copies[0]!] = withLiteralUnknown(generated.lines[group.copies[0]!]!, nested('{"leaf":false}'))
  await writeFile(file, generated.lines.slice(0, group.copies[0]).join("")); const before = await capture()
  await writeFile(file, generated.lines.join("")); await expect(capture(before.header.sourceCheckpoint)).rejects.toMatchObject({ reason: "unsupported" })
  await writeFile(file, generated.text); const actual = await capture()
  generated.rows[0]!.message.content = "changed committed prefix"; await writeFile(file, serialize(generated.rows))
  await expect(capture(actual.header.sourceCheckpoint)).rejects.toMatchObject({ reason: "changed" })
})
const currentBatch = (count: number) => {
  const generated = generate([{ trigger: "auto", tools: 0, files: 0, gap: 0 },
    { trigger: "auto", tools: 2, files: 0, gap: 0 }]), group = generated.groups[1]!
  const prefix = generated.rows.slice(0, group.originals[3]!), plan = prefix.at(-1)!
  const calls = Array.from({ length: count }, (_, index) => {
    const call = structuredClone(generated.rows[group.originals[3]!]!)
    call.uuid = `00000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`
    call.parentUuid = index ? `00000000-0000-4000-a000-${String(index).padStart(12, "0")}` : plan.uuid
    call.apiBlockIndex = index + 1; call.message.id = plan.message.id
    call.message.content[0].id = `generated_multibatch_call_${index}`
    call.message.usage.input_tokens = 123; call.message.usage.output_tokens = 37
    return call
  })
  const results = calls.map((call, index) => {
    const result = structuredClone(generated.rows[group.originals[5]!]!)
    result.uuid = `00000000-0000-4000-a001-${String(index + 1).padStart(12, "0")}`
    result.parentUuid = call.uuid; result.sourceToolAssistantUUID = call.uuid
    result.message.content[0].tool_use_id = call.message.content[0].id
    result.message.content[0].content = `GEN_MULTIBATCH_RESULT ${index}`
    result.toolUseResult.file.filePath = call.message.content[0].input.file_path
    return result
  })
  return { prefix: [...prefix, ...calls], calls, results, api: plan.message.id as string }
}
it.each([2, 3, 5])("correlates %i current response tools with reversed own-call parents after compaction", async count => {
  const batch = currentBatch(count), text = serialize([...batch.prefix, ...[...batch.results].reverse()])
  await writeFile(file, text); const actual = await capture()
  expect(actual.events.slice(-count).map(event => "toolCallId" in event.update ? event.update.toolCallId : "")).toEqual([...batch.results].reverse().map(row => row.message.content[0].tool_use_id))
  expect(actual.usage.find(sample => sample.sourceUsageId === batch.api)).toMatchObject({ inputTokens: 123, outputTokens: 37 })
  expect(rawText(actual)).toBe(text)
})
it("accepts distinct same-record results and rejects duplicate completed IDs", async () => {
  const batch = currentBatch(2), combined = structuredClone(batch.results[0]!)
  combined.parentUuid = batch.calls.at(-1)!.uuid; combined.message.content = batch.results.map(row => structuredClone(row.message.content[0]))
  delete combined.sourceToolAssistantUUID; delete combined.toolUseResult
  await writeFile(file, serialize([...batch.prefix, combined])); expect((await capture()).events.slice(-2).map(event => event.sourceEventId)).toEqual([`${combined.uuid}:0`, `${combined.uuid}:1`])
  combined.message.content[1] = structuredClone(combined.message.content[0]); await writeFile(file, serialize([...batch.prefix, combined]))
  await expect(capture()).rejects.toMatchObject({ reason: "unsupported" })
})
it("runs generic compaction in a proved child and retains it when later source control is invalid", async () => {
  const sessionId = "d33bd4a6-a5ce-47d3-b4d3-91e62386940f", agentId = "a5b93406db8c7fefd", thread = `claude-agent:${agentId}`
  const root = (await readFile(new URL(`../fixtures/native-foreground-child-2.1.263/${sessionId}.jsonl`, import.meta.url), "utf8")).replaceAll("/fixture/native-foreground-child", directory)
  const generated = generate([{ trigger: "auto", tools: 2, files: 3, gap: 0, reverse: true }, { trigger: "manual", tools: 3, files: 1, gap: 1 }, { trigger: "auto", tools: 1, files: 0, gap: 2 }])
  for (const row of generated.rows) { row.sessionId = sessionId; row.isSidechain = true; row.agentId = agentId }
  generated.text = serialize(generated.rows)
  const childDirectory = join(directory, sessionId, "subagents"), childFile = join(childDirectory, `agent-${agentId}.jsonl`)
  await mkdir(childDirectory, { recursive: true }); await writeFile(file, root); await writeFile(childFile, generated.text)
  const actual = await capture(); assertComplete(generated, actual, thread)
  expect(actual.events.filter(event => event.childSourceThreadId === thread)).toHaveLength(1); expect(rawText(actual)).toBe(root)
  const boundary = generated.rows[generated.groups[0]!.boundary]!; boundary.agentId = "foreign-agent"
  await writeFile(childFile, serialize(generated.rows))
  const retained = await capture(actual.header.sourceCheckpoint, true, actual.header.threads as any[])
  expect(retained.header.target.retainedThreadIds).toEqual([thread]); expect(retained.header.sourceFailures).toEqual([{ source: childFile, reason: "changed" }])
})
