import { AdapterCollectionLimits, type AdapterCollectRequest, type AdapterCollectionPage, type AdapterOpenContext, type AdapterUsage } from "@atape/domain"
import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createAtapeAdapter } from "./index.ts"

type Row = Record<string, any>
type NativeCase = { name: string; cwd: string; snapshots: Array<{ source: string; expected: Row }> }
const names = ["native-auto-text-replay-rounds-2.1.263", "native-manual-text-tail-2.1.263", "native-manual-compact-2.1.263",
  "native-auto-read-replay-2.1.263", "native-repeated-auto-read-2.1.263", "native-reversed-read-pair-2.1.263",
  "native-repeated-dual-read-2.1.263", "native-read-pair-2.1.263", "native-manual-read-reinjection-2.1.263",
  "native-manual-large-read-reinjection-2.1.263"]
const cases: NativeCase[] = []
for (const name of names) {
  const directory = new URL(`../fixtures/${name}/`, import.meta.url)
  const metadata: Row = JSON.parse(await readFile(new URL("provenance.json", directory), "utf8"))
  const scenarios: Row[] = metadata.cases ?? [{ id: name, nativeSnapshots: metadata.nativeSnapshots ?? metadata.snapshots ?? metadata.files }]
  for (const scenario of scenarios) {
    const snapshots = await Promise.all((scenario.nativeSnapshots as Row[]).map(async (snapshot, index) => {
      const expected = snapshot.expected ?? snapshot.expectedLogicalData ?? {
        eventCount: [4, 4, 6][index], distinctUsageCount: [2, 2, 3][index], inputTokens: [52, 52, 81][index], outputTokens: [24, 24, 37][index]
      }
      return { source: await readFile(new URL(snapshot.file ?? snapshot.path, directory), "utf8"), expected }
    }))
    cases.push({ name: `${name}/${scenario.id}`, cwd: metadata.fixtureCwd, snapshots })
  }
}

