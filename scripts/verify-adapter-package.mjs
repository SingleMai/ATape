import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const packageRoot = process.cwd()
const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
const adapterId = packageManifest.atapeAdapter.adapterId
assert.ok(["codex", "claude"].includes(adapterId))
const sourceHomeVariable = adapterId === "codex" ? "ATAPE_CODEX_HOME" : "ATAPE_CLAUDE_HOME"
const previousSelectedFile = process.env.ATAPE_CLAUDE_SESSION_FILE
const temporaryRoot = await mkdtemp(join(tmpdir(), `atape-${adapterId}-package-`))
const artifactDirectory = join(temporaryRoot, "artifact")
const installDirectory = join(temporaryRoot, "install")
const sourceHome = join(temporaryRoot, "source-home")
const projectDirectory = join(temporaryRoot, "project")
const previousSourceHome = process.env[sourceHomeVariable]

try {
  await Promise.all([
    mkdir(artifactDirectory, { recursive: true }),
    mkdir(join(sourceHome, "sessions"), { recursive: true }),
    mkdir(join(sourceHome, "archived_sessions"), { recursive: true }),
    mkdir(join(sourceHome, "projects"), { recursive: true }),
    mkdir(projectDirectory, { recursive: true })
  ])
  const packed = JSON.parse((await run("npm", [
    "pack", "--json", "--pack-destination", artifactDirectory
  ], packageRoot)).stdout)
  assert.equal(packed.length, 1)
  const manifest = packed[0]
  assert.deepEqual(
    manifest.files.map((file) => file.path).sort(),
    ["LICENSE", "README.md", "dist/index.js", "package.json"]
  )
  assert.ok(manifest.size < 1024 * 1024, `${adapterId} Adapter tarball is unexpectedly large: ${manifest.size} bytes`)

  const tarball = join(artifactDirectory, manifest.filename)
  await run("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDirectory, tarball
  ], temporaryRoot)
  const installedEntry = join(
    installDirectory,
    "node_modules",
    "@atape",
    `adapter-${adapterId}`,
    "dist",
    "index.js"
  )
  const adapter = await import(pathToFileURL(installedEntry).href)
  assert.equal(typeof adapter.createAtapeAdapter, "function")

  process.env.ATAPE_CLAUDE_SESSION_FILE = ""
  process.env[sourceHomeVariable] = sourceHome
  const context = {
    protocolVersion: "atape.adapter.v1alpha1",
    adapter: { id: adapterId, version: packageManifest.version },
    project: { id: "package-project", type: "directory", path: projectDirectory }
  }
  const runtime = await adapter.createAtapeAdapter({ ...context, signal: AbortSignal.timeout(5_000) })
  const request = {
    protocolVersion: "atape.adapter.v1alpha1",
    cursor: null,
    limits: {
      observations: 10,
      threadsPerObservation: 100,
      eventsPerObservation: 500,
      canonicalBytesPerObservation: 3 * 1024 * 1024,
      rawSegmentsPerObservation: 16,
      rawSegmentBytes: 16 * 1024 * 1024,
      rawBytesPerObservation: 16 * 1024 * 1024,
      pagesPerCycle: 20
    },
    rawProgress: [],
    signal: AbortSignal.timeout(5_000)
  }
  const page = await runtime.collect(request)
  assert.deepEqual(page.observations, [])
  assert.equal(page.hasMore, false)
  if (adapterId === "codex") assert.equal(typeof page.nextCursor, "string")
  else assert.equal(page.nextCursor, null)
  assert.equal(page.sourceFailures, undefined)
  await runtime.close?.()
  if (adapterId === "claude") {
    await verifyClaudeForeground(adapter, context, request.limits)
    await verifyClaudeContinuity(adapter, context, request.limits)
  }
  const installedManifest = JSON.parse(await readFile(join(installDirectory, "node_modules", "@atape", `adapter-${adapterId}`, "package.json"), "utf8"))
  assert.equal(installedManifest.dependencies, undefined, "Adapter must be self-contained")

  process.stdout.write(`Verified installable ${adapterId} Adapter tarball ${manifest.filename}\n`)
} finally {
  if (previousSelectedFile === undefined) delete process.env.ATAPE_CLAUDE_SESSION_FILE
  else process.env.ATAPE_CLAUDE_SESSION_FILE = previousSelectedFile
  if (previousSourceHome === undefined) delete process.env[sourceHomeVariable]
  else process.env[sourceHomeVariable] = previousSourceHome
  await rm(temporaryRoot, { recursive: true, force: true })
}

