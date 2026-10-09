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
    await verifyClaudeManualCompaction(adapter, context, request.limits)
    await verifyClaudeManualTextTail(adapter, context, request.limits)
    await verifyClaudeAutomaticTextReplay(adapter, context, request.limits)
    await verifyClaudeReadPair(adapter, context, request.limits)
    await verifyClaudeAutomaticReadReplay(adapter, context, request.limits)
    await verifyClaudeAutomaticReadReplay(adapter, context, request.limits, {
      fixtureName: "native-repeated-auto-read-2.1.263", homeName: "repeated-automatic-read", repeated: true
    })
    await verifyClaudeAutomaticReadReplay(adapter, context, request.limits, {
      fixtureName: "native-reversed-read-pair-2.1.263", homeName: "reversed-read-pair", reversed: true
    })
    await verifyClaudeAutomaticReadReplay(adapter, context, request.limits, {
      fixtureName: "native-repeated-dual-read-2.1.263", homeName: "repeated-dual-read", repeatedDual: true
    })
    await verifyClaudeManualReadReinjection(adapter, context, request.limits)
    await verifyClaudeManualReadReinjection(adapter, context, request.limits, {
      fixtureName: "native-manual-large-read-reinjection-2.1.263",
      homeName: "manual-large-read-reinjection", omitToolOutput: true,
      summaryMarker: "ATAPE_MANUAL_LARGE_SUMMARY", missingSummaryUsageId: "msg_atape_manual_large_1_mock_5"
    })
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

async function verifyClaudeManualCompaction(adapter, context, limits) {
  const fixtureDirectory = join(packageRoot, "fixtures", "native-manual-compact-2.1.263")
  const { sessionId, fixtureCwd } = JSON.parse(await readFile(join(fixtureDirectory, "provenance.json"), "utf8"))
  const manualHome = join(temporaryRoot, "manual-compact-source-home")
  const directory = join(manualHome, "projects", "fixture"), sourceFile = join(directory, `${sessionId}.jsonl`)
  await mkdir(directory, { recursive: true })
  process.env.ATAPE_CLAUDE_HOME = manualHome
  const pagedLimits = { ...limits, eventsPerObservation: 2 }
  let cursor = null, previousSource = "", rawContent = "", sourceObjectId, sourceGeneration
  const rawProgress = new Map(), events = [], usage = []
  const collect = () => collectInstalled(adapter, context, cursor, [...rawProgress.values()], pagedLimits)
  try {
    for (const [snapshot, eventCount, usageCount] of [["before.jsonl", 4, 2], ["compacted.jsonl", 0, 0], ["continued.jsonl", 2, 1]]) {
      const source = (await readFile(join(fixtureDirectory, snapshot), "utf8")).replaceAll(
        JSON.stringify(fixtureCwd).slice(1, -1), JSON.stringify(projectDirectory).slice(1, -1)
      )
      assert.ok(source.startsWith(previousSource), `${snapshot} must preserve the captured source prefix`)
      if (previousSource === "") await writeFile(sourceFile, source)
      else await appendFile(sourceFile, source.slice(previousSource.length))
      previousSource = source
      const oldEvents = events.length, oldUsage = usage.length
      let finished = false
      for (let index = 0; index < limits.pagesPerCycle; index++) {
        const page = await collect()
        assert.deepEqual(await collect(), page, `${snapshot} must replay an unacknowledged page exactly after reopening`)
        assert.equal(page.sourceFailures, undefined)
        assert.equal(typeof page.nextCursor, "string")
        for (const observation of page.observations) {
          assert.equal(observation.session.sourceSessionId, sessionId)
          assert.deepEqual(observation.threads.map(thread => thread.sourceThreadId), ["root"])
          for (const event of observation.events) {
            assert.equal(event.sourceThreadId, "root")
            assert.ok(!events.some(previous => previous.sourceEventId === event.sourceEventId), "Acknowledged conversation Events must not repeat")
            events.push(event)
          }
          for (const sample of observation.usage) {
            assert.equal(sample.sourceThreadId, "root")
            assert.ok(!usage.some(previous => previous.sourceUsageId === sample.sourceUsageId), "Acknowledged assistant usage must not repeat")
            assert.notEqual(sample.model, "<synthetic>")
            usage.push(sample)
          }
          for (const raw of observation.rawSegments) {
            sourceObjectId ??= raw.sourceObjectId
            sourceGeneration ??= raw.sourceGeneration
            assert.equal(raw.sourceObjectId, sourceObjectId, "Compaction must retain the original Raw object")
            assert.equal(raw.sourceGeneration, sourceGeneration)
            assert.equal(raw.sourceOffset, Buffer.byteLength(rawContent))
            rawContent += raw.content
            rawProgress.set(JSON.stringify([raw.sourceObjectId, raw.sourceGeneration]), {
              sourceSessionId: sessionId, sourceObjectId: raw.sourceObjectId, sourceGeneration: raw.sourceGeneration,
              sourceOffset: Buffer.byteLength(rawContent), finalized: raw.final
            })
          }
        }
        cursor = page.nextCursor
        if (!page.hasMore) { finished = true; break }
      }
      assert.ok(finished, `${snapshot} did not finish within its page budget`)
      assert.equal(events.length - oldEvents, eventCount, `${snapshot} conversation Event count`)
      assert.equal(usage.length - oldUsage, usageCount, `${snapshot} real assistant usage count`)
      assert.equal(rawContent, source, `${snapshot} must be captured fully in the same Raw object`)
      assert.ok(events.every(event => event.rawRef.sourceObjectId === sourceObjectId))
      const restarted = await collect()
      assert.deepEqual(restarted.observations, [])
      assert.equal(restarted.hasMore, false)
      assert.equal(restarted.nextCursor, cursor)
      assert.equal(restarted.sourceFailures, undefined)
    }
    assert.deepEqual(events.map(event => event.sourceEventId), [
      "fe855ecb-3e1a-44fe-8589-2176429d0729:0", "b466529b-c2df-4dfb-99e6-89139fc3d859:0",
      "7d468b3a-cbd7-464f-b9c7-c0a5dcaf4b01:0", "8db917d1-678c-44e4-8fad-a9688cc8d705:0",
      "8f8fd7be-2f69-43f5-8b82-05402f42cc77:0", "afd3678f-ff79-4bad-9c5b-702b125f379f:0"
    ])
    assert.deepEqual(usage.map(sample => sample.sourceUsageId), [
      "msg_atape_compact_mock_1", "msg_atape_compact_mock_2", "msg_atape_compact_mock_4"
    ])
    assert.equal(usage.reduce((sum, sample) => sum + sample.inputTokens, 0), 81)
    assert.equal(usage.reduce((sum, sample) => sum + sample.outputTokens, 0), 37)
    for (const marker of ["ATAPE_COMPACT_SUMMARY", "<command-name>/compact", "No response requested."]) {
      assert.ok(rawContent.includes(marker))
      assert.ok(!JSON.stringify([events, usage]).includes(marker), `${marker} must remain Raw-only`)
    }
    assert.equal(events.at(-1).update.content.text, "ATAPE_AFTER_COMPACT: cobalt heron 482 retained from controlled summary.")
  } finally { process.env.ATAPE_CLAUDE_HOME = sourceHome }
}

async function collectInstalled(adapter, context, cursor, rawProgress, limits, rawCaptureEnabled) {
  // Reopen the installed artifact for every page, using only durable Host state.
  const runtime = await adapter.createAtapeAdapter({ ...context, signal: AbortSignal.timeout(5_000) })
  try {
    return await runtime.collect({ protocolVersion: context.protocolVersion, cursor, limits,
      rawProgress, ...(rawCaptureEnabled === undefined ? {} : { rawCaptureEnabled }), signal: AbortSignal.timeout(5_000) })
  } finally { await runtime.close?.() }
}

