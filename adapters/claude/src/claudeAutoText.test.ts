import { AdapterCollectionLimits, type AdapterCollectionPage, type AdapterCollectRequest, type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
const fixture = new URL("../fixtures/native-auto-text-replay-rounds-2.1.263/", import.meta.url)
let directory: string, file: string, context: AdapterOpenContext & { signal: AbortSignal }
let snapshots: string[], progress: AdapterCollectRequest["rawProgress"]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "atape-claude-auto-text-")); file = join(directory, "session.jsonl")
  snapshots = await Promise.all(["seed", "warmup", "continue", "secondcontinue", "thirdcontinue"].map(async name =>
    (await readFile(new URL(`${name}.jsonl`, fixture), "utf8")).replaceAll("/fixture/native-auto-text-replay-rounds/workspace", directory)))
  await writeFile(file, snapshots[4]!)
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.2" },
    project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
  progress = []
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
const rows = (source: string): Row[] => source.trimEnd().split("\n").map(line => JSON.parse(line))
const lines = (records: Row[]) => records.map(row => JSON.stringify(row)).join("\n") + "\n"
const prefix = (source: string, count: number) => source.split(/(?<=\n)/).slice(0, count).join("")
const request = (cursor: string | null = null, raw = true, limits: Partial<AdapterCollectRequest["limits"]> = {}): AdapterCollectRequest => ({
  protocolVersion: "atape.adapter.v1alpha1", cursor, rawProgress: progress, rawCaptureEnabled: raw,
  limits: { ...AdapterCollectionLimits, ...limits }, signal: new AbortController().signal
})
const read = async (input = request()) => await (await createAtapeAdapter(context)).collect(input) as AdapterCollectionPage
const acknowledge = (page: AdapterCollectionPage) => {
  const receipts = new Map(progress.map(item => [item.sourceObjectId, item]))
  for (const observation of page.observations) for (const raw of observation.rawSegments) receipts.set(raw.sourceObjectId, {
    sourceSessionId: observation.session.sourceSessionId, sourceObjectId: raw.sourceObjectId, sourceGeneration: raw.sourceGeneration,
    sourceOffset: raw.sourceOffset + Buffer.byteLength(raw.content), finalized: raw.final
  })
  progress = [...receipts.values()]
}
const events = (pages: AdapterCollectionPage[]) => pages.flatMap(page => page.observations.flatMap(observation => observation.events))
const raw = (pages: AdapterCollectionPage[]) => pages.flatMap(page => page.observations.flatMap(observation => observation.rawSegments))
const usage = (pages: AdapterCollectionPage[]) => pages.flatMap(page => page.observations.flatMap(observation => observation.usage ?? []))
const drain = async (cursor: string | null = null, rawEnabled = true, limits: Partial<AdapterCollectRequest["limits"]> = {}) => {
  const pages: AdapterCollectionPage[] = []
  for (let n = 0; n < 150; n++) {
    const input = request(cursor, rawEnabled, limits), page = await read(input)
    expect(await read(input)).toEqual(page)
    expect(page.sourceFailures).toBeUndefined()
    for (const observation of page.observations) {
      expect(Buffer.byteLength(JSON.stringify({ ...observation, rawSegments: [] }))).toBeLessThanOrEqual(input.limits.canonicalBytesPerObservation)
      expect(observation.events.length).toBeLessThanOrEqual(input.limits.eventsPerObservation)
      expect(observation.rawSegments.reduce((sum, segment) => sum + Buffer.byteLength(segment.content), 0)).toBeLessThanOrEqual(input.limits.rawBytesPerObservation)
    }
    pages.push(page); acknowledge(page); cursor = page.nextCursor
    if (!page.hasMore && !page.observations.length) return { pages, cursor }
  }
  throw new Error("Claude automatic text collection did not finish bounded pages")
}
const latestUsage = (pages: AdapterCollectionPage[]) => {
  const samples = new Map<string, AdapterUsage>()
  for (const sample of usage(pages)) {
    const key = `${sample.sourceThreadId}\0${sample.sourceUsageId}`, previous = samples.get(key)
    if (!previous || sample.revision > previous.revision) samples.set(key, sample)
    else if (sample.revision === previous.revision) expect(sample).toEqual(previous)
  }
  return { records: samples.size, input: [...samples.values()].reduce((sum, sample) => sum + sample.inputTokens!, 0),
    output: [...samples.values()].reduce((sum, sample) => sum + sample.outputTokens!, 0) }
}
const expectRaw = (pages: AdapterCollectionPage[], source: string) => {
  const segments = raw(pages)
  expect(new Set(segments.map(segment => segment.sourceObjectId)).size).toBe(1)
  expect(new Set(segments.map(segment => segment.sourceGeneration)).size).toBe(1)
  let offset = 0
  for (const segment of segments) { expect(segment.sourceOffset).toBe(offset); offset += Buffer.byteLength(segment.content) }
  expect(segments.map(segment => segment.content).join("")).toBe(source)
}