async function verifyClaudeForeground(adapter, context, limits) {
  const fixtureDirectory = join(packageRoot, "fixtures", "native-foreground-child-2.1.263")
  const provenance = JSON.parse(await readFile(join(fixtureDirectory, "provenance.json"), "utf8"))
  const { sessionId, agentId, fixtureCwd } = provenance
  const childThreadId = `claude-agent:${agentId}`
  const directory = join(sourceHome, "projects", "fixture")
  const childDirectory = join(directory, sessionId, "subagents")
  await mkdir(childDirectory, { recursive: true })
  const rootName = `${sessionId}.jsonl`, childName = `agent-${agentId}.jsonl`
  // Preserve the controlled native records; relocate only their fixture CWD.
  const relocate = source => source.replaceAll(
    JSON.stringify(fixtureCwd).slice(1, -1), JSON.stringify(projectDirectory).slice(1, -1)
  )
  const [rootSource, childSource] = await Promise.all([
    readFile(join(fixtureDirectory, rootName), "utf8").then(relocate),
    readFile(join(fixtureDirectory, sessionId, "subagents", childName), "utf8").then(relocate)
  ])
  await Promise.all([
    writeFile(join(directory, rootName), rootSource),
    writeFile(join(childDirectory, childName), childSource)
  ])

  let cursor = null, finished = false
  const rawProgress = new Map(), observations = []
  const collect = () => collectInstalled(adapter, context, cursor, [...rawProgress.values()], limits)
  for (let index = 0; index < limits.pagesPerCycle; index++) {
    const page = await collect()
    assert.equal(page.sourceFailures, undefined)
    assert.equal(typeof page.nextCursor, "string")
    observations.push(...page.observations)
    for (const observation of page.observations) for (const raw of observation.rawSegments) {
      rawProgress.set(JSON.stringify([raw.sourceObjectId, raw.sourceGeneration]), {
        sourceSessionId: observation.session.sourceSessionId, sourceObjectId: raw.sourceObjectId,
        sourceGeneration: raw.sourceGeneration,
        sourceOffset: raw.sourceOffset + Buffer.byteLength(raw.content), finalized: raw.final
      })
    }
    cursor = page.nextCursor
    if (!page.hasMore) { finished = true; break }
  }
  assert.ok(finished, "Installed Claude Adapter did not finish the foreground family within its page budget")
  assert.ok(observations.length > 0)
  assert.ok(observations.every(observation => observation.session.sourceSessionId === sessionId))
  const threads = new Map(observations.flatMap(observation => observation.threads).map(thread => [thread.sourceThreadId, thread]))
  assert.deepEqual([...threads.keys()].sort(), [childThreadId, "root"].sort())
  assert.equal(threads.get(childThreadId).parentSourceThreadId, "root")
  const events = observations.flatMap(observation => observation.events)
  assert.equal(events.length, 8)
  assert.equal(new Set(events.map(event => JSON.stringify([event.sourceThreadId, event.sourceEventId]))).size, 8)
  assert.equal(events.filter(event => event.sourceThreadId === "root").length, 4)
  assert.equal(events.filter(event => event.sourceThreadId === childThreadId).length, 4)
  const delegation = events.filter(event => event.childSourceThreadId !== undefined)
  assert.equal(delegation.length, 1)
  assert.equal(delegation[0].sourceThreadId, "root")
  assert.equal(delegation[0].childSourceThreadId, childThreadId)
  assert.equal(delegation[0].update.sessionUpdate, "tool_call_update")
  assert.equal(delegation[0].update.toolCallId, "call_atape_parent_agent")
  assert.ok(events.some(event => event.sourceThreadId === "root" && event.update.content?.text === "ATAPE_ROOT_FINAL: delegated read reviewed."))
  assert.ok(events.some(event => event.sourceThreadId === childThreadId && event.update.content?.text === "ATAPE_CHILD_FINAL: cobalt heron 482 read once."))
  const usage = observations.flatMap(observation => observation.usage)
  assert.equal(usage.length, 4)
  assert.equal(new Set(usage.map(sample => JSON.stringify([sample.sourceThreadId, sample.sourceUsageId]))).size, 4)
  for (const threadId of ["root", childThreadId]) {
    const samples = usage.filter(sample => sample.sourceThreadId === threadId)
    assert.equal(samples.length, 2)
    assert.equal(samples.reduce((sum, sample) => sum + sample.inputTokens, 0), 34)
    assert.equal(samples.reduce((sum, sample) => sum + sample.outputTokens, 0), 18)
  }
  const raw = observations.flatMap(observation => observation.rawSegments)
  assert.equal(raw.length, 2)
  assert.equal(new Set(raw.map(segment => segment.sourceObjectId)).size, 2)
  for (const [name, source, threadId] of [[rootName, rootSource, "root"], [childName, childSource, childThreadId]]) {
    const segments = raw.filter(segment => segment.sourceName === name)
    assert.equal(segments.length, 1)
    assert.equal(segments[0].sourceOffset, 0)
    assert.equal(segments[0].content, source)
    assert.ok(events.filter(event => event.sourceThreadId === threadId).every(event => event.rawRef.sourceObjectId === segments[0].sourceObjectId))
  }
  const restarted = await collect()
  assert.deepEqual(restarted.observations, [])
  assert.equal(restarted.hasMore, false)
  assert.equal(restarted.nextCursor, cursor)
  assert.equal(restarted.sourceFailures, undefined)
}