async function verifyClaudeManualTextTail(adapter, context, limits) {
  const fixtureDirectory = join(packageRoot, "fixtures", "native-manual-text-tail-2.1.263")
  const provenance = JSON.parse(await readFile(join(fixtureDirectory, "provenance.json"), "utf8"))
  const { sessionId, fixtureCwd } = provenance
  const textHome = join(temporaryRoot, "manual-text-tail-source-home")
  const directory = join(textHome, "projects", "fixture"), sourceFile = join(directory, `${sessionId}.jsonl`)
  await mkdir(directory, { recursive: true })
  process.env.ATAPE_CLAUDE_HOME = textHome
  const pagedLimits = { ...limits, eventsPerObservation: 1 }
  let cursor = null, previousSource = "", rawContent = "", sourceObjectId, sourceGeneration
  const rawProgress = new Map(), events = [], usage = new Map()
  const collect = () => collectInstalled(adapter, context, cursor, [...rawProgress.values()], pagedLimits)
  try {
    for (const snapshot of provenance.snapshots) {
      const source = (await readFile(join(fixtureDirectory, snapshot.file), "utf8")).replaceAll(
        JSON.stringify(fixtureCwd).slice(1, -1), JSON.stringify(projectDirectory).slice(1, -1)
      )
      assert.ok(source.startsWith(previousSource), `${snapshot.file} must preserve the native source prefix`)
      if (previousSource === "") await writeFile(sourceFile, source)
      else await appendFile(sourceFile, source.slice(previousSource.length))
      previousSource = source
      const oldEvents = events.length, oldUsage = usage.size
      let finished = false
      for (let index = 0; index < limits.pagesPerCycle; index++) {
        const page = await collect()
        assert.deepEqual(await collect(), page, `${snapshot.file} must retry identically after reopening`)
        assert.equal(page.sourceFailures, undefined)
        assert.equal(typeof page.nextCursor, "string")
        for (const observation of page.observations) {
          assert.equal(observation.session.sourceSessionId, sessionId)
          assert.deepEqual(observation.threads.map(thread => thread.sourceThreadId), ["root"])
          for (const event of observation.events) {
            assert.equal(event.sourceThreadId, "root")
            assert.ok(!events.some(previous => previous.sourceEventId === event.sourceEventId))
            events.push(event)
          }
          for (const sample of observation.usage) {
            assert.equal(sample.sourceThreadId, "root")
            assert.notEqual(sample.model, "<synthetic>")
            const previous = usage.get(sample.sourceUsageId)
            if (previous) {
              assert.equal(sample.sourceUsageId, provenance.retainedTail.apiId)
              assert.ok(sample.revision > previous.revision)
              assert.equal(sample.inputTokens, previous.inputTokens)
              assert.equal(sample.outputTokens, previous.outputTokens)
            }
            usage.set(sample.sourceUsageId, sample)
          }
          for (const raw of observation.rawSegments) {
            sourceObjectId ??= raw.sourceObjectId
            sourceGeneration ??= raw.sourceGeneration
            assert.equal(raw.sourceObjectId, sourceObjectId)
            assert.equal(raw.sourceGeneration, sourceGeneration)
            assert.equal(raw.sourceOffset, Buffer.byteLength(rawContent))
            rawContent += raw.content
            rawProgress.set(JSON.stringify([raw.sourceObjectId, raw.sourceGeneration]), {
              sourceSessionId: sessionId, sourceObjectId: raw.sourceObjectId, sourceGeneration: raw.sourceGeneration,
              sourceOffset: Buffer.byteLength(rawContent), finalized: raw.final
            })
          }
        }
        cursor = page.nextCursor
        if (!page.hasMore) { finished = true; break }
      }
      assert.ok(finished, `${snapshot.file} did not finish within its page budget`)
      assert.equal(events.length - oldEvents, snapshot.expected.addedEvents)
      assert.equal(usage.size - oldUsage, snapshot.expected.addedDistinctUsage)
      assert.equal(events.length, snapshot.expected.eventCount)
      assert.equal(usage.size, snapshot.expected.distinctUsageCount)
      assert.equal([...usage.values()].reduce((sum, sample) => sum + sample.inputTokens, 0), snapshot.expected.inputTokens)
      assert.equal([...usage.values()].reduce((sum, sample) => sum + sample.outputTokens, 0), snapshot.expected.outputTokens)
      for (const [apiId, expected] of Object.entries(snapshot.expected.distinctUsageByApiId)) {
        const sample = usage.get(apiId)
        assert.ok(sample, `${snapshot.file} must retain assistant usage ${apiId}`)
        assert.equal(sample.inputTokens, expected.inputTokens)
        assert.equal(sample.outputTokens, expected.outputTokens)
        assert.equal(sample.model, expected.model)
      }
      assert.equal(rawContent, source)
      assert.ok(events.every(event => event.rawRef.sourceObjectId === sourceObjectId))
      const restarted = await collect()
      assert.deepEqual(restarted.observations, [])
      assert.equal(restarted.hasMore, false)
      assert.equal(restarted.nextCursor, cursor)
      assert.equal(restarted.sourceFailures, undefined)
    }
    assert.deepEqual(events.map(event => event.sourceEventId),
      provenance.snapshots.at(-1).expected.eventSourceUuids.map(uuid => `${uuid}:0`))
    for (const marker of ["ATAPE_MANUAL_TEXT_SUMMARY", "<command-name>/compact", "No response requested."]) {
      assert.ok(rawContent.includes(marker))
      assert.ok(!JSON.stringify([events, [...usage.values()]]).includes(marker), `${marker} must remain Raw-only`)
    }
  } finally { process.env.ATAPE_CLAUDE_HOME = sourceHome }
}

async function verifyClaudeAutomaticTextReplay(adapter, context, limits) {
  const fixtureDirectory = join(packageRoot, "fixtures", "native-auto-text-replay-rounds-2.1.263")
  const provenance = JSON.parse(await readFile(join(fixtureDirectory, "provenance.json"), "utf8"))
  const { sessionId, fixtureCwd } = provenance
  const autoHome = join(temporaryRoot, "auto-text-source-home")
  const directory = join(autoHome, "projects", "fixture"), sourceFile = join(directory, `${sessionId}.jsonl`)
  await mkdir(directory, { recursive: true })
  process.env.ATAPE_CLAUDE_HOME = autoHome
  const pagedLimits = { ...limits, eventsPerObservation: 1 }
  let cursor = null, previousSource = "", rawContent = "", sourceObjectId, sourceGeneration
  const rawProgress = new Map(), events = [], usage = new Map()
  const collect = () => collectInstalled(adapter, context, cursor, [...rawProgress.values()], pagedLimits)
  const appendSource = async source => {
    assert.ok(source.startsWith(previousSource), "Automatic replay test cuts must preserve the native prefix")
    if (previousSource === "") await writeFile(sourceFile, source)
    else await appendFile(sourceFile, source.slice(previousSource.length))
    previousSource = source
  }
  const assertTotals = expected => {
    assert.deepEqual(events.map(event => event.sourceEventId), expected.eventSourceUuids.map(uuid => `${uuid}:0`))
    assert.equal(events.length, expected.uniqueCanonicalEventCount)
    assert.equal(usage.size, expected.distinctUsageCount)
    assert.equal([...usage.values()].reduce((sum, sample) => sum + sample.inputTokens, 0), expected.inputTokens)
    assert.equal([...usage.values()].reduce((sum, sample) => sum + sample.outputTokens, 0), expected.outputTokens)
    assert.deepEqual([...usage.keys()].sort(), Object.keys(expected.latestUsageByApiId).sort())
    for (const [apiId, value] of Object.entries(expected.latestUsageByApiId)) {
      const sample = usage.get(apiId)
      assert.equal(sample.model, value.model)
      assert.equal(sample.inputTokens, value.inputTokens)
      assert.equal(sample.outputTokens, value.outputTokens)
    }
  }
  const drain = async (expected, source, pending) => {
    let finished = false
    for (let index = 0; index < limits.pagesPerCycle; index++) {
      const page = await collect()
      assert.deepEqual(await collect(), page, "Installed automatic replay must retry identically after reopening")
      assert.equal(page.sourceFailures, undefined)
      assert.equal(typeof page.nextCursor, "string")
      for (const observation of page.observations) {
        assert.equal(observation.session.sourceSessionId, sessionId)
        assert.deepEqual(observation.threads.map(thread => thread.sourceThreadId), ["root"])
        assert.ok(Buffer.byteLength(JSON.stringify({ ...observation, rawSegments: [] })) <= limits.canonicalBytesPerObservation)
        for (const event of observation.events) {
          assert.equal(event.sourceThreadId, "root")
          assert.ok(!events.some(previous => previous.sourceEventId === event.sourceEventId))
          events.push(event)
        }
        for (const sample of observation.usage) {
          assert.equal(sample.sourceThreadId, "root")
          assert.ok(!usage.has(sample.sourceUsageId), "Copied users and summaries must not add or replay usage")
          usage.set(sample.sourceUsageId, sample)
        }
        for (const raw of observation.rawSegments) {
          sourceObjectId ??= raw.sourceObjectId
          sourceGeneration ??= raw.sourceGeneration
          assert.equal(raw.sourceObjectId, sourceObjectId)
          assert.equal(raw.sourceGeneration, sourceGeneration)
          assert.equal(raw.sourceOffset, Buffer.byteLength(rawContent))
          rawContent += raw.content
          rawProgress.set(raw.sourceObjectId, { sourceSessionId: sessionId, sourceObjectId: raw.sourceObjectId,
            sourceGeneration: raw.sourceGeneration, sourceOffset: Buffer.byteLength(rawContent), finalized: raw.final })
        }
      }
      cursor = page.nextCursor
      if (!page.hasMore) { finished = true; break }
    }
    assert.ok(finished, "Installed automatic replay did not finish within its page budget")
    assertTotals(expected)
    assert.equal(rawContent, source)
    assert.ok(events.every(event => event.rawRef.sourceObjectId === sourceObjectId))
    const idle = await collect()
    assert.deepEqual(idle.observations, [])
    assert.equal(idle.nextCursor, cursor)
    assert.equal(idle.hasMore, false)
    assert.equal(idle.sourceFailures, undefined)
    assert.equal(idle.progress.pendingCanonicalSessions, pending)
  }
  const prefix = (source, line) => source.split("\n").slice(0, line).join("\n") + "\n"
  try {
    for (const snapshot of provenance.nativeSnapshots) {
      const source = (await readFile(join(fixtureDirectory, snapshot.file), "utf8")).replaceAll(
        JSON.stringify(fixtureCwd).slice(1, -1), JSON.stringify(projectDirectory).slice(1, -1)
      )
      const round = provenance.rounds.find(round => round.phase === snapshot.phase)
      if (round) {
        const originals = prefix(source, round.lines.originalG)
        const originalExpected = provenance.testCuts.find(cut => cut.round === round.round && cut.part === "originals").expected
        await appendSource(originals)
        await drain(originalExpected, originals, 0)
        // These are byte/line cuts of a native invocation, not additional native snapshots.
        // Incomplete copied groups cannot advance either Canonical or eligible Raw progress.
        const firstCopy = source.split("\n")[round.lines.copyU - 1]
        const waitingSources = [originals + firstCopy.slice(0, Math.floor(firstCopy.length / 2)),
          prefix(source, round.lines.copyU), prefix(source, round.lines.copyG), prefix(source, round.lines.B)]
        for (const waiting of waitingSources) {
          await appendSource(waiting)
          const page = await collect()
          assert.deepEqual(await collect(), page)
          assert.deepEqual(page.observations, [])
          assert.equal(page.nextCursor, cursor)
          assert.equal(page.hasMore, false)
          assert.equal(page.sourceFailures, undefined)
          assert.equal(page.progress.pendingCanonicalSessions, 1)
        }
        const summary = prefix(source, round.lines.S)
        await appendSource(summary)
        const summaryExpected = provenance.testCuts.find(cut => cut.round === round.round && cut.part === "through-summary").expected
        await drain(summaryExpected, summary, 1)
      }
      await appendSource(source)
      await drain(snapshot.expected, source, 0)
    }
    for (const missing of provenance.summarizationUsageLimit.inferredMockSummaryApiIds) assert.ok(!usage.has(missing))
    assert.equal(events.length, 10)
    assert.equal(usage.size, 5)
    assert.equal([...usage.values()].reduce((sum, sample) => sum + sample.inputTokens, 0), 760023)
    assert.equal([...usage.values()].reduce((sum, sample) => sum + sample.outputTokens, 0), 63)
  } finally { process.env.ATAPE_CLAUDE_HOME = sourceHome }
}

