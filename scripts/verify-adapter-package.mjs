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