async function collectInstalled(adapter, context, cursor, rawProgress, limits, rawCaptureEnabled) {
  // Reopen the installed artifact for every page, using only durable Host state.
  const runtime = await adapter.createAtapeAdapter({ ...context, signal: AbortSignal.timeout(5_000) })
  try {
    return await runtime.collect({ protocolVersion: context.protocolVersion, cursor, limits,
      rawProgress, ...(rawCaptureEnabled === undefined ? {} : { rawCaptureEnabled }), signal: AbortSignal.timeout(5_000) })
  } finally { await runtime.close?.() }
}

// The installed artifact follows the same source rule for every compaction.
// Recorded native snapshots prove their recorded shapes; generated cycles below
// vary round counts and context sizes without claiming new native acquisition.
async function verifyClaudeContinuity(adapter, context, limits) {
  const names = ["native-auto-text-replay-rounds-2.1.263", "native-manual-text-tail-2.1.263", "native-manual-compact-2.1.263",
    "native-auto-read-replay-2.1.263", "native-repeated-auto-read-2.1.263", "native-reversed-read-pair-2.1.263",
    "native-repeated-dual-read-2.1.263", "native-read-pair-2.1.263", "native-manual-read-reinjection-2.1.263",
    "native-manual-large-read-reinjection-2.1.263"]
  let nativeCount = 0
  for (const name of names) {
    const directory = join(packageRoot, "fixtures", name)
    const metadata = JSON.parse(await readFile(join(directory, "provenance.json"), "utf8"))
    const scenarios = metadata.cases ?? [{ id: name, nativeSnapshots: metadata.nativeSnapshots ?? metadata.snapshots ?? metadata.files }]
    for (const scenario of scenarios) {
      const snapshots = []
      for (const [index, snapshot] of scenario.nativeSnapshots.entries()) {
        const recorded = await readFile(join(directory, snapshot.file ?? snapshot.path), "utf8")
        const hash = snapshot.sanitized?.sha256 ?? snapshot.sanitizedSha256 ?? snapshot.sha256
        if (hash) assert.equal(createHash("sha256").update(recorded).digest("hex"), hash)
        const bytes = snapshot.sanitized?.bytes ?? snapshot.sanitizedBytes ?? snapshot.bytes
        if (bytes !== undefined) assert.equal(Buffer.byteLength(recorded), bytes)
        snapshots.push({ source: recorded.replaceAll(metadata.fixtureCwd, projectDirectory), expected: snapshot.expected ?? snapshot.expectedLogicalData ?? {
          eventCount: [4, 4, 6][index], distinctUsageCount: [2, 2, 3][index], inputTokens: [52, 52, 81][index], outputTokens: [24, 24, 37][index]
        } })
      }
      const sessionId = scenario.sessionId ?? metadata.sessionId ?? snapshots[0].source.trimEnd().split("\n").map(line => JSON.parse(line)).find(row => row.uuid)?.sessionId
      assert.equal(typeof sessionId, "string")
      await verifyContinuityCase(adapter, context, limits, `${name}-${scenario.id}`, sessionId, snapshots)
      nativeCount++
    }
  }
  for (const count of [1, 3, 100]) {
    const generated = await generatedContinuity(count)
    await verifyContinuityCase(adapter, context, limits, `generated-${count}`, generated.sessionId, generated.snapshots, count > 10 ? 100 : 1)
  }
  process.stdout.write(`Verified installed Claude continuity: ${nativeCount} native scenarios, generated 1/3/100 mixed cycles, restart/retry and independent Raw backfill\n`)
}