async function verifyClaudeReadPair(adapter, context, limits) {
  const fixtureDirectory = join(packageRoot, "fixtures", "native-read-pair-2.1.263")
  const provenance = JSON.parse(await readFile(join(fixtureDirectory, "provenance.json"), "utf8"))
  const relocate = source => source.replaceAll(JSON.stringify(provenance.fixtureCwd).slice(1, -1),
    JSON.stringify(projectDirectory).slice(1, -1))
  const prefix = (source, line) => source.split("\n").slice(0, line).join("\n") + "\n"
  const pagedLimits = { ...limits, eventsPerObservation: 1 }
  try {
    for (const fixtureCase of provenance.cases) {
      const directory = join(temporaryRoot, `read-pair-${fixtureCase.id}`, "projects", "fixture")
      await mkdir(directory, { recursive: true })
      process.env.ATAPE_CLAUDE_HOME = join(temporaryRoot, `read-pair-${fixtureCase.id}`)
      const sourceFile = join(directory, `${fixtureCase.sessionId}.jsonl`)
      let cursor = null, previousSource = "", rawContent = "", sourceObjectId, sourceGeneration
      const rawProgress = new Map(), events = [], usage = new Map()
      const collect = () => collectInstalled(adapter, context, cursor, [...rawProgress.values()], pagedLimits)
      const appendSource = async source => {
        assert.ok(source.startsWith(previousSource), "Read-pair cuts must retain the native prefix")
        if (!previousSource) await writeFile(sourceFile, source)
        else await appendFile(sourceFile, source.slice(previousSource.length))
        previousSource = source
      }
      const drain = async (expected, source, pending) => {
        const previousEvents = [...events]
        let finished = false
        for (let index = 0; index < limits.pagesPerCycle; index++) {
          const page = await collect()
          assert.deepEqual(await collect(), page, "Installed Read-pair retry must be identical after reopening")
          assert.equal(page.sourceFailures, undefined)
          assert.equal(typeof page.nextCursor, "string")
          for (const observation of page.observations) {
            assert.equal(observation.session.sourceSessionId, fixtureCase.sessionId)
            assert.deepEqual(observation.threads.map(thread => thread.sourceThreadId), ["root"])
            assert.ok(observation.events.length <= 1)
            assert.ok(Buffer.byteLength(JSON.stringify({ ...observation, rawSegments: [] })) <= limits.canonicalBytesPerObservation)
            for (const event of observation.events) {
              assert.equal(event.sourceThreadId, "root")
              assert.ok(!events.some(previous => previous.sourceEventId === event.sourceEventId))
              events.push(event)
            }
            for (const sample of observation.usage) {
              assert.equal(sample.sourceThreadId, "root")
              const previous = usage.get(sample.sourceUsageId)
              assert.ok(!previous || sample.revision > previous.revision, "Split API records must update one usage identity at a later revision")
              usage.set(sample.sourceUsageId, sample)
            }
            for (const raw of observation.rawSegments) {
              sourceObjectId ??= raw.sourceObjectId
              sourceGeneration ??= raw.sourceGeneration
              assert.equal(raw.sourceObjectId, sourceObjectId)
              assert.equal(raw.sourceGeneration, sourceGeneration)
              assert.equal(raw.sourceOffset, Buffer.byteLength(rawContent))
              rawContent += raw.content
              rawProgress.set(raw.sourceObjectId, { sourceSessionId: fixtureCase.sessionId, sourceObjectId: raw.sourceObjectId,
                sourceGeneration: raw.sourceGeneration, sourceOffset: Buffer.byteLength(rawContent), finalized: raw.final })
            }
          }
          cursor = page.nextCursor
          if (!page.hasMore) { finished = true; break }
        }
        assert.ok(finished, "Installed Read-pair did not finish within its page budget")
        assert.deepEqual(events.slice(0, previousEvents.length), previousEvents)
        assert.equal(events.length, expected.uniqueCanonicalEventCount)
        assert.equal(usage.size, expected.distinctUsageCount)
        assert.equal([...usage.values()].reduce((sum, sample) => sum + sample.inputTokens, 0), expected.inputTokens)
        assert.equal([...usage.values()].reduce((sum, sample) => sum + sample.outputTokens, 0), expected.outputTokens)
        if (expected.eventSourceUuids) assert.deepEqual(events.map(event => event.sourceEventId), expected.eventSourceUuids.map(uuid => `${uuid}:0`))
        if (expected.latestUsageByApiId) for (const [apiId, value] of Object.entries(expected.latestUsageByApiId)) {
          const sample = usage.get(apiId)
          assert.equal(sample.model, value.model)
          assert.equal(sample.inputTokens, value.inputTokens)
          assert.equal(sample.outputTokens, value.outputTokens)
          assert.equal(sample.revision, Buffer.byteLength(prefix(source, value.latestObservationLine)))
        }
        assert.equal(rawContent, source)
        assert.ok(events.every(event => event.rawRef.sourceObjectId === sourceObjectId))
        const idle = await collect()
        assert.deepEqual(await collect(), idle)
        assert.deepEqual(idle.observations, [])
        assert.equal(idle.nextCursor, cursor)
        assert.equal(idle.hasMore, false)
        assert.equal(idle.sourceFailures, undefined)
        assert.equal(idle.progress.pendingCanonicalSessions, pending)
        assert.equal(idle.progress.pendingRawBytes, 0)
      }
      for (const snapshot of fixtureCase.nativeSnapshots) {
        const source = relocate(await readFile(join(fixtureDirectory, snapshot.file), "utf8"))
        for (const cut of fixtureCase.derivedTestCuts.filter(cut => cut.nativeParentSnapshot === snapshot.file)) {
          const cutSource = prefix(source, cut.prefixThroughLine)
          await appendSource(cutSource)
          await drain(cut.expected, cutSource, cut.expected.pendingCanonicalSessions)
        }
        await appendSource(source)
        await drain(snapshot.expected, source, 0)
      }
      for (const call of fixtureCase.batch.calls) {
        const event = events.find(event => event.sourceEventId === `${call.uuid}:0`)
        assert.equal(event.update.sessionUpdate, "tool_call")
        assert.equal(event.update.toolCallId, call.toolBlock.id)
        assert.equal(event.update.title, "Read")
        assert.deepEqual(event.update.rawInput, JSON.parse(relocate(JSON.stringify(call.toolBlock.input))))
      }
      for (const result of fixtureCase.batch.results) {
        const event = events.find(event => event.sourceEventId === `${result.uuid}:0`)
        assert.equal(event.update.sessionUpdate, "tool_call_update")
        assert.equal(event.update.toolCallId, result.toolResultBlock.tool_use_id)
        assert.equal(event.update.status, "completed")
        assert.equal(event.update.rawOutput, result.toolResultBlock.content)
      }
    }
  } finally { process.env.ATAPE_CLAUDE_HOME = sourceHome }
}