it("captures three native rounds through acknowledged originals, pending summaries and fresh-runtime one-event retries", async () => {
  await writeFile(file, snapshots[1]!)
  const initial = await drain(null, true, { eventsPerObservation: 1 }), captured = [...initial.pages], original = events(initial.pages)
  expect(original).toHaveLength(4)
  expect(latestUsage(captured)).toEqual({ records: 2, input: 190023, output: 24 })
  let cursor = initial.cursor, previous = snapshots[1]!
  for (const [round, g, s] of [[0, 21, 25], [1, 34, 38], [2, 47, 51]] as const) {
    const source = snapshots[round + 2]!, originals = prefix(source, g), summary = prefix(source, s)
    await appendFile(file, originals.slice(previous.length))
    const before = await drain(cursor, true, { eventsPerObservation: 1 }); captured.push(...before.pages)
    expect(events(before.pages)).toHaveLength(1); expect(usage(before.pages)).toEqual([])
    expect(before.pages.at(-1)!.progress?.pendingCanonicalSessions).toBe(0)
    await appendFile(file, summary.slice(originals.length))
    const controls = await drain(before.cursor, true, { eventsPerObservation: 1 }); captured.push(...controls.pages)
    expect(events(controls.pages)).toEqual([]); expect(usage(controls.pages)).toEqual([])
    const idle = controls.pages.at(-1)!
    expect(idle.progress).toMatchObject({ pendingCanonicalSessions: 1, pendingRawBytes: 0, phase: "idle" })
    expect((await read(request(controls.cursor))).nextCursor).toBe(controls.cursor)
    await appendFile(file, source.slice(summary.length))
    const answer = await drain(controls.cursor, true, { eventsPerObservation: 1 }); captured.push(...answer.pages)
    expect(events(answer.pages)).toHaveLength(1); expect(usage(answer.pages)).toHaveLength(1)
    expect(answer.pages.at(-1)!.progress?.pendingCanonicalSessions).toBe(0)
    expect(latestUsage(captured)).toEqual({ records: round + 3, input: 380023 + round * 190000, output: 37 + round * 13 })
    cursor = answer.cursor; previous = source
  }
  expect(events(captured)).toHaveLength(10)
  expect(new Set(events(captured).map(event => event.sourceEventId)).size).toBe(10)
  expect(events(captured).slice(0, 4)).toEqual(original)
  expect(JSON.stringify(events(captured))).not.toMatch(/ATAPE_AUTO_TEXT_SUMMARY|isCompactSummary|total_tokens_reminder/)
  expectRaw(captured, snapshots[4]!)
})

it("proves newly committed same-page originals and repeated stable slugs without replaying Canonical data on Raw backfill", async () => {
  const runtime = await createAtapeAdapter(context), captured: AdapterCollectionPage[] = []
  let cursor: string | null = null
  for (let n = 0; n < 40; n++) {
    const input = request(cursor, false), page = await runtime.collect(input) as AdapterCollectionPage
    expect(await runtime.collect(input)).toEqual(page)
    captured.push(page); cursor = page.nextCursor
    if (!page.hasMore && !page.observations.length) break
    if (n === 39) throw new Error("Cached native auto collection did not finish")
  }
  expect(events(captured)).toHaveLength(10); expect(raw(captured)).toEqual([])
  expect(latestUsage(captured)).toEqual({ records: 5, input: 760023, output: 63 })
  const backfill = await drain(cursor, true, { rawSegmentBytes: 4096, rawBytesPerObservation: 4096 })
  expect(events(backfill.pages)).toEqual([]); expect(usage(backfill.pages)).toEqual([])
  expectRaw(backfill.pages, snapshots[4]!)
})