async function verifyContinuityCase(adapter, context, limits, name, sessionId, snapshots, eventBudget = 1) {
  const home = join(temporaryRoot, name), directory = join(home, "projects", "fixture"), file = join(directory, `${sessionId}.jsonl`)
  await mkdir(directory, { recursive: true })
  process.env.ATAPE_CLAUDE_HOME = home
  const paged = { ...limits, eventsPerObservation: eventBudget }
  const state = () => ({ cursor: null, receipts: new Map(), events: [], usage: new Map(), raw: "", objectId: undefined, generation: undefined })
  const drain = async (captured, enabled, budgets = paged) => {
    for (let index = 0; index < 10000; index++) {
      const collect = () => collectInstalled(adapter, context, captured.cursor, [...captured.receipts.values()], budgets, enabled)
      const page = await collect()
      assert.deepEqual(await collect(), page, `${name}: retry after reopening`)
      assert.equal(page.sourceFailures, undefined)
      for (const observation of page.observations) {
        assert.equal(observation.session.sourceSessionId, sessionId)
        assert.deepEqual(observation.threads.map(thread => thread.sourceThreadId), ["root"])
        assert.ok(observation.events.length <= budgets.eventsPerObservation)
        assert.ok(Buffer.byteLength(JSON.stringify({ ...observation, rawSegments: [] })) <= budgets.canonicalBytesPerObservation)
        assert.ok(observation.rawSegments.reduce((sum, segment) => sum + Buffer.byteLength(segment.content), 0) <= budgets.rawBytesPerObservation)
        for (const event of observation.events) {
          assert.ok(!captured.events.some(previous => previous.sourceEventId === event.sourceEventId), `${name}: duplicate acknowledged Event`)
          captured.events.push(event)
        }
        for (const sample of observation.usage ?? []) {
          assert.notEqual(sample.model, "<synthetic>")
          const previous = captured.usage.get(sample.sourceUsageId)
          if (!previous || sample.revision > previous.revision) captured.usage.set(sample.sourceUsageId, sample)
          else if (sample.revision === previous.revision) assert.deepEqual(sample, previous)
          else assert.fail(`${name}: usage revision went backward`)
        }
        for (const raw of observation.rawSegments) {
          captured.objectId ??= raw.sourceObjectId; captured.generation ??= raw.sourceGeneration
          assert.equal(raw.sourceObjectId, captured.objectId); assert.equal(raw.sourceGeneration, captured.generation)
          assert.equal(raw.sourceOffset, Buffer.byteLength(captured.raw))
          captured.raw += raw.content
          captured.receipts.set(raw.sourceObjectId, { sourceSessionId: sessionId, sourceObjectId: raw.sourceObjectId,
            sourceGeneration: raw.sourceGeneration, sourceOffset: Buffer.byteLength(captured.raw), finalized: raw.final })
        }
      }
      captured.cursor = page.nextCursor
      if (!page.hasMore && !page.observations.length) {
        assert.equal(page.progress?.pendingRawBytes ?? 0, 0)
        return
      }
    }
    assert.fail(`${name}: installed capture did not converge`)
  }
  const assertLogical = (captured, expected) => {
    assert.equal(captured.events.length, expected.uniqueCanonicalEventCount ?? expected.uniqueRealEventCount ?? expected.eventCount)
    assert.equal(captured.usage.size, expected.distinctUsageCount ?? expected.distinctPersistedRealApiUsageCount)
    assert.equal([...captured.usage.values()].reduce((sum, sample) => sum + (sample.inputTokens ?? 0), 0), expected.inputTokens)
    assert.equal([...captured.usage.values()].reduce((sum, sample) => sum + (sample.outputTokens ?? 0), 0), expected.outputTokens)
    if (expected.eventSourceUuids) assert.deepEqual(captured.events.map(event => event.sourceEventId), expected.eventSourceUuids.map(uuid => `${uuid}:0`))
    if (expected.usageSourceIds) assert.deepEqual([...captured.usage.keys()], expected.usageSourceIds)
    assert.doesNotMatch(JSON.stringify(captured.events), /GEN_INTERNAL_|No response requested\.|<command-name>\/compact|session is being continued from a previous conversation/)
  }
  try {
    const captured = state(); let previous = ""
    for (const snapshot of snapshots) {
      assert.ok(snapshot.source.startsWith(previous), `${name}: recorded snapshot must append`)
      if (!previous) await writeFile(file, snapshot.source)
      else await appendFile(file, snapshot.source.slice(previous.length))
      const originalEvents = [...captured.events]
      await drain(captured, true)
      assert.deepEqual(captured.events.slice(0, originalEvents.length), originalEvents)
      assertLogical(captured, snapshot.expected)
      assert.equal(captured.raw, snapshot.source)
      assert.ok(captured.events.every(event => event.rawRef.sourceObjectId === captured.objectId))
      previous = snapshot.source
    }
    const final = snapshots.at(-1), independent = state()
    await drain(independent, false)
    assertLogical(independent, final.expected); assert.equal(independent.raw, "")
    const events = structuredClone(independent.events), usage = structuredClone([...independent.usage.values()])
    await drain(independent, true, { ...paged, rawSegmentBytes: 8192, rawBytesPerObservation: 8192 })
    assert.deepEqual(independent.events, events); assert.deepEqual([...independent.usage.values()], usage)
    assert.equal(independent.raw, final.source)
    assert.deepEqual(independent.events, captured.events); assert.deepEqual([...independent.usage.values()], [...captured.usage.values()])
  } finally { process.env.ATAPE_CLAUDE_HOME = sourceHome }
}