let directory: string, file: string, context: AdapterOpenContext & { signal: AbortSignal }
let progress: AdapterCollectRequest["rawProgress"]
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "atape-claude-native-continuity-"))); file = join(directory, "source.jsonl")
  vi.stubEnv("ATAPE_CLAUDE_SESSION_FILE", file)
  context = { protocolVersion: "atape.adapter.v1alpha1", adapter: { id: "claude", version: "0.5.2" },
    project: { id: "project", type: "directory", path: directory }, signal: new AbortController().signal }
  progress = []
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
const read = async (input: AdapterCollectRequest) => await (await createAtapeAdapter(context)).collect(input) as AdapterCollectionPage
const acknowledge = (page: AdapterCollectionPage) => {
  const receipts = new Map(progress.map(item => [item.sourceObjectId, item]))
  for (const observation of page.observations) for (const raw of observation.rawSegments) receipts.set(raw.sourceObjectId, {
    sourceSessionId: observation.session.sourceSessionId, sourceObjectId: raw.sourceObjectId, sourceGeneration: raw.sourceGeneration,
    sourceOffset: raw.sourceOffset + Buffer.byteLength(raw.content), finalized: raw.final
  })
  progress = [...receipts.values()]
}
const drain = async (cursor: string | null, raw = true, limits: Partial<AdapterCollectRequest["limits"]> = {}) => {
  const pages: AdapterCollectionPage[] = []
  for (let number = 0; number < 2000; number++) {
    const input: AdapterCollectRequest = { protocolVersion: context.protocolVersion, cursor, rawProgress: progress,
      rawCaptureEnabled: raw, limits: { ...AdapterCollectionLimits, eventsPerObservation: 1, ...limits }, signal: new AbortController().signal }
    const page = await read(input); expect(await read(input)).toEqual(page)
    expect(page.sourceFailures).toBeUndefined()
    for (const observation of page.observations) {
      expect(observation.events.length).toBeLessThanOrEqual(input.limits.eventsPerObservation)
      expect(Buffer.byteLength(JSON.stringify({ ...observation, rawSegments: [] }))).toBeLessThanOrEqual(input.limits.canonicalBytesPerObservation)
      expect(observation.rawSegments.reduce((sum, segment) => sum + Buffer.byteLength(segment.content), 0)).toBeLessThanOrEqual(input.limits.rawBytesPerObservation)
    }
    pages.push(page); acknowledge(page); cursor = page.nextCursor
    if (!page.observations.length && !page.hasMore) return { pages, cursor }
  }
  throw new Error("Native continuation did not converge")
}
const events = (pages: AdapterCollectionPage[]) => pages.flatMap(page => page.observations.flatMap(observation => observation.events))
const rawSegments = (pages: AdapterCollectionPage[]) => pages.flatMap(page => page.observations.flatMap(observation => observation.rawSegments))
const latestUsage = (pages: AdapterCollectionPage[]) => {
  const latest = new Map<string, AdapterUsage>()
  for (const page of pages) for (const observation of page.observations) for (const sample of observation.usage ?? []) {
    const old = latest.get(sample.sourceUsageId)
    if (!old || sample.revision > old.revision) latest.set(sample.sourceUsageId, sample)
    else if (sample.revision === old.revision) expect(sample).toEqual(old)
  }
  return latest
}
const expectLogical = (pages: AdapterCollectionPage[], expected: Row) => {
  const captured = events(pages), usage = latestUsage(pages)
  expect(captured).toHaveLength(expected.uniqueCanonicalEventCount ?? expected.uniqueRealEventCount ?? expected.eventCount)
  expect(new Set(captured.map(event => event.sourceEventId)).size).toBe(captured.length)
  expect(usage.size).toBe(expected.distinctUsageCount ?? expected.distinctPersistedRealApiUsageCount)
  expect([...usage.values()].reduce((sum, sample) => sum + (sample.inputTokens ?? 0), 0)).toBe(expected.inputTokens)
  expect([...usage.values()].reduce((sum, sample) => sum + (sample.outputTokens ?? 0), 0)).toBe(expected.outputTokens)
  if (expected.eventSourceUuids) expect(captured.map(event => event.sourceEventId)).toEqual(expected.eventSourceUuids.map((uuid: string) => `${uuid}:0`))
  if (expected.usageSourceIds) expect([...usage.keys()]).toEqual(expected.usageSourceIds)
  expect(JSON.stringify(captured)).not.toMatch(/No response requested\.|<command-name>\/compact|session is being continued from a previous conversation/)
}
const expectRaw = (pages: AdapterCollectionPage[], source: string) => {
  const segments = rawSegments(pages); let offset = 0
  for (const segment of segments) { expect(segment.sourceOffset).toBe(offset); offset += Buffer.byteLength(segment.content) }
  expect(new Set(segments.map(segment => segment.sourceObjectId)).size).toBe(1)
  expect(new Set(segments.map(segment => segment.sourceGeneration)).size).toBe(1)
  expect(segments.map(segment => segment.content).join("")).toBe(source)
}

it.each(cases)("preserves native messages, usage and every Raw byte through append/restart: $name", async scenario => {
  const all: AdapterCollectionPage[] = []; let cursor: string | null = null, previousSource = ""
  for (const snapshot of scenario.snapshots) {
    const source = snapshot.source.replaceAll(scenario.cwd, directory)
    expect(source.startsWith(previousSource)).toBe(true)
    if (!previousSource) await writeFile(file, source)
    else await appendFile(file, source.slice(previousSource.length))
    const previous = events(all), collected = await drain(cursor); all.push(...collected.pages); cursor = collected.cursor
    expect(events(all).slice(0, previous.length)).toEqual(previous)
    expectLogical(all, snapshot.expected); expectRaw(all, source)
    expect(collected.pages.at(-1)?.progress?.pendingRawBytes).toBe(0)
    previousSource = source
  }
}, 30_000)

it.each(cases)("backfills independent Raw without replaying native data: $name", async scenario => {
  const final = scenario.snapshots.at(-1)!, source = final.source.replaceAll(scenario.cwd, directory)
  await writeFile(file, source)
  const captured = await drain(null, false)
  expectLogical(captured.pages, final.expected); expect(rawSegments(captured.pages)).toEqual([])
  const backfill = await drain(captured.cursor, true, { rawSegmentBytes: 8192, rawBytesPerObservation: 8192 })
  expect(events(backfill.pages)).toEqual([]); expect(latestUsage(backfill.pages).size).toBe(0); expectRaw(backfill.pages, source)
  expect(backfill.pages.at(-1)?.progress?.pendingRawBytes).toBe(0)
}, 30_000)