it("keeps the original checkpoint while independently acknowledging Raw receipts inside a proved replay group", async () => {
  const source = snapshots[2]!, originals = prefix(source, 21), summary = prefix(source, 25)
  await writeFile(file, originals)
  const initial = await drain(null, false)
  expect(events(initial.pages)).toHaveLength(5); expect(progress).toEqual([])
  await appendFile(file, summary.slice(originals.length))
  const groupBytes = Buffer.byteLength(summary.slice(originals.length)), limits = { rawSegmentBytes: groupBytes, rawBytesPerObservation: groupBytes }
  const receipts: AdapterCollectionPage[] = []
  let nextCursor = initial.cursor
  for (let n = 0; n < 10; n++) {
    // The Host may persist successful Raw receipts before it commits the
    // returned Canonical checkpoint. Each request uses a fresh runtime.
    const input = request(initial.cursor, true, limits), page = await read(input)
    expect(await read(input)).toEqual(page)
    expect(events([page])).toEqual([]); expect(usage([page])).toEqual([])
    receipts.push(page); acknowledge(page); nextCursor = page.nextCursor
    if (progress[0]?.sourceOffset === Buffer.byteLength(summary)) break
    if (n === 9) throw new Error("Raw receipts did not reach the proved summary")
  }
  expect(receipts.length).toBeGreaterThan(2)
  expect(progress[0]!.sourceOffset).toBe(Buffer.byteLength(summary))
  expect(raw(receipts).some(segment => {
    const end = segment.sourceOffset + Buffer.byteLength(segment.content)
    return end > Buffer.byteLength(originals) && end < Buffer.byteLength(summary)
  })).toBe(true)
  expectRaw(receipts, summary)
  const idle = await read(request(nextCursor, true, limits))
  expect(idle.observations).toEqual([]); expect(idle.progress?.pendingCanonicalSessions).toBe(1)
  await appendFile(file, source.slice(summary.length))
  const answer = await drain(nextCursor)
  expect(events(answer.pages)).toHaveLength(1)
  expect(latestUsage([...initial.pages, ...receipts, ...answer.pages])).toEqual({ records: 3, input: 380023, output: 37 })
  expectRaw([...receipts, ...answer.pages], source)
})

it.each(["partial-first", "after-user", "partial-attachment", "after-attachment", "partial-boundary", "after-boundary", "partial-summary"])
("does not acknowledge an incomplete replay group or busy-loop at EOF: %s", async kind => {
  const source = snapshots[2]!, originals = prefix(source, 21), group = source.split(/(?<=\n)/).slice(21, 25)
  const slot = kind === "partial-first" ? 0 : kind.includes("attachment") || kind === "after-user" ? 1 : kind.includes("boundary") ? 2 : 3
  const complete = kind === "after-user" ? 1 : kind === "after-attachment" ? 2 : kind === "after-boundary" ? 3 : slot
  const suffix = group.slice(0, complete).join("") + (kind.startsWith("partial-") ? group[slot]!.slice(0, Math.floor(group[slot]!.length / 2)) : "")
  await writeFile(file, originals)
  const initial = await drain()
  await appendFile(file, suffix)
  const input = request(initial.cursor), waiting = await read(input)
  expect(await read(input)).toEqual(waiting)
  expect(waiting.observations).toEqual([]); expect(waiting.nextCursor).toBe(initial.cursor); expect(waiting.hasMore).toBe(false)
  expect(waiting.progress).toMatchObject({ pendingCanonicalSessions: 1, pendingRawBytes: Buffer.byteLength(suffix) })
  await appendFile(file, source.slice(originals.length + suffix.length))
  const rest = await drain(initial.cursor)
  expect(events(rest.pages)).toHaveLength(1); expect(usage(rest.pages)).toHaveLength(1)
  expectRaw([...initial.pages, ...rest.pages], source)
})

it("rejects an already complete conflicting first copy even when later witness slots are missing", async () => {
  const source = rows(snapshots[2]!), originals = lines(source.slice(0, 21))
  await writeFile(file, originals)
  const initial = await drain(), retained = [...progress]
  source[21]!.message.content += " changed"
  await appendFile(file, lines([source[21]!]))
  await expect(read(request(initial.cursor))).rejects.toMatchObject({ reason: "unsupported" })
  expect(progress).toEqual(retained)
})

it.each(["copy-user-body", "copy-unknown-field", "copy-attachment-body", "copy-attachment-parent", "copy-role", "copy-version", "copy-agent",
  "missing-slug", "different-copy-slug", "boundary-parent", "boundary-logical-parent", "boundary-trigger", "boundary-head", "boundary-tail",
  "boundary-list-order", "boundary-list-extra", "boundary-list-disagrees", "boundary-anchor-disagrees", "boundary-past-anchor", "boundary-past-id",
  "boundary-summary-flag", "boundary-visible-flag", "boundary-meta", "summary-parent", "summary-prompt", "summary-flag", "summary-marker", "summary-subtype", "summary-empty",
  "group-bookkeeping", "group-blank"])