async function generatedContinuity(count) {
  const templates = (await readFile(join(packageRoot, "fixtures", "native-manual-read-reinjection-2.1.263", "secondcontinue.jsonl"), "utf8"))
    .trimEnd().split("\n").map(line => JSON.parse(line))
  const sessionId = "00000000-0000-4000-8000-000000000001", rows = [], eventSourceUuids = [], usageSourceIds = []
  let sequence = 0, leaf = null, slug, inputTokens = 0, outputTokens = 0
  const id = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`
  const fresh = (template, parent = leaf) => {
    const row = structuredClone(template)
    row.uuid = id(); row.parentUuid = parent; row.sessionId = sessionId; row.cwd = projectDirectory
    row.timestamp = new Date(Date.UTC(2026, 9, 9, 0, 0, sequence)).toISOString()
    if (slug) row.slug = slug; else delete row.slug
    return row
  }
  const add = row => { rows.push(row); leaf = row.uuid; return row }
  const ordinary = label => {
    const user = fresh(templates[43]); user.promptId = id(); user.message.content = `GEN_USER ${label}`
    add(user); eventSourceUuids.push(user.uuid)
    add(fresh(templates[44]))
    const answer = fresh(templates[45]); answer.apiBlockIndex = 0; answer.message.id = `generated_api_${sequence}`
    answer.message.content = [{ type: "text", text: `GEN_ASSISTANT ${label}` }]
    answer.message.usage.input_tokens = 20; answer.message.usage.output_tokens = 10
    add(answer); eventSourceUuids.push(answer.uuid); usageSourceIds.push(answer.message.id); inputTokens += 20; outputTokens += 10
    return rows.slice(-3)
  }
  ordinary("seed")
  for (let round = 0; round < count; round++) {
    for (let gap = 0; gap < round % 3; gap++) ordinary(`gap-${round}-${gap}`)
    const originals = ordinary(`before-${round}`), previousLeaf = leaf, manual = round % 3 === 1
    if (!manual) {
      slug ??= "generated-stable-slug"
      for (const original of originals) { const copy = structuredClone(original); copy.slug ??= slug; rows.push(copy) }
    }
    const boundary = fresh(templates[31], null), anchor = id(), retained = originals.map(row => row.uuid)
    boundary.logicalParentUuid = previousLeaf; boundary.compactMetadata.trigger = manual ? "manual" : "auto"
    boundary.compactMetadata.preservedSegment = { headUuid: retained[0], tailUuid: retained.at(-1), anchorUuid: anchor }
    boundary.compactMetadata.preservedMessages = { anchorUuid: anchor, uuids: retained, allUuids: [...retained] }; add(boundary)
    const summary = fresh(templates[32]); summary.uuid = anchor; summary.message.content = `GEN_INTERNAL_SUMMARY ${round}`; add(summary)
    if (manual) for (const template of templates.slice(33, 36)) add(fresh(template))
    for (let index = 0; index < round % 5; index++) {
      const frame = fresh(templates[36]), path = join(projectDirectory, `reused-${index % 2}.txt`)
      frame.attachment.filename = path; frame.attachment.displayPath = path; frame.attachment.content.file.filePath = path
      frame.attachment.content.file.content = `GEN_INTERNAL_FILE ${round}/${index}\n`; add(frame)
    }
    ordinary(`after-${round}`)
  }
  return { sessionId, snapshots: [{ source: rows.map(row => JSON.stringify(row) + "\n").join(""),
    expected: { eventCount: eventSourceUuids.length, distinctUsageCount: usageSourceIds.length, inputTokens, outputTokens, eventSourceUuids, usageSourceIds } }] }
}

async function run(file, arguments_, cwd) {
  try {
    return await execute(file, arguments_, {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024
    })
  } catch (cause) {
    const detail = cause && typeof cause === "object"
      ? `\nstdout: ${cause.stdout ?? ""}\nstderr: ${cause.stderr ?? ""}`
      : ""
    throw new Error(`${file} ${arguments_.join(" ")} failed${detail}`, { cause })
  }
}
