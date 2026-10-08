import assert from "node:assert/strict"
import { execFile } from "node:child_process"
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

async function collectInstalled(adapter, context, cursor, rawProgress, limits) {
  // Reopen the installed artifact for every page, using only durable Host state.
  const runtime = await adapter.createAtapeAdapter({ ...context, signal: AbortSignal.timeout(5_000) })
  try {
    return await runtime.collect({ protocolVersion: context.protocolVersion, cursor, limits,
      rawProgress, signal: AbortSignal.timeout(5_000) })
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

async function verifyClaudeAutomaticReadReplay(adapter, context, limits) {
  const fixtureDirectory = join(packageRoot, "fixtures", "native-auto-read-replay-2.1.263")
  const provenance = JSON.parse(await readFile(join(fixtureDirectory, "provenance.json"), "utf8"))
  const relocate = source => source.replaceAll(JSON.stringify(provenance.fixtureCwd).slice(1, -1),
    JSON.stringify(projectDirectory).slice(1, -1))
  const prefix = (source, line) => source.split("\n").slice(0, line).join("\n") + "\n"
  const pagedLimits = { ...limits, eventsPerObservation: 1 }
  try {
    for (const fixtureCase of provenance.cases) {
      const selectedHome = join(temporaryRoot, `automatic-read-${fixtureCase.profile}`)
      const directory = join(selectedHome, "projects", "fixture")
      await mkdir(directory, { recursive: true })
      process.env.ATAPE_CLAUDE_HOME = selectedHome
      const sourceFile = join(directory, `${fixtureCase.sessionId}.jsonl`)
      let cursor = null, previousSource = "", rawContent = "", sourceObjectId, sourceGeneration
      const rawProgress = new Map(), events = [], usage = new Map()
      const collect = () => collectInstalled(adapter, context, cursor, [...rawProgress.values()], pagedLimits)
      const appendSource = async source => {
        assert.ok(source.startsWith(previousSource), "Automatic Read replay must retain its native source prefix")
        if (!previousSource) await writeFile(sourceFile, source)
        else await appendFile(sourceFile, source.slice(previousSource.length))
        previousSource = source
      }
      const drain = async (expected, source, committedSource, pending, incompleteGroup = false) => {
        const previousCursor = cursor, previousEvents = [...events], previousUsage = [...usage]
        let finished = false
        for (let index = 0; index < limits.pagesPerCycle; index++) {
          const page = await collect()
          assert.deepEqual(await collect(), page, "Automatic Read replay retry must be identical in a new installed runtime")
          assert.equal(page.sourceFailures, undefined)
          assert.equal(typeof page.nextCursor, "string")
          if (incompleteGroup) assert.deepEqual(page.observations, [], "Unproved copies/B must not advance Canonical or Raw")
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
        if (expected.usageSourceIds) for (const apiId of expected.usageSourceIds) {
          const value = fixtureCase.latestUsageByApiId[apiId]
          const sample = usage.get(apiId)
          assert.equal(sample.model, value.model)
          assert.equal(sample.inputTokens, value.inputTokens)
          assert.equal(sample.outputTokens, value.outputTokens)
          assert.equal(sample.revision, Buffer.byteLength(prefix(source, value.latestObservationLine)), "Raw-only copied usage must not advance its source revision")
        }
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
        const source = relocate(await readFile(join(fixtureDirectory, snapshot.file), "utf8"))
        for (const cut of fixtureCase.derivedTestCuts.filter(cut => cut.nativeParentSnapshot === snapshot.file)) {
          const cutSource = prefix(source, cut.prefixThroughLine)
          await appendSource(cutSource)
          await drain(cut.expected, cutSource, prefix(source, cut.parserAndRawCommitThroughLine),
            cut.expected.pendingCanonicalSessions, cut.incompleteAtomicReplayGroup)
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
      for (const uuid of [fixtureCase.boundary.uuid, fixtureCase.summary.uuid]) {
        assert.ok(!events.some(event => event.sourceEventId.startsWith(`${uuid}:`)))
      }
    }
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