async function verifyClaudeAutomaticReadReplay(adapter, context, limits, options = {}) {
  const controlledProfile = options.repeated || options.reversed || options.repeatedDual
  const fixtureDirectory = join(packageRoot, "fixtures", options.fixtureName ?? "native-auto-read-replay-2.1.263")
  const provenance = JSON.parse(await readFile(join(fixtureDirectory, "provenance.json"), "utf8"))
  const relocate = source => source.replaceAll(JSON.stringify(provenance.fixtureCwd).slice(1, -1),
    JSON.stringify(projectDirectory).slice(1, -1))
  const prefix = (source, line) => source.split("\n").slice(0, line).join("\n") + "\n"
  const pagedLimits = { ...limits, eventsPerObservation: 1 }
  if (controlledProfile) {
    const selected = await readFile(join(fixtureDirectory, provenance.selectedSourceRequests.file))
    assert.equal(selected.byteLength, provenance.selectedSourceRequests.bytes)
    assert.equal(createHash("sha256").update(selected).digest("hex"), provenance.selectedSourceRequests.sha256)
  }
  try {
    for (const fixtureCase of provenance.cases) {
      const selectedHome = join(temporaryRoot, `${options.homeName ?? "automatic-read"}-${fixtureCase.profile}`)
      const directory = join(selectedHome, "projects", "fixture")
      await mkdir(directory, { recursive: true })
      process.env.ATAPE_CLAUDE_HOME = selectedHome
      const sourceFile = join(directory, `${fixtureCase.sessionId}.jsonl`)
      let cursor = null, previousSource = "", rawContent = "", sourceObjectId, sourceGeneration
      const rawProgress = new Map(), events = [], usage = new Map()
      let testedCuts = 0, testedPartials = 0, receiptRecoveries = 0, capacityCases = 0
      const collect = () => collectInstalled(adapter, context, cursor, [...rawProgress.values()], pagedLimits)
      const appendSource = async source => {
        assert.ok(source.startsWith(previousSource), "Automatic Read replay must retain its native source prefix")
        if (!previousSource) await writeFile(sourceFile, source)
        else await appendFile(sourceFile, source.slice(previousSource.length))
        previousSource = source
      }
      const recoverAdvancedRawReceipts = async (page, source, lines, pending, expectedEventIds = []) => {
        assert.deepEqual(page.observations.flatMap(observation => observation.events).map(event => event.sourceEventId), expectedEventIds)
        assert.ok(page.observations.every(observation => observation.usage.length === 0))
        const offered = page.observations.flatMap(observation => observation.rawSegments)
        assert.ok(offered.length > 0, "A proved replay/file must offer eligible Raw bytes before parser ACK")
        assert.equal(offered[0].sourceOffset, Buffer.byteLength(rawContent))
        const end = offered.at(-1).sourceOffset + Buffer.byteLength(offered.at(-1).content)
        for (const line of lines) {
          const offset = Buffer.byteLength(prefix(source, line - 1)) + 32
          assert.ok(offset > Buffer.byteLength(rawContent) && offset < end)
          let recoveredCursor = cursor, recoveredContent = Buffer.from(source).subarray(0, offset).toString("utf8")
          const recoveredEvents = []
          let receipt = { sourceSessionId: fixtureCase.sessionId, sourceObjectId, sourceGeneration,
            sourceOffset: offset, finalized: false }, finished = false
          for (let index = 0; index < limits.pagesPerCycle; index++) {
            const request = () => collectInstalled(adapter, context, recoveredCursor, [receipt], pagedLimits)
            const recovered = await request()
            assert.deepEqual(await request(), recovered, "Old parser and advanced replay/file Raw receipt must retry exactly")
            assert.equal(recovered.sourceFailures, undefined)
            for (const observation of recovered.observations) {
              recoveredEvents.push(...observation.events.map(event => event.sourceEventId))
              assert.deepEqual(observation.usage, [])
              for (const raw of observation.rawSegments) {
                assert.equal(raw.sourceObjectId, sourceObjectId)
                assert.equal(raw.sourceGeneration, sourceGeneration)
                assert.equal(raw.sourceOffset, Buffer.byteLength(recoveredContent))
                recoveredContent += raw.content
                receipt = { ...receipt, sourceOffset: Buffer.byteLength(recoveredContent), finalized: raw.final }
              }
            }
            recoveredCursor = recovered.nextCursor
            if (!recovered.hasMore) { finished = true; break }
          }
          assert.ok(finished, "Advanced replay/file Raw receipt recovery exceeded its page budget")
          assert.deepEqual(recoveredEvents, expectedEventIds, "Advanced Raw receipts must preserve uncommitted receipt Events exactly once")
          assert.equal(recoveredContent, source)
          const idle = await collectInstalled(adapter, context, recoveredCursor, [receipt], pagedLimits)
          assert.deepEqual(await collectInstalled(adapter, context, recoveredCursor, [receipt], pagedLimits), idle)
          assert.deepEqual(idle.observations, [])
          assert.equal(idle.nextCursor, recoveredCursor)
          assert.equal(idle.hasMore, false)
          assert.equal(idle.progress.pendingCanonicalSessions, pending)
          assert.equal(idle.progress.pendingRawBytes, 0)
          receiptRecoveries++
        }
      }
      const assertOriginalUsage = committedSource => {
        // Source UUIDs distinguish real split API records from byte-for-byte
        // replay copies. Check each API's revision against its latest committed
        // original record, including F0 before the later F1 exists.
        const identified = new Set(), latest = new Map()
        let end = 0
        for (const line of committedSource.split("\n").filter(Boolean)) {
          end += Buffer.byteLength(line) + 1
          const record = JSON.parse(line)
          if (!record.uuid || identified.has(record.uuid)) continue
          identified.add(record.uuid)
          if (record.type === "assistant" && record.message?.usage) latest.set(record.message.id, { record, end })
        }
        assert.equal(latest.size, usage.size)
        for (const [apiId, value] of latest) {
          const sample = usage.get(apiId)
          assert.equal(sample.model, value.record.message.model)
          assert.equal(sample.inputTokens, value.record.message.usage.input_tokens)
          assert.equal(sample.outputTokens, value.record.message.usage.output_tokens)
          assert.equal(sample.revision, value.end, "Copied API usage must not move its original source revision")
        }
      }
      const freshRawCapacity = async source => {
        const bytes = Buffer.byteLength(source) - Buffer.byteLength(rawContent)
        const receipts = [...rawProgress.values()], durable = JSON.stringify({ cursor, receipts })
        const selectedFile = process.env.ATAPE_CLAUDE_SESSION_FILE
        process.env.ATAPE_CLAUDE_SESSION_FILE = sourceFile
        try { for (const enabled of [false, true]) {
          const below = { ...pagedLimits, rawSegmentBytes: bytes - 1, rawBytesPerObservation: bytes - 1 }
          for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(
            () => collectInstalled(adapter, context, cursor, receipts, below, enabled), error => error.reason === "limit")
          const exact = { ...below, rawSegmentBytes: bytes, rawBytesPerObservation: bytes }
          const page = await collectInstalled(adapter, context, cursor, receipts, exact, enabled)
          assert.deepEqual(await collectInstalled(adapter, context, cursor, receipts, exact, enabled), page)
          assert.equal(page.sourceFailures, undefined)
          assert.notEqual(page.nextCursor, cursor)
          assert.equal(page.hasMore, false)
          assert.ok(page.observations.every(observation => observation.events.length === 0 && observation.usage.length === 0))
          assert.equal(page.observations.flatMap(observation => observation.rawSegments).map(raw => raw.content).join(""),
            enabled ? source.slice(rawContent.length) : "")
          assert.equal(JSON.stringify({ cursor, receipts }), durable)
          capacityCases += 2
        } } finally {
          if (selectedFile === undefined) delete process.env.ATAPE_CLAUDE_SESSION_FILE
          else process.env.ATAPE_CLAUDE_SESSION_FILE = selectedFile
        }
      }
      const fileWitnessCapacity = async (source, line) => {
        const prior = prefix(source, line - 1), original = JSON.parse(source.split("\n")[line - 1])
        const receipts = [...rawProgress.values()], durable = JSON.stringify({ cursor, receipts })
        const selectedFile = process.env.ATAPE_CLAUDE_SESSION_FILE
        process.env.ATAPE_CLAUDE_SESSION_FILE = sourceFile
        try { for (const enabled of [false, true]) for (const bytes of [64 * 1024, 64 * 1024 + 1]) {
          const record = { ...original, atapePackageCapacityProbe: "" }
          record.atapePackageCapacityProbe = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(record)) - 1)
          const selectedSource = prior + JSON.stringify(record) + "\n"
          assert.equal(Buffer.byteLength(selectedSource) - Buffer.byteLength(prior), bytes)
          await writeFile(sourceFile, selectedSource)
          const request = () => collectInstalled(adapter, context, cursor, receipts, pagedLimits, enabled)
          if (bytes > 64 * 1024) for (let attempt = 0; attempt < 2; attempt++)
            await assert.rejects(request, error => error.reason === "limit")
          else {
            const page = await request()
            assert.deepEqual(await request(), page)
            assert.equal(page.sourceFailures, undefined)
            assert.equal(page.progress.pendingCanonicalSessions, 1)
            assert.equal(page.hasMore, false)
            assert.ok(page.observations.every(observation => observation.events.length === 0 && observation.usage.length === 0))
            assert.equal(page.observations.flatMap(observation => observation.rawSegments).map(raw => raw.content).join(""),
              enabled ? selectedSource.slice(prior.length) : "")
          }
          assert.equal(JSON.stringify({ cursor, receipts }), durable)
          capacityCases++
        } } finally {
          await writeFile(sourceFile, source)
          if (selectedFile === undefined) delete process.env.ATAPE_CLAUDE_SESSION_FILE
          else process.env.ATAPE_CLAUDE_SESSION_FILE = selectedFile
        }
      }
      const verifyRawPolicy = async source => {
        let policyCursor = null, finished = false
        const policyEvents = [], policyUsage = new Map()
        for (let index = 0; index < 100; index++) {
          const request = () => collectInstalled(adapter, context, policyCursor, [], pagedLimits, false)
          const page = await request()
          assert.deepEqual(await request(), page)
          assert.equal(page.sourceFailures, undefined)
          for (const observation of page.observations) {
            assert.deepEqual(observation.rawSegments, [])
            policyEvents.push(...observation.events)
            for (const sample of observation.usage) policyUsage.set(sample.sourceUsageId, sample)
          }
          policyCursor = page.nextCursor
          if (!page.hasMore) { finished = true; break }
        }
        assert.ok(finished, "Raw-off replay capture exceeded its page budget")
        assert.deepEqual(policyEvents, events)
        assert.deepEqual([...policyUsage], [...usage])
        let receipts = [], recoveredContent = "", backfilled = false
        for (let index = 0; index < limits.pagesPerCycle; index++) {
          const request = () => collectInstalled(adapter, context, policyCursor, receipts, pagedLimits, true)
          const page = await request()
          assert.deepEqual(await request(), page)
          assert.equal(page.sourceFailures, undefined)
          for (const observation of page.observations) {
            assert.deepEqual(observation.events, [])
            assert.deepEqual(observation.usage, [])
            for (const raw of observation.rawSegments) {
              assert.equal(raw.sourceObjectId, sourceObjectId)
              assert.equal(raw.sourceGeneration, sourceGeneration)
              assert.equal(raw.sourceOffset, Buffer.byteLength(recoveredContent))
              recoveredContent += raw.content
              receipts = [{ sourceSessionId: fixtureCase.sessionId, sourceObjectId, sourceGeneration,
                sourceOffset: Buffer.byteLength(recoveredContent), finalized: raw.final }]
            }
          }
          policyCursor = page.nextCursor
          if (!page.hasMore) { backfilled = true; break }
        }
        assert.ok(backfilled, "Raw-on replay backfill exceeded its page budget")
        assert.equal(recoveredContent, source)
        const idle = await collectInstalled(adapter, context, policyCursor, receipts, pagedLimits, true)
        assert.deepEqual(await collectInstalled(adapter, context, policyCursor, receipts, pagedLimits, true), idle)
        assert.deepEqual(idle.observations, [])
        assert.equal(idle.nextCursor, policyCursor)
        assert.equal(idle.progress.pendingCanonicalSessions, 0)
        assert.equal(idle.progress.pendingRawBytes, 0)
      }
      const firstReverseCapacity = async (source, fullSource, line) => {
        const inputReceipts = [...rawProgress.values()], durable = JSON.stringify({ cursor, inputReceipts })
        const prior = prefix(source, line - 1), original = JSON.parse(source.split("\n")[line - 1])
        const originalBytes = Buffer.byteLength(source) - Buffer.byteLength(prior)
        const selectedFile = process.env.ATAPE_CLAUDE_SESSION_FILE
        process.env.ATAPE_CLAUDE_SESSION_FILE = sourceFile
        const request = (enabled, selectedLimits = pagedLimits, selectedCursor = cursor, receipts = inputReceipts) =>
          collectInstalled(adapter, context, selectedCursor, receipts, selectedLimits, enabled)
        const expectFirst = (page, selectedSource, enabled) => {
          assert.equal(page.sourceFailures, undefined)
          assert.deepEqual(page.observations.flatMap(observation => observation.events).map(event => event.sourceEventId), [original.uuid + ":0"])
          assert.deepEqual(page.observations.flatMap(observation => observation.usage), [])
          assert.equal(page.progress.pendingCanonicalSessions, 1)
          assert.equal(page.observations.flatMap(observation => observation.rawSegments).map(raw => raw.content).join(""),
            enabled ? selectedSource.slice(prior.length) : "")
        }
        try { for (const enabled of [false, true]) {
          const below = { ...pagedLimits, rawSegmentBytes: originalBytes - 1, rawBytesPerObservation: originalBytes - 1 }
          for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(() => request(enabled, below), error => error.reason === "limit")
          const exact = { ...below, rawSegmentBytes: originalBytes, rawBytesPerObservation: originalBytes }
          const page = await request(enabled, exact)
          assert.deepEqual(await request(enabled, exact), page)
          expectFirst(page, source, enabled)
          assert.equal(page.hasMore, false)
          capacityCases += 2
          // A declared synthetic unknown field isolates the selected 64 KiB LF
          // envelope without changing any native call/receipt content.
          for (const bytes of [64 * 1024, 64 * 1024 + 1]) {
            const record = { ...original, atapePackageCapacityProbe: "" }
            record.atapePackageCapacityProbe = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(record)) - 1)
            const selectedSource = prior + JSON.stringify(record) + "\n"
            assert.equal(Buffer.byteLength(selectedSource) - Buffer.byteLength(prior), bytes)
            await writeFile(sourceFile, selectedSource)
            if (bytes > 64 * 1024) for (let attempt = 0; attempt < 2; attempt++)
              await assert.rejects(() => request(enabled), error => error.reason === "limit")
            else {
              const admitted = await request(enabled)
              assert.deepEqual(await request(enabled), admitted)
              expectFirst(admitted, selectedSource, enabled)
              assert.equal(admitted.hasMore, false)
            }
            capacityCases++
          }
          const throughSecond = prefix(fullSource, line + 1)
          await writeFile(sourceFile, throughSecond)
          const secondBytes = Buffer.byteLength(throughSecond) - Buffer.byteLength(source)
          const remaining = { ...pagedLimits, rawSegmentBytes: Math.max(originalBytes, secondBytes),
            rawBytesPerObservation: Math.max(originalBytes, secondBytes) }
          const first = await request(enabled, remaining)
          assert.deepEqual(await request(enabled, remaining), first)
          expectFirst(first, source, enabled)
          assert.equal(first.hasMore, true, "Insufficient remaining source capacity must defer the next whole receipt")
          const offered = first.observations.flatMap(observation => observation.rawSegments).at(-1)
          const receipts = offered ? [{ sourceSessionId: fixtureCase.sessionId, sourceObjectId: offered.sourceObjectId,
            sourceGeneration: offered.sourceGeneration, sourceOffset: offered.sourceOffset + Buffer.byteLength(offered.content), finalized: offered.final }] : inputReceipts
          const second = await request(enabled, remaining, first.nextCursor, receipts)
          assert.deepEqual(await request(enabled, remaining, first.nextCursor, receipts), second)
          assert.deepEqual(second.observations.flatMap(observation => observation.events).map(event => event.sourceEventId),
            [JSON.parse(fullSource.split("\n")[line]).uuid + ":0"])
          assert.deepEqual(second.observations.flatMap(observation => observation.usage), [])
          assert.equal(second.progress.pendingCanonicalSessions, 0)
          assert.equal(second.hasMore, false)
          capacityCases++
          assert.equal(JSON.stringify({ cursor, inputReceipts }), durable)
          await writeFile(sourceFile, source)
        } } finally {
          await writeFile(sourceFile, source)
          if (selectedFile === undefined) delete process.env.ATAPE_CLAUDE_SESSION_FILE
          else process.env.ATAPE_CLAUDE_SESSION_FILE = selectedFile
        }
      }
      const drain = async (expected, source, committedSource, pending, incompleteGroup = false, recoveryLines, recoveryEventIds) => {
        const previousCursor = cursor, previousEvents = [...events], previousUsage = [...usage]
        let finished = false
        for (let index = 0; index < limits.pagesPerCycle; index++) {
          const page = await collect()
          assert.deepEqual(await collect(), page, "Automatic Read replay retry must be identical in a new installed runtime")
          assert.equal(page.sourceFailures, undefined)
          assert.equal(typeof page.nextCursor, "string")
          if (incompleteGroup) assert.deepEqual(page.observations, [], "Unproved copies/B must not advance Canonical or Raw")
          if (recoveryLines && index === 0) await recoverAdvancedRawReceipts(page, source, recoveryLines, pending, recoveryEventIds)
          for (const observation of page.observations) {
            assert.equal(observation.session.sourceSessionId, fixtureCase.sessionId)
            assert.deepEqual(observation.threads.map(thread => thread.sourceThreadId), ["root"])
            assert.ok(observation.events.length <= 1)
            assert.ok(Buffer.byteLength(JSON.stringify({ ...observation, rawSegments: [] })) <= limits.canonicalBytesPerObservation)
            for (const event of observation.events) {
              assert.equal(event.sourceThreadId, "root")
              assert.ok(!events.some(previous => previous.sourceEventId === event.sourceEventId), "Copied UUIDs must not replay Events")
              events.push(event)
            }
            for (const sample of observation.usage) {
              assert.equal(sample.sourceThreadId, "root")
              const previous = usage.get(sample.sourceUsageId)
              assert.ok(!previous || sample.revision > previous.revision)
              usage.set(sample.sourceUsageId, sample)
            }
            for (const raw of observation.rawSegments) {
              sourceObjectId ??= raw.sourceObjectId
              sourceGeneration ??= raw.sourceGeneration
              assert.equal(raw.sourceObjectId, sourceObjectId)
              assert.equal(raw.sourceGeneration, sourceGeneration)
              assert.equal(raw.sourceOffset, Buffer.byteLength(rawContent))
              rawContent += raw.content
              rawProgress.set(raw.sourceObjectId, { sourceSessionId: fixtureCase.sessionId, sourceObjectId: raw.sourceObjectId,
                sourceGeneration: raw.sourceGeneration, sourceOffset: Buffer.byteLength(rawContent), finalized: raw.final })
            }
          }
          cursor = page.nextCursor
          if (!page.hasMore) { finished = true; break }
        }
        assert.ok(finished, "Installed automatic Read replay did not finish within its page budget")
        assert.deepEqual(events.slice(0, previousEvents.length), previousEvents)
        if (incompleteGroup) {
          assert.equal(cursor, previousCursor)
          assert.deepEqual([...usage], previousUsage)
        }
        assert.equal(events.length, expected.uniqueCanonicalEventCount)
        assert.equal(usage.size, expected.distinctUsageCount)
        assert.equal([...usage.values()].reduce((sum, sample) => sum + sample.inputTokens, 0), expected.inputTokens)
        assert.equal([...usage.values()].reduce((sum, sample) => sum + sample.outputTokens, 0), expected.outputTokens)
        assert.deepEqual(events.map(event => event.sourceEventId), fixtureCase.eventSourceIds.slice(0, expected.uniqueCanonicalEventCount))
        if (expected.usageSourceIds && !controlledProfile) for (const apiId of expected.usageSourceIds) {
          const value = fixtureCase.latestUsageByApiId[apiId]
          const sample = usage.get(apiId)
          assert.equal(sample.model, value.model)
          assert.equal(sample.inputTokens, value.inputTokens)
          assert.equal(sample.outputTokens, value.outputTokens)
          assert.equal(sample.revision, Buffer.byteLength(prefix(source, value.latestObservationLine)), "Raw-only copied usage must not advance its source revision")
        }
        if (controlledProfile) assertOriginalUsage(committedSource)
        assert.equal(rawContent, committedSource)
        assert.ok(events.every(event => event.rawRef.sourceObjectId === sourceObjectId))
        const idle = await collect()
        assert.deepEqual(await collect(), idle)
        assert.deepEqual(idle.observations, [])
        assert.equal(idle.nextCursor, cursor)
        assert.equal(idle.hasMore, false)
        assert.equal(idle.sourceFailures, undefined)
        assert.equal(idle.progress.pendingCanonicalSessions, pending)
        assert.equal(idle.progress.pendingRawBytes, Buffer.byteLength(source) - Buffer.byteLength(committedSource))
      }
      for (const snapshot of fixtureCase.nativeSnapshots) {
        const recorded = await readFile(join(fixtureDirectory, snapshot.file), "utf8")
        if (controlledProfile) {
          assert.equal(Buffer.byteLength(recorded), snapshot.sanitized.bytes)
          assert.equal(createHash("sha256").update(recorded).digest("hex"), snapshot.sanitized.sha256)
        }
        const source = relocate(recorded)
        for (const cut of fixtureCase.derivedTestCuts.filter(cut => cut.nativeParentSnapshot === snapshot.file)) {
          const cutSource = prefix(source, cut.prefixThroughLine)
          let recoveryLines, recoveryEventIds
          if (controlledProfile) {
            const recordedCut = prefix(recorded, cut.prefixThroughLine)
            assert.equal(Buffer.byteLength(recordedCut), cut.sanitized.bytes)
            assert.equal(createHash("sha256").update(recordedCut).digest("hex"), cut.sanitized.sha256)
            const round = fixtureCase.rounds.find(round => round.round === cut.round)
            const fileSlot = cut.slot === "prior-file" || options.repeatedDual && ["file0", "file1"].includes(cut.slot)
            if ((round && cut.prefixThroughLine >= round.lines.copyStart && cut.prefixThroughLine <= round.lines.S) || fileSlot) {
              const line = source.split("\n")[cut.prefixThroughLine - 1]
              const partial = prefix(source, cut.prefixThroughLine - 1) + line.slice(0, Math.floor(line.length / 2))
              const committed = rawContent
              await appendSource(partial)
              await drain(cut.expected, partial, committed, 1, true)
              testedPartials++
            }
            if (cut.slot === "S") recoveryLines = Array.from({ length: round.lines.S - round.lines.copyStart + 1 }, (_, index) => round.lines.copyStart + index)
            if (fileSlot) recoveryLines = [cut.prefixThroughLine]
            if (options.reversed && cut.slot === "resultA") {
              const line = source.split("\n")[cut.prefixThroughLine - 1]
              const partial = prefix(source, cut.prefixThroughLine - 1) + line.slice(0, Math.floor(line.length / 2))
              const committed = rawContent
              await appendSource(partial)
              const firstResult = fixtureCase.derivedTestCuts.find(value => value.slot === "resultB")
              await drain(firstResult.expected, partial, committed, 1, true)
              testedPartials++
            }
            if (options.repeatedDual && cut.slot === "r1") {
              const line = source.split("\n")[cut.prefixThroughLine - 1]
              const partial = prefix(source, cut.prefixThroughLine - 1) + line.slice(0, Math.floor(line.length / 2))
              const committed = rawContent
              await appendSource(partial)
              const firstResult = fixtureCase.derivedTestCuts.find(value => value.round === cut.round && value.slot === "r0")
              await drain(firstResult.expected, partial, committed, 1, true)
              testedPartials++
            }
            if (options.repeatedDual && ["r0", "r1"].includes(cut.slot)) {
              recoveryLines = [cut.prefixThroughLine]
              recoveryEventIds = [JSON.parse(source.split("\n")[cut.prefixThroughLine - 1]).uuid + ":0"]
            }
            if (options.reversed && ["resultB", "resultA"].includes(cut.slot)) {
              recoveryLines = [cut.prefixThroughLine]
              recoveryEventIds = [JSON.parse(source.split("\n")[cut.prefixThroughLine - 1]).uuid + ":0"]
            }
          }
          await appendSource(cutSource)
          if (options.reversed && cut.slot === "resultB") await firstReverseCapacity(cutSource, source, cut.prefixThroughLine)
          if (controlledProfile && recoveryLines && !recoveryEventIds) await freshRawCapacity(cutSource)
          if (options.repeatedDual && ["file0", "file1"].includes(cut.slot)) await fileWitnessCapacity(cutSource, cut.prefixThroughLine)
          await drain(cut.expected, cutSource, prefix(source, cut.parserAndRawCommitThroughLine),
            cut.expected.pendingCanonicalSessions, cut.incompleteAtomicReplayGroup, recoveryLines, recoveryEventIds)
          testedCuts++
        }
        await appendSource(source)
        await drain(snapshot.expected, source, source, 0)
      }
      for (const receipt of fixtureCase.callReceiptEvidence) {
        const call = events.find(event => event.sourceEventId === `${receipt.callUuid}:0`)
        const result = events.find(event => event.sourceEventId === `${receipt.resultUuid}:0`)
        assert.equal(call.update.sessionUpdate, "tool_call")
        assert.equal(call.update.toolCallId, receipt.call.id)
        assert.deepEqual(call.update.rawInput, JSON.parse(relocate(JSON.stringify(receipt.call.input))))
        assert.equal(result.update.sessionUpdate, "tool_call_update")
        assert.equal(result.update.toolCallId, receipt.call.id)
        assert.equal(result.update.status, "completed")
        assert.equal(result.update.rawOutput, receipt.sourceResultBlock.content)
      }
      const controls = controlledProfile ? fixtureCase.rounds.flatMap(round => [round.boundary.uuid, round.summary.uuid])
        : [fixtureCase.boundary.uuid, fixtureCase.summary.uuid]
      for (const uuid of controls) {
        assert.ok(!events.some(event => event.sourceEventId.startsWith(`${uuid}:`)))
      }
      if (options.repeated) {
        const relation = fixtureCase.priorFileReinjection
        const records = previousSource.trimEnd().split("\n").map(line => JSON.parse(line))
        assert.deepEqual(records[relation.line - 1].attachment.content, records[relation.earlierResultLine - 1].toolUseResult)
        assert.ok(!events.some(event => event.sourceEventId.startsWith(`${relation.uuid}:`)))
        for (const marker of fixtureCase.summarizationUsageLimit.knownSummaryMarkers) {
          assert.ok(rawContent.includes(marker))
          assert.ok(!JSON.stringify([events, [...usage.values()]]).includes(marker))
        }
        for (const apiId of fixtureCase.summarizationUsageLimit.missingSummaryApiIds) assert.ok(!usage.has(apiId))
        assert.equal(testedCuts, 36)
        assert.equal(testedPartials, 17)
        assert.equal(receiptRecoveries, 17)
        assert.equal(capacityCases, 12)
        process.stdout.write("Verified native repeated automatic Read: 5 snapshots, 36 LF cuts, 17 partial slots, 17 advanced Raw receipts, 12 fresh capacity cases; 18 Events, 7 API usage IDs, 380163/117 tokens\n")
      }
      if (options.repeatedDual) {
        const records = previousSource.trimEnd().split("\n").map(JSON.parse)
        for (const relation of fixtureCase.priorFileReinjection) {
          assert.deepEqual(records[relation.line - 1].attachment.content, records[relation.earlierResultLine - 1].toolUseResult)
          assert.ok(!events.some(event => event.sourceEventId.startsWith(`${relation.uuid}:`)))
        }
        for (const round of fixtureCase.rounds) {
          const text = records[round.lines.S - 1].message.content
          assert.ok(rawContent.includes(JSON.stringify(text).slice(1, -1)))
          assert.ok(!JSON.stringify([events, [...usage.values()]]).includes(JSON.stringify(text).slice(1, -1)))
        }
        for (const apiId of fixtureCase.summarizationUsageLimit.missingSourceApiIds) assert.ok(!usage.has(apiId))
        await verifyRawPolicy(previousSource)
        assert.deepEqual(fixtureCase.derivedTestCuts.filter(cut => cut.round === 2).map(cut => cut.prefixThroughLine),
          Array.from({ length: 23 }, (_, index) => 52 + index))
        assert.equal(testedCuts, fixtureCase.derivedTestCuts.length)
        assert.equal(testedPartials, 13)
        assert.equal(receiptRecoveries, 14)
        assert.equal(capacityCases, 20)
        process.stdout.write(`Verified native repeated planned Read pair: ${fixtureCase.nativeSnapshots.length} snapshots, ${testedCuts} LF cuts, 13 partial slots, 14 advanced Raw receipts, 20 capacity cases, Raw off/on backfill; ${events.length} Events, ${usage.size} API usage IDs, ${[...usage.values()].reduce((sum, sample) => sum + sample.inputTokens, 0)}/${[...usage.values()].reduce((sum, sample) => sum + sample.outputTokens, 0)} tokens\n`)
      }
      if (options.reversed) {
        for (const marker of fixtureCase.summarizationUsageLimit.knownSummaryMarkers) {
          assert.ok(rawContent.includes(marker))
          assert.ok(!JSON.stringify([events, [...usage.values()]]).includes(marker))
        }
        for (const apiId of fixtureCase.summarizationUsageLimit.missingSummaryApiIds) assert.ok(!usage.has(apiId))
        assert.equal(testedCuts, 23)
        assert.equal(testedPartials, 11)
        assert.equal(receiptRecoveries, 12)
        assert.equal(capacityCases, 14)
        process.stdout.write("Verified native reversed planned Read pair and first automatic replay: 4 snapshots, 23 LF cuts, 11 partial slots, 12 advanced Raw receipts, 14 capacity cases; 14 Events, 5 API usage IDs, 190122/77 tokens\n")
      }
    }
  } finally { process.env.ATAPE_CLAUDE_HOME = sourceHome }
}