("rejects conflicting copies and control witnesses without advancing acknowledged source bytes: %s", async kind => {
  const source = rows(snapshots[2]!), originalPrefix = lines(source.slice(0, 21)), u = source[21]!, g = source[22]!, b = source[23]!, s = source[24]!
  await writeFile(file, originalPrefix)
  const initial = await drain(), retained = [...progress]
  switch (kind) {
    case "copy-user-body": u.message.content += " changed"; break
    case "copy-unknown-field": u.permissionMode = "different"; break
    case "copy-attachment-body": g.attachment.text += " changed"; break
    case "copy-attachment-parent": g.parentUuid = source[11]!.uuid; break
    case "copy-role": u.message.role = "assistant"; break
    case "copy-version": u.version = "2.1.264"; break
    case "copy-agent": u.agentId = "foreign-agent"; break
    case "missing-slug": delete u.slug; break
    case "different-copy-slug": g.slug = "changed-slug"; break
    case "boundary-parent": b.parentUuid = g.uuid; break
    case "boundary-logical-parent": b.logicalParentUuid = u.uuid; break
    case "boundary-trigger": b.compactMetadata.trigger = "manual"; break
    case "boundary-head": b.compactMetadata.preservedSegment.headUuid = u.uuid; break
    case "boundary-tail": b.compactMetadata.preservedSegment.tailUuid = u.uuid; break
    case "boundary-list-order": b.compactMetadata.preservedMessages.uuids.reverse(); break
    case "boundary-list-extra": b.compactMetadata.preservedMessages.uuids.push(b.uuid); break
    case "boundary-list-disagrees": b.compactMetadata.preservedMessages.allUuids.pop(); break
    case "boundary-anchor-disagrees": b.compactMetadata.preservedMessages.anchorUuid = "another-summary"; break
    case "boundary-past-anchor": b.compactMetadata.preservedSegment.anchorUuid = b.compactMetadata.preservedMessages.anchorUuid = u.uuid; break
    case "boundary-past-id": b.uuid = source[11]!.uuid; break
    case "boundary-summary-flag": b.isCompactSummary = true; break
    case "boundary-visible-flag": b.isVisibleInTranscriptOnly = false; break
    case "boundary-meta": b.isMeta = false; break
    case "summary-parent": s.parentUuid = u.uuid; break
    case "summary-prompt": s.promptId = "different-prompt"; break
    case "summary-flag": delete s.isVisibleInTranscriptOnly; break
    case "summary-marker": s.compactMetadata = b.compactMetadata; break
    case "summary-subtype": s.subtype = "compact_boundary"; break
    case "summary-empty": s.message.content = " "; break
    case "group-bookkeeping": source.splice(22, 0, { type: "queue-operation", operation: "enqueue", sessionId: u.sessionId }); break
  }
  const suffix = lines(source.slice(21))
  await appendFile(file, kind === "group-blank" ? lines([u]) + "\n" + lines(source.slice(22)) : suffix)
  const input = request(initial.cursor)
  await expect(read(input)).rejects.toMatchObject({ reason: "unsupported" })
  await expect(read(input)).rejects.toMatchObject({ reason: "unsupported" })
  expect(progress).toEqual(retained)
})

it.each(["body", "slug", "api", "index", "tool", "summary", "boundary", "bookkeeping"])
("retains the admitted summary checkpoint when the first answer is unsupported: %s", async kind => {
  const source = rows(snapshots[2]!), summary = lines(source.slice(0, 25)), answer = source[25]!
  await writeFile(file, summary)
  const initial = await drain(), retained = [...progress]
  expect(initial.pages.at(-1)!.progress?.pendingCanonicalSessions).toBe(1)
  switch (kind) {
    case "body": answer.message.content = [{ type: "text", text: "" }]; break
    case "slug": answer.slug = "changed-slug"; break
    case "api": delete answer.message.id; break
    case "index": answer.apiBlockIndex = 1; break
    case "tool": answer.message.content = [{ type: "tool_use", id: "read", name: "Read", input: {} }]; break
    case "summary": answer.isCompactSummary = true; break
    case "boundary": answer.compactMetadata = source[23]!.compactMetadata; break
    case "bookkeeping": source.splice(25, 0, { type: "queue-operation", operation: "enqueue", sessionId: answer.sessionId }); break
  }
  await appendFile(file, lines(source.slice(25)))
  await expect(read(request(initial.cursor))).rejects.toMatchObject({ reason: "unsupported" })
  expect(progress).toEqual(retained)
  const native = snapshots[2]!, suffix = native.slice(prefix(native, 25).length)
  await writeFile(file, summary + suffix)
  const rest = await drain(initial.cursor)
  expect(events(rest.pages)).toHaveLength(1); expect(usage(rest.pages)).toHaveLength(1)
  expectRaw([...initial.pages, ...rest.pages], summary + suffix)
})

