import { AdapterCollectionLimits, type AdapterCollectionPage, type AdapterCollectRequest, type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
type Round = { trigger: "auto" | "manual"; tools: number; files: number; gap: number; reverse?: boolean; toolFirst?: boolean }
type Generated = {
  rows: Row[]; text: string; lines: string[]; eventIds: string[]; usages: Map<string, Row>
  canonical: Set<number>; groups: { originals: number[]; copies: number[]; boundary: number; summary: number; answer: number }[]
}
let manual: Row[], auto: Row[]
let directory: string, file: string, context: AdapterOpenContext & { signal: AbortSignal }
let progress: AdapterCollectRequest["rawProgress"]
beforeAll(async () => {
  const parse = (text: string): Row[] => text.trimEnd().split("\n").map(line => JSON.parse(line))
  const templates = await Promise.all([
    "native-manual-read-reinjection-2.1.263/secondcontinue.jsonl",
    "native-auto-read-replay-2.1.263/auto/secondcontinue.jsonl"
  ].map(async name => parse(await readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8"))))
  manual = templates[0]!; auto = templates[1]!
})
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-generic-compaction-")); file = join(directory, "session.jsonl")
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.2" },
    project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
  progress = []
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
const request = (cursor: string | null, rawCaptureEnabled = true, limits: Partial<AdapterCollectRequest["limits"]> = {}): AdapterCollectRequest => ({
  protocolVersion: context.protocolVersion, cursor, rawProgress: progress, rawCaptureEnabled,
  limits: { ...AdapterCollectionLimits, ...limits }, signal: new AbortController().signal
})
const read = async (input: AdapterCollectRequest) => {
  const runtime = await createAtapeAdapter(context)
  try { return await runtime.collect(input) as AdapterCollectionPage } finally { await runtime.close?.() }
}
const events = (pages: AdapterCollectionPage[]) => pages.flatMap(page => page.observations.flatMap(observation => observation.events))
const samples = (pages: AdapterCollectionPage[]) => pages.flatMap(page => page.observations.flatMap(observation => observation.usage ?? []))
const raw = (pages: AdapterCollectionPage[]) => pages.flatMap(page => page.observations.flatMap(observation => observation.rawSegments))
const acknowledge = (page: AdapterCollectionPage) => {
  const receipts = new Map(progress.map(item => [item.sourceObjectId, item]))
  for (const observation of page.observations) for (const segment of observation.rawSegments) receipts.set(segment.sourceObjectId, {
    sourceSessionId: observation.session.sourceSessionId, sourceObjectId: segment.sourceObjectId, sourceGeneration: segment.sourceGeneration,
    sourceOffset: segment.sourceOffset + Buffer.byteLength(segment.content), finalized: segment.final
  })
  progress = [...receipts.values()]
}
const drain = async (cursor: string | null = null, enabled = true, limits: Partial<AdapterCollectRequest["limits"]> = {}) => {
  const pages: AdapterCollectionPage[] = []
  for (let n = 0; n < 2_000; n++) {
    const input = request(cursor, enabled, limits), page = await read(input)
    expect(await read(input)).toEqual(page); expect(page.sourceFailures).toBeUndefined()
    for (const observation of page.observations) {
      expect(observation.events.length).toBeLessThanOrEqual(input.limits.eventsPerObservation)
      expect(Buffer.byteLength(JSON.stringify({ ...observation, rawSegments: [] }))).toBeLessThanOrEqual(input.limits.canonicalBytesPerObservation)
      expect(observation.rawSegments.reduce((sum, segment) => sum + Buffer.byteLength(segment.content), 0)).toBeLessThanOrEqual(input.limits.rawBytesPerObservation)
    }
    pages.push(page); acknowledge(page); cursor = page.nextCursor
    if (!page.hasMore && !page.observations.length) return { pages, cursor }
  }
  throw new Error("Generated generic compaction did not finish bounded public pages")
}
const latest = (pages: AdapterCollectionPage[]) => {
  const result = new Map<string, AdapterUsage>()
  for (const sample of samples(pages)) {
    const old = result.get(sample.sourceUsageId)
    if (!old || sample.revision > old.revision) result.set(sample.sourceUsageId, sample)
    else if (sample.revision === old.revision) expect(sample).toEqual(old)
  }
  return result
}
const assertRaw = (pages: AdapterCollectionPage[], text: string, complete = true) => {
  let offset = 0
  for (const segment of raw(pages)) { expect(segment.sourceOffset).toBe(offset); offset += Buffer.byteLength(segment.content) }
  const value = raw(pages).map(segment => segment.content).join("")
  expect(text.startsWith(value)).toBe(true)
  if (complete) { expect(value).toBe(text); expect(new Set(raw(pages).map(segment => segment.sourceObjectId)).size).toBe(1)
    expect(new Set(raw(pages).map(segment => segment.sourceGeneration)).size).toBe(1) }
}
const assertComplete = (generated: Generated, pages: AdapterCollectionPage[]) => {
  expect(events(pages).map(event => event.sourceEventId)).toEqual(generated.eventIds)
  const actual = latest(pages)
  expect([...actual.keys()].sort()).toEqual([...generated.usages.keys()].sort())
  const canonicalIds = new Set(generated.rows.filter((_, index) => generated.canonical.has(index)).map(row => row.uuid))
  const seen = new Set<string>(), latestRevisions = new Map<string, number>(), originalRevisions = new Map<string, Set<number>>()
  let end = 0
  for (const line of generated.text.split(/(?<=\n)/).filter(Boolean)) {
    end += Buffer.byteLength(line)
    const row = JSON.parse(line) as Row
    if (seen.has(row.uuid)) continue
    if (typeof row.uuid === "string") seen.add(row.uuid)
    if (row.type !== "assistant" || !canonicalIds.has(row.uuid)) continue
    latestRevisions.set(row.message.id, end)
    const revisions = originalRevisions.get(row.message.id) ?? new Set<number>(); revisions.add(end)
    originalRevisions.set(row.message.id, revisions)
  }
  for (const [api, expected] of generated.usages) {
    expect(actual.get(api)).toMatchObject({ inputTokens: expected.input_tokens, outputTokens: expected.output_tokens, revision: latestRevisions.get(api) })
  }
  for (const sample of samples(pages)) expect(originalRevisions.get(sample.sourceUsageId)?.has(sample.revision)).toBe(true)
  expect(JSON.stringify(events(pages))).not.toMatch(/GEN_INTERNAL_|No response requested|local-command|command-name/)
  assertRaw(pages, generated.text)
}

it.each([1, 2, 3, 10, 100])("captures %i generated compaction rounds without a round-number policy", async count => {
  const source = generate(Array.from({ length: count }, (_, index) => ({ trigger: index % 3 === 1 ? "manual" : "auto",
    tools: index % 4, files: [0, 1, 3, 5][index % 4]!, gap: index % 3, reverse: index % 2 === 1 })))
  await writeFile(file, source.text)
  const captured = await drain(null, true, { eventsPerObservation: count > 10 ? 100 : 1 })
  assertComplete(source, captured.pages)
  expect((await read(request(captured.cursor))).observations).toEqual([])
}, 60_000)

it.each([0, 1, 2, 3, 5])("normalizes copied histories with %i linear or paired Read calls and reused paths", async tools => {
  const generated = generate([{ trigger: "auto", tools, files: 4, gap: 0, reverse: true },
    { trigger: "auto", tools, files: 0, gap: 2, reverse: false }])
  await writeFile(file, generated.text); const captured = await drain(null, true, { eventsPerObservation: 1 })
  assertComplete(generated, captured.pages)
  const updates = events(captured.pages).filter(event => event.update.sessionUpdate === "tool_call_update")
  expect(updates).toHaveLength(tools * 2)
  expect(new Set(updates.map(event => "toolCallId" in event.update ? event.update.toolCallId : "")).size).toBe(tools * 2)
})

it("accepts a real tool call immediately after summary and Raw-only files, without a first-text rule", async () => {
  const generated = generate([{ trigger: "auto", tools: 1, files: 3, gap: 0, toolFirst: true }])
  await writeFile(file, generated.text); assertComplete(generated, (await drain(null, true, { eventsPerObservation: 1 })).pages)
})
it("normalizes the same generated record schemas at version 2.1.264 without claiming new native-version evidence", async () => {
  const generated = generate([{ trigger: "auto", tools: 2, files: 3, gap: 0, reverse: true },
    { trigger: "manual", tools: 1, files: 0, gap: 2 }])
  for (const row of generated.rows) row.version = "2.1.264"
  generated.text = serialize(generated.rows)
  await writeFile(file, generated.text); assertComplete(generated, (await drain(null, true, { eventsPerObservation: 1 })).pages)
})

it("survives every generated complete-line cut and partial EOF with fresh runtimes and exact retries", async () => {
  const generated = generate([{ trigger: "auto", tools: 2, files: 3, gap: 0, reverse: true },
    { trigger: "manual", tools: 3, files: 1, gap: 1 }])
  const all: AdapterCollectionPage[] = []
  let cursor: string | null = null, text = generated.lines.slice(0, 3).join("")
  await writeFile(file, text); const seed = await drain(); all.push(...seed.pages); cursor = seed.cursor
  for (let index = 3; index < generated.lines.length; index++) {
    const line = generated.lines[index]!, partial = line.slice(0, Math.floor(line.length / 2))
    await writeFile(file, text + partial)
    const waiting = await drain(cursor, true, { eventsPerObservation: 1 }); all.push(...waiting.pages); cursor = waiting.cursor
    expect(events(all).map(event => event.sourceEventId)).toEqual(generated.rows.slice(0, index)
      .filter((_, position) => generated.canonical.has(position)).map(row => `${row.uuid}:0`))
    assertRaw(all, text)
    text += line; await writeFile(file, text)
    const completed = await drain(cursor, true, { eventsPerObservation: 1 }); all.push(...completed.pages); cursor = completed.cursor
    expect(events(all).map(event => event.sourceEventId)).toEqual(generated.rows.slice(0, index + 1)
      .filter((_, position) => generated.canonical.has(position)).map(row => `${row.uuid}:0`))
    assertRaw(all, text)
  }
  assertComplete(generated, all)
}, 60_000)

it("backfills all source bytes after Raw-off capture under small caller budgets without replaying Events or API samples", async () => {
  const generated = generate(Array.from({ length: 3 }, (_, index) => ({ trigger: index % 2 ? "manual" : "auto",
    tools: index, files: index + 1, gap: index })))
  await writeFile(file, generated.text)
  const canonical = await drain(null, false, { eventsPerObservation: 1, canonicalBytesPerObservation: 12_000 })
  expect(raw(canonical.pages)).toEqual([])
  const backfill = await drain(canonical.cursor, true, { eventsPerObservation: 1, rawSegmentBytes: 4096, rawBytesPerObservation: 4096 })
  expect(events(backfill.pages)).toEqual([]); expect(samples(backfill.pages)).toEqual([])
  assertComplete(generated, [...canonical.pages, ...backfill.pages])
})

const rejectAfterOriginals = async (generated: Generated, change: (rows: Row[], group: Generated["groups"][number]) => void, reason = "unsupported", at: "copy" | "boundary" | "summary" = "copy") => {
  const group = generated.groups.at(-1)!, cut = at === "boundary" ? group.boundary : at === "summary" ? group.summary : group.copies[0] ?? group.boundary
  await writeFile(file, generated.lines.slice(0, cut).join("")); const before = await drain(null, true, { eventsPerObservation: 1 })
  const saved = structuredClone(progress), rows = structuredClone(generated.rows)
  change(rows, group); await writeFile(file, serialize(rows))
  const input = request(before.cursor)
  await expect(read(input)).rejects.toMatchObject({ reason }); await expect(read(input)).rejects.toMatchObject({ reason })
  expect(progress).toEqual(saved); expect(input.cursor).toBe(before.cursor)
  await writeFile(file, generated.text); const repaired = await drain(before.cursor, true, { eventsPerObservation: 1 })
  assertComplete(generated, [...before.pages, ...repaired.pages])
}
it.each(["value", "parent", "session", "cwd", "slug"])("rejects a changed duplicate %s without advancing acknowledged history", async field => {
  await rejectAfterOriginals(generate([{ trigger: "auto", tools: 2, files: 1, gap: 0 }, { trigger: "auto", tools: 2, files: 1, gap: 1 }]), (rows, group) => {
    const copy = rows[group.copies[0]!]!
    if (field === "value") copy.unknownSourceValue = { different: [null, { payload: true }] }
    if (field === "parent") copy.parentUuid = rows[0]!.uuid
    if (field === "session") copy.sessionId = "foreign-session"
    if (field === "cwd") copy.cwd = directory + "-foreign"
    if (field === "slug") copy.slug = "conflicting-slug"
  })
})
it.each(["logical-leaf", "unknown-preserved", "head", "anchor", "summary-parent", "summary-flags"])("rejects invalid generated boundary/summary %s and can repair from the old ACK", async variant => {
  await rejectAfterOriginals(generate([{ trigger: "auto", tools: 1, files: 0, gap: 0 }]), (rows, group) => {
    const boundary = rows[group.boundary]!, summary = rows[group.summary]!
    if (variant === "logical-leaf") boundary.logicalParentUuid = rows[0]!.uuid
    if (variant === "unknown-preserved") boundary.compactMetadata.preservedMessages.allUuids.push("unproved-uuid")
    if (variant === "head") boundary.compactMetadata.preservedSegment.headUuid = rows[0]!.uuid
    if (variant === "anchor") boundary.compactMetadata.preservedMessages.anchorUuid = rows[0]!.uuid
    if (variant === "summary-parent") summary.parentUuid = rows[0]!.uuid
    if (variant === "summary-flags") summary.isCompactSummary = false
  }, "unsupported", variant.startsWith("summary-") ? "summary" : "boundary")
})
it("rejects changed bytes in a fully acknowledged prefix after many compactions", async () => {
  const generated = generate(Array.from({ length: 10 }, () => ({ trigger: "auto", tools: 0, files: 0, gap: 0 })))
  await writeFile(file, generated.text); const before = await drain()
  const saved = structuredClone(progress), rows = structuredClone(generated.rows)
  rows[0]!.message.content = "GEN_USER changed acknowledged prefix"
  await writeFile(file, serialize(rows))
  await expect(read(request(before.cursor))).rejects.toMatchObject({ reason: "changed" })
  expect(progress).toEqual(saved)
})

const withLiteralUnknown = (line: string, payload: string) => line.slice(0, -2) + `,"generatedUnknown":${payload}}\n`
it.each(["nested", "reordered-keys", "wide"])("compares whole %s unknown JSON values without recursive overflow or an old proof-size gate", async shape => {
  const generated = generate([{ trigger: "auto", tools: 1, files: 3, gap: 0 }]), group = generated.groups[0]!
  const original = group.originals[0]!, copy = group.copies[0]!
  const nested = (leaf: string) => "[".repeat(10_000) + leaf + "]".repeat(10_000)
  const first = shape === "wide" ? JSON.stringify("w".repeat(120 * 1024)) : nested('{"first":1,"second":[null,true]}')
  const second = shape === "reordered-keys" ? nested('{"second":[null,true],"first":1}') : first
  generated.lines[original] = withLiteralUnknown(generated.lines[original]!, first)
  generated.lines[copy] = withLiteralUnknown(generated.lines[copy]!, second)
  generated.text = generated.lines.join("")
  await writeFile(file, generated.text); assertComplete(generated, (await drain(null, true, { eventsPerObservation: 1 })).pages)
})
it("rejects a changed leaf in a 10,000-level unknown JSON copy through a typed failure", async () => {
  const generated = generate([{ trigger: "auto", tools: 1, files: 0, gap: 0 }]), group = generated.groups[0]!
  const nested = (leaf: string) => "[".repeat(10_000) + leaf + "]".repeat(10_000)
  generated.lines[group.originals[0]!] = withLiteralUnknown(generated.lines[group.originals[0]!]!, nested('{"leaf":true}'))
  generated.lines[group.copies[0]!] = withLiteralUnknown(generated.lines[group.copies[0]!]!, nested('{"leaf":false}'))
  const beforeText = generated.lines.slice(0, group.copies[0]).join("")
  await writeFile(file, beforeText); const before = await drain()
  const saved = structuredClone(progress); await writeFile(file, generated.lines.join(""))
  await expect(read(request(before.cursor))).rejects.toMatchObject({ reason: "unsupported" })
  expect(progress).toEqual(saved)
})
it("keeps compaction reusable after a 3MiB UUID-less gap and a greater-than-100KiB original/copy frame", async () => {
  const generated = generate([{ trigger: "auto", tools: 2, files: 0, gap: 0, reverse: true },
    { trigger: "auto", tools: 2, files: 3, gap: 80, reverse: false }]), group = generated.groups[1]!
  const body = JSON.stringify("proof-wide ".repeat(12_000))
  generated.lines[group.originals[0]!] = withLiteralUnknown(generated.lines[group.originals[0]!]!, body)
  generated.lines[group.copies[0]!] = withLiteralUnknown(generated.lines[group.copies[0]!]!, body)
  const metadata = JSON.stringify({ type: "queue-operation", operation: "dequeue", sessionId: generated.rows[0]!.sessionId,
    generatedUnknown: "gap ".repeat(768 * 1024) }) + "\n"
  generated.lines.splice(group.originals[0]!, 0, metadata); generated.text = generated.lines.join("")
  await writeFile(file, generated.text); assertComplete(generated, (await drain()).pages)
}, 60_000)

it.each([false, true])("uses the latest unchanged-slug duplicate as evidence, changed slug=%s", async changed => {
  const generated = generate([{ trigger: "auto", tools: 0, files: 0, gap: 0 }, { trigger: "auto", tools: 0, files: 0, gap: 1 }])
  const first = generated.groups[0]!, second = generated.groups[1]!, at = second.copies[0]!
  const repeated = structuredClone(generated.rows[first.copies[0]!]!)
  const valid = [...generated.rows.slice(0, at), repeated, ...generated.rows.slice(at)], validText = serialize(valid)
  if (!changed) {
    generated.text = validText; await writeFile(file, validText); assertComplete(generated, (await drain()).pages); return
  }
  await writeFile(file, generated.lines.slice(0, at).join("")); const before = await drain(), saved = structuredClone(progress)
  repeated.slug = "generated-conflicting-later-slug"
  await writeFile(file, serialize([...generated.rows.slice(0, at), repeated, ...generated.rows.slice(at)]))
  await expect(read(request(before.cursor))).rejects.toMatchObject({ reason: "unsupported" }); expect(progress).toEqual(saved)
  await writeFile(file, validText); const resumed = await drain(before.cursor)
  generated.text = validText; assertComplete(generated, [...before.pages, ...resumed.pages])
})
it("preserves the summary ACK when the next real turn uses a stale parent, then accepts its repaired chain", async () => {
  const generated = generate([{ trigger: "auto", tools: 1, files: 0, gap: 0 }]), group = generated.groups[0]!
  await writeFile(file, generated.lines.slice(0, group.answer).join("")); const before = await drain(), saved = structuredClone(progress)
  const damaged = structuredClone(generated.rows); damaged[group.answer]!.parentUuid = damaged[0]!.uuid
  await writeFile(file, serialize(damaged))
  await expect(read(request(before.cursor))).rejects.toMatchObject({ reason: "unsupported" }); expect(progress).toEqual(saved)
  await writeFile(file, generated.text); assertComplete(generated, [...before.pages, ...(await drain(before.cursor)).pages])
})
it("requires B1's declared S1 before allowing any subsequent B2, independently of the number of rounds", async () => {
  const generated = generate([{ trigger: "auto", tools: 1, files: 0, gap: 0 }]), group = generated.groups[0]!
  const beforeText = generated.lines.slice(0, group.boundary + 1).join("")
  await writeFile(file, beforeText); const before = await drain(), saved = structuredClone(progress)
  const b1 = generated.rows[group.boundary]!, b2 = structuredClone(b1), s2 = structuredClone(generated.rows[group.summary]!)
  b2.uuid = "00000000-0000-4000-9000-000000000001"; s2.uuid = "00000000-0000-4000-9000-000000000002"
  b2.logicalParentUuid = b1.uuid; s2.parentUuid = b2.uuid
  b2.compactMetadata.preservedSegment = { headUuid: b1.uuid, tailUuid: b1.uuid, anchorUuid: s2.uuid }
  b2.compactMetadata.preservedMessages = { anchorUuid: s2.uuid, uuids: [b1.uuid], allUuids: [b1.uuid] }
  await writeFile(file, beforeText + serialize([b2, s2]))
  const input = request(before.cursor)
  await expect(read(input)).rejects.toMatchObject({ reason: "unsupported" }); await expect(read(input)).rejects.toMatchObject({ reason: "unsupported" })
  expect(progress).toEqual(saved)
  await writeFile(file, generated.text); assertComplete(generated, [...before.pages, ...(await drain(before.cursor)).pages])
})
const damageEventSkip = (cursor: string) => {
  const value = JSON.parse(cursor.startsWith("z3:") ? inflateRawSync(Buffer.from(cursor.slice(3), "base64url")).toString() : cursor)
  const checkpoint = value.sessions ? value.sessions[0].checkpoint : value
  checkpoint.stream.eventSkip = 1
  return JSON.stringify(value)
}
it.each(["copies", "boundary", "summary"].flatMap(stage => ["EOF", "partial", "blank"].map(ending => [stage, ending] as const)))
("rejects a damaged nonzero Event skip at a Raw-only %s ACK followed by %s", async (stage, ending) => {
  const generated = generate([{ trigger: "auto", tools: 1, files: 1, gap: 0 }]), group = generated.groups[0]!
  const through = stage === "copies" ? group.copies[0]! + 1 : stage === "boundary" ? group.boundary + 1 : group.summary + 1
  const beforeText = generated.lines.slice(0, through).join("")
  await writeFile(file, beforeText); const before = await drain(), saved = structuredClone(progress)
  await writeFile(file, beforeText + (ending === "partial" ? generated.lines[through]!.slice(0, 30) : ending === "blank" ? "\n" : ""))
  await expect(read(request(damageEventSkip(before.cursor!)))).rejects.toMatchObject({ reason: "cursor" })
  expect(progress).toEqual(saved)
})
it.each(["JSON", "UTF-8"])("rejects a malformed complete %s copied frame without resetting the genuine ACK", async format => {
  const generated = generate([{ trigger: "auto", tools: 1, files: 0, gap: 0 }]), group = generated.groups[0]!
  const beforeText = generated.lines.slice(0, group.copies[0]).join("")
  await writeFile(file, beforeText); const before = await drain(), saved = structuredClone(progress)
  const malformed = format === "JSON" ? Buffer.from("{broken}\n") : Buffer.from([123, 34, 255, 34, 58, 49, 125, 10])
  await writeFile(file, Buffer.concat([Buffer.from(beforeText), malformed]))
  await expect(read(request(before.cursor))).rejects.toMatchObject({ reason: "format" }); expect(progress).toEqual(saved)
  await writeFile(file, generated.text); assertComplete(generated, [...before.pages, ...(await drain(before.cursor)).pages])
})
it("enforces the ordinary 16MiB record limit while preserving earlier acknowledged conversation", async () => {
  const generated = generate([{ trigger: "auto", tools: 0, files: 0, gap: 0 }]), group = generated.groups[0]!
  const beforeText = generated.lines.slice(0, group.copies[0]).join("")
  await writeFile(file, beforeText); const before = await drain(), saved = structuredClone(progress)
  const enormous = withLiteralUnknown(generated.lines[group.copies[0]!]!, JSON.stringify("oversize ".repeat(2 * 1024 * 1024)))
  await writeFile(file, beforeText + enormous)
  await expect(read(request(before.cursor))).rejects.toMatchObject({ reason: "limit" }); expect(progress).toEqual(saved)
})

const generatedFamily = async () => {
  const sessionId = "d33bd4a6-a5ce-47d3-b4d3-91e62386940f", agentId = "a5b93406db8c7fefd"
  const native = new URL("../fixtures/native-foreground-child-2.1.263/", import.meta.url)
  const root = (await readFile(new URL(`${sessionId}.jsonl`, native), "utf8")).replaceAll("/fixture/native-foreground-child", directory)
  const child = generate([{ trigger: "auto", tools: 2, files: 3, gap: 0, reverse: true },
    { trigger: "manual", tools: 3, files: 1, gap: 1 }, { trigger: "auto", tools: 1, files: 0, gap: 2 }])
  // Only the selected foreground relationship comes from native evidence. The
  // child's three compactions are generated contract sources, not native runs.
  for (const row of child.rows) { row.sessionId = sessionId; row.isSidechain = true; row.agentId = agentId }
  child.lines = child.rows.map(row => JSON.stringify(row) + "\n"); child.text = child.lines.join("")
  const childDirectory = join(directory, sessionId, "subagents"), childPath = join(childDirectory, `agent-${agentId}.jsonl`)
  await mkdir(childDirectory, { recursive: true }); await writeFile(file, root); await writeFile(childPath, child.text)
  return { child, childPath, root, threadId: `claude-agent:${agentId}` }
}
it("runs the same generated compaction continuity inside a proved foreground child Thread without changing root ownership", async () => {
  const family = await generatedFamily(), captured = await drain(null, true, { eventsPerObservation: 1 })
  const childPages = captured.pages.map(page => ({ ...page, observations: page.observations
    .filter(observation => observation.events.some(event => event.sourceThreadId === family.threadId) ||
      observation.rawSegments.some(segment => segment.sourceName.startsWith("agent-"))) }))
  assertComplete(family.child, childPages)
  expect(events(captured.pages).filter(event => event.childSourceThreadId === family.threadId)).toHaveLength(1)
  expect(events(childPages).every(event => event.sourceThreadId === family.threadId)).toBe(true)
  expect(samples(childPages).every(sample => sample.sourceThreadId === family.threadId)).toBe(true)
  const root = raw(captured.pages).filter(segment => !segment.sourceName.startsWith("agent-"))
  expect(root.map(segment => segment.content).join("")).toBe(family.root)
  expect(new Set(raw(captured.pages).map(segment => segment.sourceObjectId)).size).toBe(2)
})
it.each(["agentId", "isSidechain"])("isolates a generated child compaction control with conflicting %s", async field => {
  const family = await generatedFamily(), group = family.child.groups[0]!
  await writeFile(family.childPath, family.child.lines.slice(0, group.boundary).join(""))
  const before = await drain(null, true, { eventsPerObservation: 1 }), saved = structuredClone(progress)
  const damaged = structuredClone(family.child.rows)
  damaged[group.boundary]![field] = field === "agentId" ? "foreign-agent" : false
  await writeFile(family.childPath, serialize(damaged))
  const input = request(before.cursor), page = await read(input)
  expect(await read(input)).toEqual(page)
  expect(page.sourceFailures).toEqual([{ source: family.childPath, reason: "unsupported" }])
  expect(events([page])).toEqual([]); expect(raw([page])).toEqual([]); expect(progress).toEqual(saved)
  await writeFile(family.childPath, family.child.text)
  expect((await drain(before.cursor, true, { eventsPerObservation: 1 })).pages.every(page => !page.sourceFailures)).toBe(true)
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
it("commits two distinct tool results in one user record after compaction, including one-event deferred record progress", async () => {
  const batch = currentBatch(2), combined = structuredClone(batch.results[0]!)
  combined.parentUuid = batch.calls.at(-1)!.uuid
  combined.message.content = batch.results.map(result => structuredClone(result.message.content[0]))
  // One top-level native receipt cannot describe two different calls. The
  // actual user blocks carry their own distinct IDs and use the current leaf.
  delete combined.sourceToolAssistantUUID; delete combined.toolUseResult
  const beforeText = serialize(batch.prefix)
  await writeFile(file, beforeText); const before = await drain(null, true, { eventsPerObservation: 1 })
  const text = beforeText + serialize([combined]); await writeFile(file, text)
  const after = await drain(before.cursor, true, { eventsPerObservation: 1 }), updates = events(after.pages)
  expect(updates.map(event => event.sourceEventId)).toEqual([`${combined.uuid}:0`, `${combined.uuid}:1`])
  expect(updates.map(event => "toolCallId" in event.update ? event.update.toolCallId : "")).toEqual(batch.calls.map(call => call.message.content[0].id))
  expect(samples(after.pages)).toEqual([])
  expect(latest([...before.pages, ...after.pages]).get(batch.api)).toMatchObject({ inputTokens: 123, outputTokens: 37,
    revision: Buffer.byteLength(beforeText) })
  assertRaw([...before.pages, ...after.pages], text)
})
it("rejects two same-record tool results for the same pending ID before producing duplicate completed updates", async () => {
  const batch = currentBatch(2), combined = structuredClone(batch.results[0]!)
  combined.parentUuid = batch.calls.at(-1)!.uuid
  combined.message.content = [structuredClone(combined.message.content[0]), structuredClone(combined.message.content[0])]
  delete combined.sourceToolAssistantUUID; delete combined.toolUseResult
  const beforeText = serialize(batch.prefix)
  await writeFile(file, beforeText); const before = await drain(null, true, { eventsPerObservation: 1 }), saved = structuredClone(progress)
  await writeFile(file, beforeText + serialize([combined]))
  const input = request(before.cursor)
  await expect(read(input)).rejects.toMatchObject({ reason: "unsupported" }); await expect(read(input)).rejects.toMatchObject({ reason: "unsupported" })
  expect(progress).toEqual(saved)
  combined.message.content[1] = structuredClone(batch.results[1]!.message.content[0])
  const repaired = beforeText + serialize([combined]); await writeFile(file, repaired)
  const after = await drain(before.cursor, true, { eventsPerObservation: 1 })
  expect(events(after.pages)).toHaveLength(2); assertRaw([...before.pages, ...after.pages], repaired)
})
it.each([3, 5])("keeps %i tools in one current response and admits reverse own-call result parents after compaction", async count => {
  const batch = currentBatch(count), beforeText = serialize(batch.prefix)
  await writeFile(file, beforeText); const before = await drain(null, true, { eventsPerObservation: 1 })
  const results = [...batch.results].reverse(), text = beforeText + serialize(results)
  await writeFile(file, text); const after = await drain(before.cursor, true, { eventsPerObservation: 1 })
  expect(events(after.pages).map(event => "toolCallId" in event.update ? event.update.toolCallId : "")).toEqual(results.map(result => result.message.content[0].tool_use_id))
  expect(new Set(events(after.pages).map(event => event.sourceEventId)).size).toBe(count)
  expect(samples(after.pages)).toEqual([])
  expect(latest([...before.pages, ...after.pages]).get(batch.api)).toMatchObject({ inputTokens: 123, outputTokens: 37,
    revision: Buffer.byteLength(beforeText) })
  assertRaw([...before.pages, ...after.pages], text)
})