async function verifyClaudeManualReadReinjection(adapter, context, limits, options = {}) {
  const fixtureDirectory = join(packageRoot, "fixtures", options.fixtureName ?? "native-manual-read-reinjection-2.1.263")
  const provenance = JSON.parse(await readFile(join(fixtureDirectory, "provenance.json"), "utf8"))
  const { sessionId, fixtureCwd } = provenance
  const selectedHome = join(temporaryRoot, options.homeName ?? "manual-read-reinjection")
  const directory = join(selectedHome, "projects", "fixture"), sourceFile = join(directory, `${sessionId}.jsonl`)
  await mkdir(directory, { recursive: true })
  process.env.ATAPE_CLAUDE_HOME = selectedHome
  const relocate = source => source.replaceAll(JSON.stringify(fixtureCwd).slice(1, -1),
    JSON.stringify(projectDirectory).slice(1, -1))
  const prefix = (source, line) => source.split("\n").slice(0, line).join("\n") + "\n"
  const digest = source => createHash("sha256").update(source).digest("hex")
  const fileLines = provenance.fileReinjection.map(file => file.line)
  const stdoutLine = fileLines[0] - 1
  const { metaLine, syntheticLine } = provenance.firstResumeBridge
  const bookkeepingLine = metaLine - 1
  assert.equal(fileLines[1], fileLines[0] + 1)
  assert.equal(syntheticLine, metaLine + 1)
  if (provenance.selectedSourceRequests) {
    const recorded = await readFile(join(fixtureDirectory, provenance.selectedSourceRequests.file))
    assert.equal(recorded.byteLength, provenance.selectedSourceRequests.bytes)
    assert.equal(digest(recorded), provenance.selectedSourceRequests.sha256)
  }
  const pagedLimits = { ...limits, eventsPerObservation: 1 }
  let cursor = null, previousSource = "", rawContent = "", sourceObjectId, sourceGeneration
  let testedCuts = 0, testedPartials = 0, receiptRecoveries = 0, capacityCases = 0
  const rawProgress = new Map(), events = [], usage = new Map()
  const collect = () => collectInstalled(adapter, context, cursor, [...rawProgress.values()], pagedLimits)
  const appendSource = async source => {
    assert.ok(source.startsWith(previousSource), "Manual reinjection must retain the entire native prefix")
    if (!previousSource) await writeFile(sourceFile, source)
    else await appendFile(sourceFile, source.slice(previousSource.length))
    previousSource = source
  }
  const assertTotals = (expected, committedSource) => {
    assert.equal(events.length, expected.uniqueRealEventCount)
    assert.equal(usage.size, expected.distinctPersistedRealApiUsageCount)
    assert.equal([...usage.values()].reduce((sum, sample) => sum + sample.inputTokens, 0), expected.inputTokens)
    assert.equal([...usage.values()].reduce((sum, sample) => sum + sample.outputTokens, 0), expected.outputTokens)
    assert.deepEqual(events.map(event => event.sourceEventId),
      provenance.logicalRealEventSourceIdsAtFinalSnapshot.slice(0, expected.uniqueRealEventCount))
    const committedLines = committedSource.split("\n").length - 1
    const expectedUsage = Object.entries(provenance.persistedRealApiUsageAtFinalSnapshot)
      .filter(([, value]) => value.line <= committedLines)
    assert.deepEqual([...usage.keys()].sort(), expectedUsage.map(([id]) => id).sort())
    for (const [apiId, value] of expectedUsage) {
      const sample = usage.get(apiId)
      assert.equal(sample.model, value.model)
      assert.equal(sample.inputTokens, value.inputTokens)
      assert.equal(sample.outputTokens, value.outputTokens)
      assert.equal(sample.revision, Buffer.byteLength(prefix(committedSource, value.line)),
        "Internal files/Meta/bridge must not change a real API's latest source revision")
    }
  }
  const recoverAdvancedRawReceipts = async (page, source, groupLines) => {
    assert.ok(page.observations.every(observation => observation.events.length === 0 && observation.usage.length === 0))
    const offered = page.observations.flatMap(observation => observation.rawSegments)
    assert.ok(offered.length > 0, "A proved group must offer eligible source bytes before parser ACK")
    assert.equal(offered[0].sourceOffset, Buffer.byteLength(rawContent))
    const eligibleEnd = offered.at(-1).sourceOffset + Buffer.byteLength(offered.at(-1).content)
    let offeredOffset = offered[0].sourceOffset
    for (const raw of offered) {
      assert.equal(raw.sourceOffset, offeredOffset)
      assert.equal(raw.content, Buffer.from(source).subarray(offeredOffset,
        offeredOffset + Buffer.byteLength(raw.content)).toString("utf8"))
      offeredOffset += Buffer.byteLength(raw.content)
    }
    for (const line of groupLines) {
      const start = Buffer.byteLength(prefix(source, line - 1))
      const offset = start + 32
      assert.ok(offset > Buffer.byteLength(rawContent) && offset < eligibleEnd)
      const receipt = { sourceSessionId: sessionId, sourceObjectId, sourceGeneration,
        sourceOffset: offset, finalized: false }
      let recoveredCursor = cursor, recoveredContent = Buffer.from(source).subarray(0, offset).toString("utf8")
      let recoveredReceipt = receipt, finished = false
      for (let index = 0; index < limits.pagesPerCycle; index++) {
        // Raw uploads can be durable before the Host commits the returned parser checkpoint.
        const request = () => collectInstalled(adapter, context, recoveredCursor, [recoveredReceipt], pagedLimits)
        const recovered = await request()
        assert.deepEqual(await request(), recovered, "Old parser plus advanced Raw receipt must retry exactly after reopening")
        assert.equal(recovered.sourceFailures, undefined)
        for (const observation of recovered.observations) {
          assert.deepEqual(observation.events, [])
          assert.deepEqual(observation.usage, [])
          for (const raw of observation.rawSegments) {
            assert.equal(raw.sourceObjectId, sourceObjectId)
            assert.equal(raw.sourceGeneration, sourceGeneration)
            assert.equal(raw.sourceOffset, Buffer.byteLength(recoveredContent))
            recoveredContent += raw.content
            recoveredReceipt = { ...receipt, sourceOffset: Buffer.byteLength(recoveredContent), finalized: raw.final }
          }
        }
        recoveredCursor = recovered.nextCursor
        if (!recovered.hasMore) { finished = true; break }
      }
      assert.ok(finished, "Advanced group receipt recovery must finish within its page budget")
      assert.equal(recoveredContent, source)
      const idle = await collectInstalled(adapter, context, recoveredCursor, [recoveredReceipt], pagedLimits)
      assert.deepEqual(idle.observations, [])
      assert.equal(idle.nextCursor, recoveredCursor)
      assert.equal(idle.hasMore, false)
      assert.equal(idle.sourceFailures, undefined)
      assert.equal(idle.progress.pendingCanonicalSessions, 0)
      assert.equal(idle.progress.pendingRawBytes, 0)
      receiptRecoveries++
    }
  }
  const drain = async (expected, source, committedSource, pending, incompleteGroup = false, recoveryLines) => {
    const beforeCursor = cursor, beforeEvents = [...events], beforeUsage = [...usage]
    let finished = false
    for (let index = 0; index < limits.pagesPerCycle; index++) {
      const page = await collect()
      assert.deepEqual(await collect(), page, "Manual reinjection retry must be identical in a new installed runtime")
      assert.equal(page.sourceFailures, undefined)
      assert.equal(typeof page.nextCursor, "string")
      if (incompleteGroup) assert.deepEqual(page.observations, [], "An incomplete file/Meta group cannot acknowledge unproved bytes")
      if (recoveryLines && index === 0) await recoverAdvancedRawReceipts(page, source, recoveryLines)
      for (const observation of page.observations) {
        assert.equal(observation.session.sourceSessionId, sessionId)
        assert.deepEqual(observation.threads.map(thread => thread.sourceThreadId), ["root"])
        assert.ok(observation.events.length <= 1)
        assert.ok(Buffer.byteLength(JSON.stringify({ ...observation, rawSegments: [] })) <= limits.canonicalBytesPerObservation)
        for (const event of observation.events) {
          assert.equal(event.sourceThreadId, "root")
          assert.ok(!events.some(previous => previous.sourceEventId === event.sourceEventId), "Internal context cannot replay acknowledged Events")
          events.push(event)
        }
        for (const sample of observation.usage) {
          assert.equal(sample.sourceThreadId, "root")
          assert.notEqual(sample.model, "<synthetic>")
          const previous = usage.get(sample.sourceUsageId)
          assert.ok(!previous || sample.revision > previous.revision)
          usage.set(sample.sourceUsageId, sample)
        }
        for (const raw of observation.rawSegments) {
          sourceObjectId ??= raw.sourceObjectId
          sourceGeneration ??= raw.sourceGeneration
          assert.equal(raw.sourceObjectId, sourceObjectId)
          assert.equal(raw.sourceGeneration, sourceGeneration)
          assert.equal(raw.sourceOffset, Buffer.byteLength(rawContent))
          rawContent += raw.content
          rawProgress.set(raw.sourceObjectId, { sourceSessionId: sessionId, sourceObjectId: raw.sourceObjectId,
            sourceGeneration: raw.sourceGeneration, sourceOffset: Buffer.byteLength(rawContent), finalized: raw.final })
        }
      }
      cursor = page.nextCursor
      if (!page.hasMore) { finished = true; break }
    }
    assert.ok(finished, "Installed manual reinjection did not finish within its page budget")
    assert.deepEqual(events.slice(0, beforeEvents.length), beforeEvents)
    if (incompleteGroup) {
      assert.equal(cursor, beforeCursor)
      assert.deepEqual([...usage], beforeUsage)
    }
    assertTotals(expected, committedSource)
    assert.equal(rawContent, committedSource)
    assert.ok(events.every(event => event.rawRef.sourceObjectId === sourceObjectId))
    const idle = await collect()
    assert.deepEqual(await collect(), idle)
    assert.deepEqual(idle.observations, [])
    assert.equal(idle.nextCursor, cursor)
    assert.equal(idle.hasMore, false)
    assert.equal(idle.sourceFailures, undefined)
    assert.equal(idle.progress.pendingCanonicalSessions, pending)
    assert.equal(idle.progress.pendingRawBytes, Buffer.byteLength(source) - Buffer.byteLength(committedSource))
  }
  const partialSlot = async (source, line, expected, committedLine) => {
    const record = source.split("\n")[line - 1]
    const partial = prefix(source, line - 1) + record.slice(0, Math.floor(record.length / 2))
    await appendSource(partial)
    await drain(expected, partial, prefix(source, committedLine), 1, true)
    testedPartials++
  }
  const freshGroupCapacity = async source => {
    const bytes = Buffer.byteLength(prefix(source, fileLines[1])) - Buffer.byteLength(prefix(source, stdoutLine))
    const inputReceipts = [...rawProgress.values()]
    const durableInput = JSON.stringify({ cursor, inputReceipts })
    const selectedFile = process.env.ATAPE_CLAUDE_SESSION_FILE
    process.env.ATAPE_CLAUDE_SESSION_FILE = sourceFile
    try { for (const enabled of [false, true]) {
      const requested = { ...pagedLimits, rawSegmentBytes: bytes - 1, rawBytesPerObservation: bytes - 1 }
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(() => collectInstalled(adapter, context, cursor, inputReceipts, requested, enabled),
          error => error.reason === "limit")
      }
      const exact = { ...requested, rawSegmentBytes: bytes, rawBytesPerObservation: bytes }
      const page = await collectInstalled(adapter, context, cursor, inputReceipts, exact, enabled)
      assert.deepEqual(await collectInstalled(adapter, context, cursor, inputReceipts, exact, enabled), page)
      assert.equal(page.sourceFailures, undefined)
      assert.notEqual(page.nextCursor, cursor)
      assert.equal(page.hasMore, false)
      assert.ok(page.observations.every(observation => observation.events.length === 0 && observation.usage.length === 0))
      assert.equal(page.observations.flatMap(observation => observation.rawSegments).map(raw => raw.content).join(""),
        enabled ? source.slice(prefix(source, stdoutLine).length) : "")
      assert.equal(JSON.stringify({ cursor, inputReceipts }), durableInput)
      capacityCases += 2
    } } finally {
      if (selectedFile === undefined) delete process.env.ATAPE_CLAUDE_SESSION_FILE
      else process.env.ATAPE_CLAUDE_SESSION_FILE = selectedFile
    }
  }
  try {
    for (const snapshot of provenance.nativeSnapshots) {
      const recorded = await readFile(join(fixtureDirectory, snapshot.file), "utf8")
      assert.equal(Buffer.byteLength(recorded), snapshot.bytes)
      assert.equal(digest(recorded), snapshot.sha256)
      const source = relocate(recorded)
      for (const cut of provenance.derivedCuts.filter(cut => cut.sourcePhase === snapshot.phase)) {
        const recordedCut = prefix(recorded, cut.throughLine)
        assert.equal(Buffer.byteLength(recordedCut), cut.bytes)
        assert.equal(digest(recordedCut), cut.sha256)
        if (cut.label === "fileB" || cut.label === "fileA") {
          await partialSlot(source, cut.throughLine, cut.expectedLogicalData, stdoutLine)
        }
        if (cut.label === "meta-continue") {
          // UUID-less native queues are committed before the next atomic group.
          const queues = prefix(source, bookkeepingLine)
          await appendSource(queues)
          await drain(cut.expectedLogicalData, queues, queues, 0)
          await partialSlot(source, metaLine, cut.expectedLogicalData, bookkeepingLine)
        }
        if (cut.label === "synthetic-bridge") await partialSlot(source, syntheticLine, cut.expectedLogicalData, bookkeepingLine)
        const cutSource = prefix(source, cut.throughLine)
        const incomplete = cut.label === "fileB" || cut.label === "meta-continue"
        const committed = prefix(source, cut.label === "fileB" ? stdoutLine : cut.label === "meta-continue" ? bookkeepingLine : cut.throughLine)
        const pending = ["B", "S", "caveat", "command", "fileB", "meta-continue"].includes(cut.label) ? 1 : 0
        await appendSource(cutSource)
        // Capacity is measured at this group's EOF; later groups use their own
        // default capacity rather than a path-length-dependent earlier budget.
        if (options.omitToolOutput && cut.label === "fileA") await freshGroupCapacity(cutSource)
        await drain(cut.expectedLogicalData, cutSource, committed, pending, incomplete,
          cut.label === "fileA" ? fileLines : cut.label === "synthetic-bridge" ? [metaLine, syntheticLine] : undefined)
        testedCuts++
      }
      await appendSource(source)
      await drain(snapshot.expectedLogicalData, source, source, 0)
    }
    const finalRecords = previousSource.trimEnd().split("\n").map(line => JSON.parse(line))
    for (const relation of provenance.fileReinjection) {
      const callRecord = finalRecords.find(record => record.uuid === relation.earlierOwnCallUuid)
      const resultRecord = finalRecords.find(record => record.uuid === relation.earlierResultUuid)
      const call = events.find(event => event.sourceEventId === `${callRecord.uuid}:0`)
      const result = events.find(event => event.sourceEventId === `${resultRecord.uuid}:0`)
      assert.equal(call.update.sessionUpdate, "tool_call")
      assert.equal(call.update.toolCallId, callRecord.message.content[0].id)
      assert.deepEqual(call.update.rawInput, callRecord.message.content[0].input)
      assert.equal(result.update.sessionUpdate, "tool_call_update")
      assert.equal(result.update.toolCallId, call.update.toolCallId)
      assert.equal(result.update.status, "completed")
      if (options.omitToolOutput) {
        assert.ok(Buffer.byteLength(JSON.stringify(resultRecord.message.content[0].content)) > 64 * 1024)
        assert.equal(Object.hasOwn(result.update, "rawOutput"), false)
        assert.equal(result.fidelity, "partial")
      } else assert.equal(result.update.rawOutput, resultRecord.message.content[0].content)
      assert.deepEqual(finalRecords[relation.line - 1].attachment.content, resultRecord.toolUseResult)
      assert.ok(!events.some(event => event.sourceEventId.startsWith(`${relation.uuid}:`)))
    }
    for (const marker of [options.summaryMarker ?? "ATAPE_MANUAL_SUMMARY", "<command-name>/compact", "Continue from where you left off.", "No response requested."]) {
      assert.ok(rawContent.includes(marker))
      assert.ok(!JSON.stringify([events, [...usage.values()]]).includes(marker), `${marker} must remain internal Raw context`)
    }
    assert.ok(!usage.has(options.missingSummaryUsageId ?? "msg_atape_manual_mock_5"))
    assert.ok(!usage.has(provenance.firstResumeBridge.syntheticMessageId))
    assert.equal(testedCuts, 13)
    assert.equal(testedPartials, 4)
    assert.equal(receiptRecoveries, 4)
    assert.equal(events.length, 16)
    assert.equal(usage.size, 6)
    assert.equal(capacityCases, options.omitToolOutput ? 4 : 0)
    process.stdout.write("Verified native " + (options.omitToolOutput ? "large " : "") +
      "manual Read reinjection: 6 snapshots, 13 cuts, 4 partial slots, 4 advanced Raw receipts; 16 Events, 6 API usage IDs, 188/90 tokens" +
      (options.omitToolOutput ? "; omitted large tool details and 4 fresh capacity cases" : "") + "\n")
  } finally { process.env.ATAPE_CLAUDE_HOME = sourceHome }
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