it("defers a whole group that fits a fresh Raw page but not its remaining capacity, and rejects a smaller fresh page", async () => {
  const source = snapshots[2]!, originals = prefix(source, 21), summary = prefix(source, 25)
  await writeFile(file, snapshots[1]!)
  const initial = await drain(), groupBytes = Buffer.byteLength(summary.slice(originals.length))
  await appendFile(file, summary.slice(snapshots[1]!.length))
  const limits = { rawSegmentBytes: groupBytes, rawBytesPerObservation: groupBytes }, input = request(initial.cursor, true, limits)
  const deferred = await read(input)
  expect(await read(input)).toEqual(deferred)
  expect(events([deferred])).toHaveLength(1); expect(usage([deferred])).toEqual([])
  expect(deferred.hasMore).toBe(true)
  expect(raw([deferred]).map(segment => segment.content).join("")).toBe(originals.slice(snapshots[1]!.length))
  acknowledge(deferred)
  const retained = [...progress]
  await expect(read(request(deferred.nextCursor, true, { rawSegmentBytes: groupBytes - 1, rawBytesPerObservation: groupBytes - 1 })))
    .rejects.toMatchObject({ reason: "limit" })
  expect(progress).toEqual(retained)
  const complete = await drain(deferred.nextCursor, true, limits)
  expect(events(complete.pages)).toEqual([]); expect(usage(complete.pages)).toEqual([])
  expect(complete.pages.at(-1)!.progress?.pendingCanonicalSessions).toBe(1)
  expectRaw([...initial.pages, deferred, ...complete.pages], summary)
})

it.each(["first-complete", "second-complete", "second-partial", "fourth-partial-at-group-cap"])
("limits a recognized group when its LF-framed profile cannot complete within bounded capacity: %s", async kind => {
  const source = rows(snapshots[2]!), cap = 64 * 1024
  const pad = (record: Row, bytes: number) => {
    record.padding = ""
    record.padding = "p".repeat(bytes - Buffer.byteLength(lines([record])))
    expect(Buffer.byteLength(lines([record]))).toBe(bytes)
  }
  if (kind === "first-complete" || kind === "fourth-partial-at-group-cap") {
    pad(source[19]!, kind === "first-complete" ? cap + 1 : cap)
    source[21] = { ...structuredClone(source[19]!), slug: source[21]!.slug }
    // Preserve the exact cap after adding the allowed new slug.
    if (kind === "fourth-partial-at-group-cap") {
      source[19]!.slug = source[21]!.slug; source[20]!.slug = source[21]!.slug; source[11]!.slug = source[21]!.slug
      pad(source[19]!, cap); source[21] = structuredClone(source[19]!)
    }
  }
  if (kind !== "first-complete") {
    if (kind === "fourth-partial-at-group-cap") {
      pad(source[20]!, cap); source[22] = structuredClone(source[20]!); pad(source[23]!, cap); pad(source[24]!, cap + 1)
    } else {
      pad(source[20]!, cap + 1); source[22] = { ...structuredClone(source[20]!), slug: source[22]!.slug }
    }
  }
  const originalPrefix = lines(source.slice(0, 21))
  await writeFile(file, originalPrefix)
  const initial = await drain(), retained = [...progress]
  const group = lines(source.slice(21, 25))
  let suffix = group
  if (kind === "second-partial") suffix = lines([source[21]!]) + lines([source[22]!]).slice(0, cap)
  if (kind === "fourth-partial-at-group-cap") suffix = group.slice(0, 4 * cap) + "additional bytes beyond the bounded group"
  await appendFile(file, suffix)
  await expect(read(request(initial.cursor))).rejects.toMatchObject({ reason: "limit" })
  expect(progress).toEqual(retained)
})

it("keeps an unknown first partial line under the ordinary parser limit until a complete candidate can be classified", async () => {
  const source = snapshots[2]!, originals = prefix(source, 21)
  await writeFile(file, originals)
  const initial = await drain(), retained = [...progress]
  const unknown = "{" + " ".repeat(70_000)
  await appendFile(file, unknown)
  const waiting = await read(request(initial.cursor))
  expect(waiting.observations).toEqual([]); expect(waiting.nextCursor).toBe(initial.cursor); expect(waiting.hasMore).toBe(false)
  expect(progress).toEqual(retained)
  await writeFile(file, originals + "{" + " ".repeat(16 * 1024 * 1024))
  await expect(read(request(initial.cursor))).rejects.toMatchObject({ reason: "limit", message: "Claude JSONL record exceeds 16 MiB." })
  await writeFile(file, source)
  const rest = await drain(initial.cursor)
  expect(events(rest.pages)).toHaveLength(1); expect(usage(rest.pages)).toHaveLength(1)
  expectRaw([...initial.pages, ...rest.pages], source)
})

it.each(["missing-api", "different-role", "model", "index", "tool", "version", "mixed-slug", "user-type", "reminder-type", "user-attachment-gap", "trailing-bookkeeping", "blank-after-tail",
  "unknown-metadata", "metadata-depth", "tail-byte-window", "tail-record-bytes"])
("rejects unsupported or over-cap current original tails: %s", async kind => {
  const source = rows(snapshots[2]!), a = source[11]!, u = source[19]!, g = source[20]!
  let reason = "unsupported"
  switch (kind) {
    case "missing-api": delete a.message.id; break
    case "different-role": a.message.role = "user"; break
    case "model": a.message.model = "<synthetic>"; break
    case "index": a.apiBlockIndex = 1; break
    case "tool": a.message.content = [{ type: "tool_use", id: "read", name: "Read", input: {} }]; break
    case "version": a.version = "2.1.264"; break
    case "mixed-slug": a.slug = "rustling-watching-sunrise"; break
    case "user-type": u.userType = "internal"; source[21]!.userType = "internal"; break
    case "reminder-type": g.attachment.type = "other_reminder"; source[22]!.attachment.type = "other_reminder"; break
    case "user-attachment-gap": source.splice(20, 0, { type: "queue-operation", operation: "enqueue", sessionId: u.sessionId }); break
    case "trailing-bookkeeping": source.splice(21, 0, { type: "last-prompt", lastPrompt: "extra", sessionId: u.sessionId }); break
    case "unknown-metadata": source[14]!.type = "unknown-bookkeeping"; break
    case "metadata-depth": source.splice(19, 0, ...Array.from({ length: 16 }, () => ({ type: "queue-operation", operation: "enqueue", sessionId: u.sessionId }))); reason = "limit"; break
    case "tail-byte-window": source.splice(19, 0, ...Array.from({ length: 5 }, () => ({ type: "queue-operation", operation: "enqueue", sessionId: u.sessionId, padding: "p".repeat(60_000) }))); reason = "limit"; break
    case "tail-record-bytes": a.message.content[0].text = "a".repeat(70_000); reason = "limit"; break
  }
  const copyAt = source.map(row => row.uuid).lastIndexOf(u.uuid)
  const originalPrefix = lines(source.slice(0, copyAt)) + (kind === "blank-after-tail" ? "\n" : "")
  await writeFile(file, originalPrefix)
  const initial = await drain(), retained = [...progress]
  await appendFile(file, lines(source.slice(copyAt)))
  await expect(read(request(initial.cursor))).rejects.toMatchObject({ reason })
  expect(progress).toEqual(retained)
})

it.each(["replace-slug", "remove-slug", "old-user-group", "reused-boundary", "reused-summary"])
("requires unchanged existing slugs and a new group witnessed by this round's current tail: %s", async kind => {
  const source = rows(snapshots[3]!), originals = lines(source.slice(0, 34)), u = source[34]!, g = source[35]!, b = source[36]!, s = source[37]!
  await writeFile(file, originals)
  const initial = await drain(), retained = [...progress]
  switch (kind) {
    case "replace-slug": for (const record of [u, g, b, s]) record.slug = "replacement"; break
    case "remove-slug": for (const record of [u, g, b, s]) delete record.slug; break
    case "old-user-group": source.splice(34, 4, ...structuredClone(source.slice(21, 25))); break
    case "reused-boundary": b.uuid = source[23]!.uuid; s.parentUuid = b.uuid; break
    case "reused-summary": b.compactMetadata.preservedSegment.anchorUuid = b.compactMetadata.preservedMessages.anchorUuid = source[24]!.uuid; s.uuid = source[24]!.uuid; break
  }
  await appendFile(file, lines(source.slice(34)))
  await expect(read(request(initial.cursor))).rejects.toMatchObject({ reason: "unsupported" })
  expect(progress).toEqual(retained)
})

it("commits large older history through fragments without retaining it in the bounded current-tail proof", async () => {
  const source = rows(snapshots[2]!)
  source[5]!.message.content[0].text = "old".repeat(220_000)
  const text = lines(source); await writeFile(file, text)
  const collected = await drain(null, true, { eventsPerObservation: 1, canonicalBytesPerObservation: 300_000 })
  expect(events(collected.pages)).toHaveLength(8)
  expect(new Set(events(collected.pages).map(event => event.sourceEventId)).size).toBe(8)
  expect(latestUsage(collected.pages)).toEqual({ records: 3, input: 380023, output: 37 })
  expectRaw(collected.pages, text)
})

it("keeps a pending answer across large text fragments until its entire record and usage commit", async () => {
  const source = rows(snapshots[2]!), summary = lines(source.slice(0, 25)), answer = source[25]!
  answer.message.content[0].text = "a".repeat(600_000)
  const text = lines(source)
  await writeFile(file, summary)
  const initial = await drain()
  await appendFile(file, text.slice(summary.length))
  const limits = { eventsPerObservation: 1, canonicalBytesPerObservation: 300_000 }
  const first = await read(request(initial.cursor, true, limits))
  expect(events([first])).toHaveLength(1); expect(usage([first])).toEqual([]); expect(raw([first])).toEqual([])
  expect(first.progress?.pendingCanonicalSessions).toBe(1)
  expect(await read(request(initial.cursor, true, limits))).toEqual(first)
  acknowledge(first)
  const rest = await drain(first.nextCursor, true, limits), captured = [...initial.pages, first, ...rest.pages]
  const answerEvents = events(captured).filter(event => event.sourceEventId.startsWith(`${answer.uuid}:`))
  expect(answerEvents).toHaveLength(3)
  expect(answerEvents.map(event => "content" in event.update && event.update.content.type === "text" ? event.update.content.text : "").join(""))
    .toBe("a".repeat(600_000))
  expect(latestUsage(captured)).toEqual({ records: 3, input: 380023, output: 37 })
  expect(rest.pages.at(-1)!.progress?.pendingCanonicalSessions).toBe(0)
  expectRaw(captured, text)
})

it("keeps the pending answer and acknowledged Event when its usage needs another page", async () => {
  const source = rows(snapshots[2]!), summary = lines(source.slice(0, 25)), answer = source[25]!
  answer.message.id = "x".repeat(500)
  const text = lines(source)
  await writeFile(file, summary)
  const initial = await drain()
  await appendFile(file, text.slice(summary.length))
  const input = request(initial.cursor, true, { canonicalBytesPerObservation: 9440 }), event = await read(input)
  expect(await read(input)).toEqual(event)
  expect(events([event])).toHaveLength(1); expect(usage([event])).toEqual([]); expect(raw([event])).toEqual([])
  expect(event.progress?.pendingCanonicalSessions).toBe(1)
  acknowledge(event)
  const retained = [...progress]
  await expect(read(request(event.nextCursor, true, { canonicalBytesPerObservation: 8941 }))).rejects.toMatchObject({ reason: "limit" })
  expect(progress).toEqual(retained)
  const rest = await drain(event.nextCursor), captured = [...initial.pages, event, ...rest.pages]
  expect(events(rest.pages)).toEqual([]); expect(usage(rest.pages)).toHaveLength(1)
  expect(rest.pages.at(-1)!.progress?.pendingCanonicalSessions).toBe(0)
  expect(latestUsage(captured)).toEqual({ records: 3, input: 380023, output: 37 })
  expectRaw(captured, text)
})

it("rejects a changed original CWD after Host attribution against the actual committed first record", async () => {
  const source = rows(snapshots[2]!), root = source.find(row => row.uuid)!
  root.cwd = join(directory, "foreign-origin")
  const runtime = await createAtapeAdapter({ ...context, project: { ...context.project, type: "git" },
    gitAttribution: { version: "atape.git-attribution.v1", resolve: async () => { await writeFile(file, lines(source)); return "included" } } })
  await expect(runtime.collect(request())).rejects.toMatchObject({ reason: "changed" })
  expect(progress).toEqual([])
})

it("rejects changed committed summary bytes without resetting the acknowledged pending answer", async () => {
  const native = snapshots[2]!, summary = prefix(native, 25)
  await writeFile(file, summary)
  const initial = await drain(), retained = [...progress]
  await writeFile(file, summary.replace("ATAPE_AUTO_TEXT_SUMMARY_CONTINUE", "ATAPE_AUTO_TEXT_SUMMARY_CHANGED"))
  await expect(read(request(initial.cursor))).rejects.toMatchObject({ reason: "changed" })
  expect(progress).toEqual(retained)
  await writeFile(file, native)
  const answer = await drain(initial.cursor)
  expect(events(answer.pages)).toHaveLength(1); expect(usage(answer.pages)).toHaveLength(1)
  expectRaw([...initial.pages, ...answer.pages], native)
})

it.each(["version", "summary", "slug", "projection", "usage-version", "observed-at", "manual-state"])
("rejects malformed pending answer checkpoints instead of dropping their state: %s", async kind => {
  await writeFile(file, prefix(snapshots[2]!, 25))
  const initial = await drain(), retained = [...progress], damaged = JSON.parse(initial.cursor!), checkpoint = damaged.sessions[0].checkpoint
  // Fault injection only: every valid checkpoint above was obtained by collect.
  switch (kind) {
    case "version": checkpoint.stream.autoText.v = 2; break
    case "summary": checkpoint.stream.autoText.summaryUuid = "not-captured-summary"; break
    case "slug": checkpoint.stream.autoText.slug = ""; break
    case "projection": checkpoint.projectionRevision = 3; break
    case "usage-version": delete checkpoint.usageVersion; break
    case "observed-at": checkpoint.observedAt = "not-a-time"; break
    case "manual-state": checkpoint.stream.compaction = { v: 1, boundaryUuid: checkpoint.stream.autoText.boundaryUuid,
      summaryUuid: checkpoint.stream.autoText.summaryUuid, promptId: checkpoint.stream.autoText.promptId, phase: "resume" }; break
  }
  await expect(read(request(JSON.stringify(damaged)))).rejects.toMatchObject({ reason: "cursor" })
  expect(progress).toEqual(retained)
})

it("rejects automatic replay on a child Thread and rejects a pending auto state inserted into its checkpoint", async () => {
  await writeFile(file, prefix(snapshots[2]!, 25))
  const automatic = await drain(), autoCheckpoint = JSON.parse(automatic.cursor!).sessions[0].checkpoint
  progress = []
  const family = new URL("../fixtures/native-foreground-child-2.1.263/", import.meta.url)
  const sessionId = "d33bd4a6-a5ce-47d3-b4d3-91e62386940f", agentId = "a5b93406db8c7fefd"
  const childFile = join(directory, sessionId, "subagents", `agent-${agentId}.jsonl`)
  const rootText = (await readFile(new URL(`${sessionId}.jsonl`, family), "utf8")).replaceAll("/fixture/native-foreground-child", directory)
  const childText = (await readFile(new URL(`${sessionId}/subagents/agent-${agentId}.jsonl`, family), "utf8")).replaceAll("/fixture/native-foreground-child", directory)
  const leaf = rows(childText).filter(row => row.uuid).at(-1)!, source = rows(snapshots[2]!)
  const records: Row[] = [source[11]!, source[19]!, source[20]!, ...source.slice(21, 25)]
    .map(record => ({ ...record, sessionId, agentId, isSidechain: true }))
  records[0]!.parentUuid = leaf.uuid
  await mkdir(join(directory, sessionId, "subagents"), { recursive: true })
  await writeFile(file, rootText); await writeFile(childFile, childText + lines(records.slice(0, 3)))
  const initial = await drain(), retained = [...progress]
  await appendFile(childFile, lines(records.slice(3)))
  const input = request(initial.cursor), rejected = await read(input)
  expect(rejected).toMatchObject({ observations: [], nextCursor: initial.cursor, sourceFailures: [{ source: childFile, reason: "unsupported" }] })
  expect(await read(input)).toEqual(rejected); expect(progress).toEqual(retained)
  const damaged = JSON.parse(initial.cursor!)
  damaged.sessions[0].checkpoint.children[0].checkpoint.stream.autoText = autoCheckpoint.stream.autoText
  await expect(read(request(JSON.stringify(damaged)))).rejects.toMatchObject({ reason: "cursor" })
  expect(progress).toEqual(retained)
})

it("compares decoded values independent of JSON key order while retaining exact source serialization in Raw", async () => {
  const source = rows(snapshots[2]!)
  for (const index of [19, 20, 21, 22]) source[index]!.opaqueProviderField = { ordered: [1, 2, { retained: true }] }
  for (const index of [21, 22]) source[index] = Object.fromEntries(Object.entries(source[index]!).reverse())
  const text = lines(source); await writeFile(file, text)
  const collected = await drain()
  expect(events(collected.pages)).toHaveLength(6)
  expect(latestUsage(collected.pages)).toEqual({ records: 3, input: 380023, output: 37 })
  expectRaw(collected.pages, text)
})

it("keeps the admitted answer checkpoint through an incomplete ordinary answer line", async () => {
  const native = snapshots[2]!, sourceLines = native.split(/(?<=\n)/), summary = prefix(native, 25), answer = sourceLines[25]!
  await writeFile(file, summary)
  const initial = await drain(), retained = [...progress], cut = Math.floor(answer.length / 2)
  await appendFile(file, answer.slice(0, cut))
  const input = request(initial.cursor), waiting = await read(input)
  expect(await read(input)).toEqual(waiting)
  expect(waiting.observations).toEqual([]); expect(waiting.nextCursor).toBe(initial.cursor); expect(waiting.hasMore).toBe(false)
  expect(waiting.progress?.pendingCanonicalSessions).toBe(1); expect(progress).toEqual(retained)
  await appendFile(file, answer.slice(cut) + sourceLines.slice(26).join(""))
  const rest = await drain(initial.cursor)
  expect(events(rest.pages)).toHaveLength(1); expect(usage(rest.pages)).toHaveLength(1)
  expectRaw([...initial.pages, ...rest.pages], native)
})

it.each([false, true])("compares deeply nested unknown JSON values through collect without recursive stack overflow (changed %s)", async changed => {
  const source = rows(snapshots[2]!), deep = (leaf: string) => {
    let value: unknown = leaf
    for (let depth = 0; depth < 4000; depth++) value = { k: value }
    return value
  }
  source[19]!.opaqueProviderField = deep("original")
  source[21]!.opaqueProviderField = deep(changed ? "different" : "original")
  const originalPrefix = lines(source.slice(0, 21)), text = lines(source)
  await writeFile(file, originalPrefix)
  const initial = await drain(), retained = [...progress]
  await appendFile(file, text.slice(originalPrefix.length))
  if (changed) {
    await expect(read(request(initial.cursor))).rejects.toMatchObject({ reason: "unsupported" })
    expect(progress).toEqual(retained)
  } else {
    const rest = await drain(initial.cursor)
    expect(events(rest.pages)).toHaveLength(1); expect(usage(rest.pages)).toHaveLength(1)
    expectRaw([...initial.pages, ...rest.pages], text)
  }
})
