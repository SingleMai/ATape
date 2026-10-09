import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

/** Installed factory acceptance. This observes only the shipped sourceCapture
 * Interface; historical collect acceptance uses a separately frozen artifact. */
export async function verifyClaudePackage(adapter, context, paths) {
  const { packageRoot, sourceHome, projectDirectory, temporaryRoot } = paths
  const limits = { rowBytes: 16 * 1024 * 1024, pageBytes: 32 * 1024 * 1024, pageRows: 100, records: 100_000, threads: 100, durationMs: 60_000 }
  const projection = { events: 100_000, usage: 100_000, pageItems: 1, pageBytes: 32 * 1024 * 1024 }
  const jsonl = rows => rows.map(row => JSON.stringify(row) + "\n").join("")
  const parse = source => source.trimEnd().split("\n").filter(Boolean).map(line => JSON.parse(line))
  const relocate = (source, cwd) => source.replaceAll(JSON.stringify(cwd).slice(1, -1), JSON.stringify(projectDirectory).slice(1, -1))
  const rawText = (captured, thread = "root") => captured.frames.flatMap(frame => frame.raw?.format === "claude.jsonl.v1" && frame.raw.sourceThreadId === thread ? [frame.raw.jsonl] : []).join("")
  const capture = async (sourceId, options = {}) => {
    const runtime = await adapter.createAtapeAdapter({ ...context, signal: AbortSignal.timeout(60_000) })
    assert.equal("collect" in runtime, false, "Current Claude package must expose only sourceCapture")
    assert.equal(runtime.sourceCapture.protocolVersion, "atape.source-capture.v2")
    assert.equal(typeof runtime.sourceCapture.legacyMigration, "function")
    try {
      const request = { sourceId, rawEnabled: true, limits, projection, priorThreads: [], ...options, signal: AbortSignal.timeout(60_000) }
      const view = await runtime.sourceCapture.open(request)
      try {
        const header = JSON.parse(JSON.stringify(view)), frames = [], keys = new Set(), offsets = new Map()
        assert.equal(header.origin.sourceId, sourceId); assert.equal(header.session.sourceSessionId, sourceId)
        assert.equal(typeof header.sourceCheckpoint, "string"); assert.ok(Buffer.byteLength(header.sourceCheckpoint) <= 1024 * 1024)
        assert.ok(Array.isArray(header.target.retainedThreadIds)); assert.ok(Array.isArray(header.sourceFailures))
        assert.equal(typeof header.sourceFailuresTruncated, "boolean"); assert.ok(header.sourceFailures.length <= 32)
        for (let n = 0; n < 100_000; n++) {
          const page = await view.read(request.signal)
          assert.ok(Buffer.byteLength(JSON.stringify(page)) <= projection.pageBytes)
          assert.ok(page.frames.length <= projection.pageItems); assert.ok(page.done || page.frames.length > 0)
          for (const frame of page.frames) {
            assert.ok(!keys.has(frame.recordKey)); keys.add(frame.recordKey)
            assert.ok(frame.events.length <= 500); assert.ok(frame.usage.length <= 500)
            if (!request.rawEnabled) assert.equal(frame.raw, undefined)
            else {
              assert.ok(frame.raw)
              if (frame.raw.format === "claude.jsonl.v1") {
                assert.equal(frame.raw.recordStart, offsets.get(frame.raw.sourceThreadId) ?? 0)
                assert.equal(Buffer.byteLength(frame.raw.jsonl), frame.raw.recordEnd - frame.raw.recordStart)
                assert.ok(frame.raw.jsonl.endsWith("\n")); offsets.set(frame.raw.sourceThreadId, frame.raw.recordEnd)
              } else {
                assert.equal(frame.raw.format, "claude.record-reference.v1")
                assert.ok(keys.has(frame.raw.recordKey)); assert.equal(frame.raw.jsonl, undefined)
              }
            }
          }
          frames.push(...page.frames)
          if (!page.done) continue
          const events = frames.flatMap(frame => frame.events), usage = frames.flatMap(frame => frame.usage)
          assert.equal(events.length, header.target.events); assert.equal(usage.length, header.target.usage)
          assert.equal(header.threads.length, header.target.threads); assert.equal(header.session.reportedEventCount, events.length)
          assert.equal(new Set(header.threads.map(thread => thread.sourceThreadId)).size, header.threads.length)
          assert.equal(new Set(events.map(event => JSON.stringify([event.sourceThreadId, event.sourceEventId]))).size, events.length)
          assert.equal(new Set(usage.map(sample => JSON.stringify([sample.sourceThreadId, sample.sourceUsageId]))).size, usage.length)
          for (const [index, event] of events.entries()) {
            assert.equal(event.eventIndex, index); assert.equal(event.sourceOrder, index)
            for (const field of ["revision", "projectionRevision", "rawRef"]) assert.equal(field in event, false)
            if (event.childSourceThreadId !== undefined) assert.ok(header.threads.some(thread => thread.sourceThreadId === event.childSourceThreadId))
          }
          assert.ok(usage.every(sample => sample.model !== "<synthetic>" && !("revision" in sample)))
          return { header, frames, events, usage }
        }
        assert.fail("Installed Claude source view exceeded its page admission")
      } finally { await view.close() }
    } finally { await runtime.close() }
  }
  const withProof = captured => ({ priorThreads: captured.header.threads, priorCheckpoint: captured.header.sourceCheckpoint })
  const fileFor = async name => { const directory = join(temporaryRoot, name); await mkdir(directory, { recursive: true }); return join(directory, "session.jsonl") }
  const selected = file => { process.env.ATAPE_CLAUDE_SESSION_FILE = file }
  const unchanged = (a, b) => { assert.deepEqual(a.events, b.events); assert.deepEqual(a.usage, b.usage) }

  const runtime = await adapter.createAtapeAdapter({ ...context, signal: AbortSignal.timeout(60_000) })
  try {
    assert.equal("collect" in runtime, false); assert.equal(runtime.sourceCapture.protocolVersion, "atape.source-capture.v2")
    assert.deepEqual(await runtime.sourceCapture.discover({ cursor: null, limits, signal: AbortSignal.timeout(60_000) }), {
      sources: [], cursor: null, done: true, sourceFailures: [], sourceFailuresTruncated: false
    })
  } finally { await runtime.close() }

  const family = async fixtureName => {
    const folder = join(packageRoot, "fixtures", fixtureName), metadata = JSON.parse(await readFile(join(folder, "provenance.json"), "utf8"))
    const directory = join(temporaryRoot, fixtureName), rootFile = join(directory, `${metadata.sessionId}.jsonl`)
    const childFile = join(directory, metadata.sessionId, "subagents", `agent-${metadata.agentId}.jsonl`)
    const root = relocate(await readFile(join(folder, `${metadata.sessionId}.jsonl`), "utf8"), metadata.fixtureCwd)
    const child = relocate(await readFile(join(folder, metadata.sessionId, "subagents", `agent-${metadata.agentId}.jsonl`), "utf8"), metadata.fixtureCwd)
    await mkdir(dirname(childFile), { recursive: true }); await writeFile(rootFile, root); await writeFile(childFile, child)
    return { metadata, rootFile, childFile, root, child, childId: `claude-agent:${metadata.agentId}` }
  }
  for (const name of ["native-foreground-child-2.1.263", "native-thinking-2.1.263"]) {
    const f = await family(name); selected(f.rootFile)
    const actual = await capture(f.metadata.sessionId), thoughts = actual.events.filter(event => event.update.sessionUpdate === "agent_thought_chunk")
    assert.equal(actual.events.length, 8 + (f.metadata.thoughts?.length ?? 0)); assert.equal(actual.usage.length, 4)
    assert.deepEqual(actual.header.threads.map(thread => thread.sourceThreadId).sort(), ["root", f.childId].sort())
    assert.deepEqual(actual.header.sourceFailures, []); assert.deepEqual(actual.header.target.retainedThreadIds, [])
    assert.equal(actual.events.filter(event => event.childSourceThreadId === f.childId).length, 1)
    assert.equal(thoughts.length, f.metadata.thoughts?.length ?? 0)
    for (const expected of f.metadata.thoughts ?? []) {
      const event = thoughts.find(event => event.sourceEventId === `${expected.uuid}:${expected.block}`)
      assert.equal(event?.update.content.text, expected.body); assert.equal(event.update.messageId, `${expected.uuid}:${expected.block}`)
      assert.ok(!JSON.stringify(actual.events).includes(expected.signature))
    }
    for (const id of ["root", f.childId]) {
      const usage = actual.usage.filter(sample => sample.sourceThreadId === id)
      assert.equal(usage.reduce((sum, sample) => sum + sample.inputTokens, 0), 34)
      assert.equal(usage.reduce((sum, sample) => sum + sample.outputTokens, 0), 18)
    }
    assert.equal(rawText(actual), f.root); assert.equal(rawText(actual, f.childId), f.child)
    assert.deepEqual(await capture(f.metadata.sessionId), actual, `${name}: cold exact retry`)
    const off = await capture(f.metadata.sessionId, { rawEnabled: false }), backfill = await capture(f.metadata.sessionId, withProof(off))
    unchanged(off, backfill); assert.equal(rawText(backfill), f.root); assert.equal(rawText(backfill, f.childId), f.child)
    await rm(f.childFile)
    const retained = await capture(f.metadata.sessionId, withProof(actual))
    assert.deepEqual(retained.header.target.retainedThreadIds, [f.childId]); assert.ok(retained.events.every(event => event.sourceThreadId === "root"))
    assert.deepEqual(retained.header.sourceFailures, [{ source: f.childFile, reason: "io" }])
    const firstMissing = await capture(f.metadata.sessionId)
    assert.deepEqual(firstMissing.header.threads.map(thread => thread.sourceThreadId), ["root"])
    assert.ok(firstMissing.events.every(event => event.childSourceThreadId === undefined)); assert.equal(firstMissing.header.sourceFailures[0]?.reason, "io")
    await writeFile(f.childFile, f.child)
    const root = parse(f.root).find(row => row.uuid)
    await appendFile(f.rootFile, jsonl([{ type: "last-prompt", sessionId: f.metadata.sessionId, leafUuid: root.uuid, explicit: true, rewound: true }]))
    const removedOff = await capture(f.metadata.sessionId, { ...withProof(actual), rawEnabled: false })
    const removed = await capture(f.metadata.sessionId, withProof(removedOff))
    unchanged(removedOff, removed); assert.deepEqual(removed.header.threads.map(thread => thread.sourceThreadId), ["root"])
    assert.equal(rawText(removed, f.childId), f.child, "Abandoned proved child remains eligible for Raw backfill")
  }

  const backgroundFolder = join(packageRoot, "fixtures/native-background-child-2.1.263")
  const backgroundProof = JSON.parse(await readFile(join(backgroundFolder, "provenance.json"), "utf8"))
  const backgroundSource = async file => {
    const source = await readFile(join(backgroundFolder, file), "utf8"), proof = backgroundProof.sources[file].sanitized
    assert.equal(Buffer.byteLength(source), proof.bytes); assert.equal(createHash("sha256").update(source).digest("hex"), proof.sha256)
    assert.ok(source.endsWith("\n")); assert.equal(source.split("\n").length - 1, proof.completeLFLines)
    for (const row of parse(source)) if (row.cwd !== undefined) assert.equal(row.cwd, backgroundProof.fixtureCwd)
    return relocate(source, backgroundProof.fixtureCwd)
  }
  const backgroundRoot = await backgroundSource("root.jsonl"), backgroundChild = await backgroundSource("child.jsonl")
  const prefix = (source, lines) => source.split("\n").slice(0, lines).join("\n") + "\n"
  const backgroundFile = await fileFor("native-background-lifecycle")
  const backgroundChildFile = join(dirname(backgroundFile), backgroundProof.sessionId, "subagents", `agent-${backgroundProof.agentId}.jsonl`)
  const backgroundThread = `claude-agent:${backgroundProof.agentId}`
  const backgroundRootRows = parse(backgroundRoot), backgroundChildRows = parse(backgroundChild)
  const backgroundIds = (rows, lines) => lines.map(line => `${rows[line - 1].uuid}:0`)
  const assertBackground = (actual, rootLines, childLines, apiIds) => {
    assert.deepEqual(actual.header.sourceFailures, []); assert.deepEqual(actual.header.target.retainedThreadIds, [])
    assert.deepEqual(actual.events.map(event => event.sourceEventId), [
      ...backgroundIds(backgroundRootRows, rootLines), ...backgroundIds(backgroundChildRows, childLines)
    ])
    assert.deepEqual(actual.usage.map(sample => sample.sourceUsageId).sort(), apiIds.map(id => `msg_atape_bg_90fceeec_${id}`).sort())
    assert.ok(actual.usage.every(sample => sample.inputTokens === 31 && sample.outputTokens === 17))
    const links = actual.events.filter(event => event.childSourceThreadId)
    assert.equal(links.length, 1); assert.equal(links[0].sourceEventId, `${backgroundProof.call.receiptUuid}:0`)
    assert.equal(links[0].childSourceThreadId, backgroundThread)
    assert.deepEqual(actual.header.threads.map(thread => thread.sourceThreadId).sort(), ["root", backgroundThread].sort())
    assert.ok(actual.events.every(event => !event.sourceEventId.startsWith(backgroundProof.notification.uuid)), "Completion notification is Raw control, not a User Event")
  }
  await mkdir(dirname(backgroundChildFile), { recursive: true }); selected(backgroundFile)
  await writeFile(backgroundFile, prefix(backgroundRoot, 10)); await writeFile(backgroundChildFile, prefix(backgroundChild, 5))
  const runningBackground = await capture(backgroundProof.sessionId, { rawEnabled: false })
  assertBackground(runningBackground, [3, 7, 8, 10], [1, 2, 3], [2, 4, 3])
  const unchangedRootBytes = await readFile(backgroundFile)
  await writeFile(backgroundChildFile, prefix(backgroundChild, 5) + backgroundChild.split("\n")[5].slice(0, 80))
  assert.deepEqual(await capture(backgroundProof.sessionId, { ...withProof(runningBackground), rawEnabled: false }), runningBackground,
    "Incomplete child LF does not advance usage, Events or physical prefix proof")
  await writeFile(backgroundChildFile, backgroundChild)
  const childOnlyBackground = await capture(backgroundProof.sessionId, { ...withProof(runningBackground), rawEnabled: false })
  assert.deepEqual(await readFile(backgroundFile), unchangedRootBytes)
  assertBackground(childOnlyBackground, [3, 7, 8, 10], [1, 2, 3, 6], [2, 4, 3, 5])
  assert.deepEqual(childOnlyBackground.events.slice(0, 7), runningBackground.events, "Child-only append preserves existing projection anchors")
  await rm(backgroundChildFile); await writeFile(backgroundFile, prefix(backgroundRoot, 18))
  const retainedBackground = await capture(backgroundProof.sessionId, { ...withProof(childOnlyBackground), rawEnabled: false })
  assert.deepEqual(retainedBackground.header.target.retainedThreadIds, [backgroundThread])
  assert.deepEqual(retainedBackground.events.map(event => event.sourceEventId), backgroundIds(backgroundRootRows, [3, 7, 8, 10, 13, 15, 16, 18]))
  assert.deepEqual(retainedBackground.header.sourceFailures, [{ source: backgroundChildFile, reason: "io" }])
  assert.deepEqual(await capture(backgroundProof.sessionId, { ...withProof(retainedBackground), rawEnabled: false }), retainedBackground)
  const neverCapturedBackground = await capture(backgroundProof.sessionId, { rawEnabled: false })
  assert.deepEqual(neverCapturedBackground.header.threads.map(thread => thread.sourceThreadId), ["root"])
  assert.ok(neverCapturedBackground.events.every(event => event.childSourceThreadId === undefined))
  await writeFile(backgroundChildFile, backgroundChild); await writeFile(backgroundFile, backgroundRoot)
  const completedBackground = await capture(backgroundProof.sessionId, { ...withProof(retainedBackground), rawEnabled: false })
  assertBackground(completedBackground, [3, 7, 8, 10, 13, 15, 16, 18, 23, 25, 27], [1, 2, 3, 6], [2, 4, 6, 7, 8, 9, 3, 5])
  const backgroundBackfill = await capture(backgroundProof.sessionId, withProof(completedBackground))
  unchanged(completedBackground, backgroundBackfill)
  assert.equal(rawText(backgroundBackfill), backgroundRoot); assert.equal(rawText(backgroundBackfill, backgroundThread), backgroundChild)
  await appendFile(backgroundFile, jsonl([{ type: "last-prompt", sessionId: backgroundProof.sessionId,
    leafUuid: backgroundRootRows[2].uuid, explicit: true, rewound: true }]))
  const rewoundBackground = await capture(backgroundProof.sessionId, { ...withProof(backgroundBackfill), rawEnabled: false })
  assert.deepEqual(rewoundBackground.events.map(event => event.sourceEventId), backgroundIds(backgroundRootRows, [3]))
  assert.deepEqual(rewoundBackground.header.threads.map(thread => thread.sourceThreadId), ["root"])
  assert.deepEqual(rewoundBackground.usage, []); assert.deepEqual(rewoundBackground.header.target.retainedThreadIds, [])
  const historicalBackground = await capture(backgroundProof.sessionId, withProof(rewoundBackground))
  unchanged(rewoundBackground, historicalBackground)
  assert.equal(rawText(historicalBackground), await readFile(backgroundFile, "utf8"))
  assert.equal(rawText(historicalBackground, backgroundThread), backgroundChild)
  assert.deepEqual(await capture(backgroundProof.sessionId, withProof(historicalBackground)), historicalBackground)

  // Every observed snapshot is independently opened with its actually observed
  // child bytes. Lifecycle prefixes above are explicitly derived test cuts.
  for (const [rootName, childName] of [["observed-running-root.jsonl", "observed-running-child.jsonl"],
    ["observed-completed-root.jsonl", "child.jsonl"]]) {
    const source = await backgroundSource(rootName), child = await backgroundSource(childName)
    await writeFile(backgroundFile, source); await writeFile(backgroundChildFile, child)
    const actual = await capture(backgroundProof.sessionId)
    assert.equal(rawText(actual), source); assert.equal(rawText(actual, backgroundThread), child)
    assert.deepEqual(actual.header.sourceFailures, [])
  }
  for (const mutation of ["foreground-invocation", "missing-async-flag"]) {
    const root = structuredClone(backgroundRootRows)
    if (mutation === "foreground-invocation") root[6].message.content[0].input.run_in_background = false
    else delete root[7].toolUseResult.isAsync
    await writeFile(backgroundFile, jsonl(root)); await writeFile(backgroundChildFile, backgroundChild)
    const actual = await capture(backgroundProof.sessionId)
    assert.deepEqual(actual.header.threads.map(thread => thread.sourceThreadId), ["root"])
    assert.ok(actual.events.every(event => event.childSourceThreadId === undefined))
    assert.deepEqual(actual.header.sourceFailures, [{ source: backgroundFile, reason: "unsupported" }])
    assert.equal(rawText(actual, backgroundThread), "", `${mutation}: no inferred child Raw access`)
  }

  const rewindFolder = join(packageRoot, "fixtures/native-rewind-2.1.263")
  const rewind = JSON.parse(await readFile(join(rewindFolder, "provenance.json"), "utf8"))
  const turns = new Map([
    ["resume-01-first-0.jsonl", [1]], ["resume-02-discarded-0.jsonl", [1, 2]], ["resume-03-rewound-0.jsonl", [1, 3]], ["resume-04-continued-0.jsonl", [1, 3, 4]],
    ["control-01-first.jsonl", [1]], ["control-02-discarded.jsonl", [1, 2]], ["control-03-rewind-only.jsonl", [1]], ["control-04-current.jsonl", [1, 3]], ["control-05-empty-rewind.jsonl", []]
  ])
  for (const mode of ["resume", "control"]) {
    const file = await fileFor(`rewind-${mode}`); selected(file); let prior, previous = ""
    for (const snapshot of rewind.snapshots.filter(snapshot => snapshot.mode === mode)) {
      const source = relocate(await readFile(join(rewindFolder, snapshot.file), "utf8"), rewind.fixtureCwd)
      assert.ok(source.startsWith(previous)); await writeFile(file, source)
      const rows = parse(source), root = rows.find(row => row.uuid), users = rows.filter(row => row.type === "user"), expected = []
      for (const turn of turns.get(snapshot.file)) {
        expected.push(`${users[turn - 1].uuid}:0`)
        for (const row of rows.filter(row => row.type === "assistant" && row.message.id === `msg_atape_thinking_mock_${turn}`)) expected.push(`${row.uuid}:0`)
      }
      const current = await capture(root.sessionId, prior === undefined ? {} : withProof(prior))
      assert.deepEqual(current.events.map(event => event.sourceEventId), expected)
      assert.deepEqual(current.usage.map(sample => sample.sourceUsageId), turns.get(snapshot.file).map(turn => `msg_atape_thinking_mock_${turn}`))
      assert.equal(current.header.origin.originKey, root.uuid); assert.equal(rawText(current), source)
      assert.deepEqual(current.header.sourceFailures, []); assert.deepEqual(await capture(root.sessionId, withProof(current)), current)
      prior = current; previous = source
    }
    await appendFile(file, '{"type":"user"')
    assert.deepEqual(await capture(prior.header.origin.sourceId, withProof(prior)), prior, "Incomplete physical suffix does not advance proof")
    await writeFile(file, previous.replace('"role":"user"', '"role":"invalid"'))
    await assert.rejects(() => capture(prior.header.origin.sourceId, withProof(prior)))
  }

  // Recorded compaction scenarios retain their explicit logical-data oracles.
  const names = ["native-auto-text-replay-rounds-2.1.263", "native-manual-text-tail-2.1.263", "native-manual-compact-2.1.263",
    "native-auto-read-replay-2.1.263", "native-repeated-auto-read-2.1.263", "native-reversed-read-pair-2.1.263",
    "native-repeated-dual-read-2.1.263", "native-read-pair-2.1.263", "native-manual-read-reinjection-2.1.263", "native-manual-large-read-reinjection-2.1.263"]
  const logical = (captured, expected) => {
    assert.equal(captured.events.length, expected.uniqueCanonicalEventCount ?? expected.uniqueRealEventCount ?? expected.eventCount)
    assert.equal(captured.usage.length, expected.distinctUsageCount ?? expected.distinctPersistedRealApiUsageCount)
    assert.equal(captured.usage.reduce((sum, sample) => sum + (sample.inputTokens ?? 0), 0), expected.inputTokens)
    assert.equal(captured.usage.reduce((sum, sample) => sum + (sample.outputTokens ?? 0), 0), expected.outputTokens)
    if (expected.eventSourceUuids) assert.deepEqual(captured.events.map(event => event.sourceEventId), expected.eventSourceUuids.map(uuid => `${uuid}:0`))
    if (expected.usageSourceIds) assert.deepEqual(captured.usage.map(sample => sample.sourceUsageId), expected.usageSourceIds)
    assert.doesNotMatch(JSON.stringify(captured.events), /GEN_INTERNAL_|No response requested\.|<command-name>\/compact|session is being continued from a previous conversation/)
  }
  let scenarioCount = 0
  for (const name of names) {
    const folder = join(packageRoot, "fixtures", name), metadata = JSON.parse(await readFile(join(folder, "provenance.json"), "utf8"))
    for (const scenario of metadata.cases ?? [{ id: name, nativeSnapshots: metadata.nativeSnapshots ?? metadata.snapshots ?? metadata.files }]) {
      const file = await fileFor(`${name}-${scenario.id}`); selected(file); let prior
      for (const [index, snapshot] of scenario.nativeSnapshots.entries()) {
        const recorded = await readFile(join(folder, snapshot.file ?? snapshot.path), "utf8")
        const hash = snapshot.sanitized?.sha256 ?? snapshot.sanitizedSha256 ?? snapshot.sha256
        if (hash) assert.equal(createHash("sha256").update(recorded).digest("hex"), hash)
        const source = relocate(recorded, metadata.fixtureCwd), root = parse(source).find(row => row.uuid)
        await writeFile(file, source)
        const current = await capture(root.sessionId, prior === undefined ? {} : withProof(prior))
        logical(current, snapshot.expected ?? snapshot.expectedLogicalData ?? { eventCount: [4, 4, 6][index], distinctUsageCount: [2, 2, 3][index], inputTokens: [52, 52, 81][index], outputTokens: [24, 24, 37][index] })
        assert.equal(rawText(current), source); assert.deepEqual(current.header.sourceFailures, [])
        assert.deepEqual(await capture(root.sessionId, withProof(current)), current)
        const off = await capture(root.sessionId, { rawEnabled: false }), backfill = await capture(root.sessionId, withProof(off))
        unchanged(off, backfill); assert.equal(rawText(backfill), source); prior = current
      }
      scenarioCount++
    }
  }
  for (const count of [1, 3, 100]) {
    const generated = await generatedContinuity(count), file = await fileFor(`generated-${count}`); selected(file)
    await writeFile(file, generated.snapshots[0].source)
    const actual = await capture(generated.sessionId); logical(actual, generated.snapshots[0].expected)
    assert.equal(rawText(actual), generated.snapshots[0].source)
  }

  const f = await family("native-foreground-child-2.1.263"), rootRows = parse(f.root), childRows = parse(f.child)
  for (const name of ["async", "noncompleted", "error", "missing-proof", "unsafe-agent", "nested"]) {
    const file = await fileFor(`unlinked-${name}`), root = structuredClone(rootRows), child = structuredClone(childRows)
    const receipt = root.find(row => row.toolUseResult?.agentId)
    if (name === "async") Object.assign(receipt.toolUseResult, { status: "async_launched", isAsync: true })
    if (name === "noncompleted") receipt.toolUseResult.status = "interrupted"
    if (name === "error") receipt.message.content[0].is_error = true
    if (name === "missing-proof") delete receipt.sourceToolAssistantUUID
    if (name === "unsafe-agent") receipt.toolUseResult.agentId = "../outside"
    if (name === "nested") {
      const callSource = child.find(row => row.type === "assistant" && row.message.content[0]?.type === "tool_use")
      const replySource = child.findLast(row => row.type === "assistant"), receiptSource = child.find(row => row.type === "user" && Array.isArray(row.message.content))
      const call = { ...structuredClone(callSource), uuid: "installed-nested-call", parentUuid: replySource.uuid,
        message: { ...callSource.message, id: "installed-nested-api-call", content: [{ type: "tool_use", id: "installed-nested-tool", name: "Agent", input: { prompt: "generated nested request" } }] } }
      const result = { ...structuredClone(receiptSource), uuid: "installed-nested-result", parentUuid: call.uuid, sourceToolAssistantUUID: call.uuid,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "installed-nested-tool", content: "generated nested result" }] }, toolUseResult: { agentId: "installed-grandchild", status: "completed" } }
      const reply = { ...structuredClone(replySource), uuid: "installed-nested-reply", parentUuid: result.uuid,
        message: { ...replySource.message, id: "installed-nested-api-reply", content: [{ type: "text", text: "INSTALLED_NESTED_CONTINUATION" }] } }
      child.push(call, result, reply)
    }
    const childFile = join(dirname(file), f.metadata.sessionId, "subagents", `agent-${f.metadata.agentId}.jsonl`)
    await mkdir(dirname(childFile), { recursive: true }); await writeFile(file, jsonl(root)); await writeFile(childFile, jsonl(child))
    await writeFile(join(dirname(childFile), "agent-installed-grandchild.jsonl"), "must never be read\n"); selected(file)
    const off = await capture(f.metadata.sessionId, { rawEnabled: false }), actual = await capture(f.metadata.sessionId, withProof(off))
    unchanged(off, actual); assert.equal(actual.events.length, name === "nested" ? 11 : 4); assert.equal(actual.usage.length, name === "nested" ? 6 : 2)
    assert.deepEqual(actual.header.sourceFailures, [{ source: name === "nested" ? childFile : file, reason: "unsupported" }])
    assert.equal(rawText(actual), jsonl(root)); assert.equal(rawText(actual, f.childId), name === "nested" ? jsonl(child) : "")
    assert.equal(actual.events.filter(event => event.childSourceThreadId).length, name === "nested" ? 1 : 0)
    assert.deepEqual(await capture(f.metadata.sessionId, withProof(actual)), actual)
  }

  // Every retained native root snapshot is exercised, including shapes outside
  // the count-oracle scenarios. Child locators still come solely from receipts.
  let roots = 0
  const walk = async folder => {
    const entries = await readdir(folder, { withFileTypes: true }), files = []
    for (const entry of entries) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) files.push(...await walk(path)); else if (entry.name.endsWith(".jsonl")) files.push(path)
    }
    return files
  }
  for (const entry of await readdir(join(packageRoot, "fixtures"), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("native-") || entry.name === "native-background-child-2.1.263") continue
    const folder = join(packageRoot, "fixtures", entry.name)
    for (const sourceFile of await walk(folder)) {
      if (sourceFile.includes("/subagents/")) continue
      const recorded = await readFile(sourceFile, "utf8"), root = parse(recorded).find(row => row.uuid)
      if (!root || root.isSidechain === true) continue
      const file = await fileFor(`corpus-${roots++}`); selected(file)
      const source = relocate(recorded, root.cwd); await writeFile(file, source)
      const children = join(dirname(sourceFile), root.sessionId, "subagents")
      for (const name of await readdir(children).catch(error => { if (error.code === "ENOENT") return []; throw error })) {
        if (!name.endsWith(".jsonl")) continue
        const destination = join(dirname(file), root.sessionId, "subagents", name)
        await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, relocate(await readFile(join(children, name), "utf8"), root.cwd))
      }
      const actual = await capture(root.sessionId)
      assert.equal(rawText(actual), source); assert.deepEqual(actual.header.sourceFailures, [])
    }
  }
  process.env.ATAPE_CLAUDE_SESSION_FILE = ""; process.env.ATAPE_CLAUDE_HOME = sourceHome
  process.stdout.write(`Verified installed Claude sourceCapture v2: ${roots + 3} native root snapshots, 9 rewind stages, ${scenarioCount} compaction scenarios, foreground/thinking families, direct background lifecycle and child-only append, child retention/removal, Raw off/backfill and 8 unlinked cases\n`)

  // Generated broad cycles prove one reducer, independently of native profile
  // counts. Bodies and bridge templates are controlled fixture data.
  async function generatedContinuity(count) {
    const templates = parse(await readFile(join(packageRoot, "fixtures/native-manual-read-reinjection-2.1.263/secondcontinue.jsonl"), "utf8"))
    const sessionId = "00000000-0000-4000-8000-000000000001", rows = [], eventSourceUuids = [], usageSourceIds = []
    let sequence = 0, leaf = null, slug, inputTokens = 0, outputTokens = 0
    const id = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`
    const fresh = (template, parent = leaf) => {
      const row = structuredClone(template); row.uuid = id(); row.parentUuid = parent; row.sessionId = sessionId; row.cwd = projectDirectory
      row.timestamp = new Date(Date.UTC(2026, 9, 9, 0, 0, sequence)).toISOString()
      if (slug) row.slug = slug; else delete row.slug
      return row
    }
    const add = row => { rows.push(row); leaf = row.uuid; return row }
    const ordinary = label => {
      const user = fresh(templates[43]); user.promptId = id(); user.message.content = `GEN_USER ${label}`; add(user); eventSourceUuids.push(user.uuid)
      add(fresh(templates[44])); const answer = fresh(templates[45]); answer.apiBlockIndex = 0; answer.message.id = `generated_api_${sequence}`
      answer.message.content = [{ type: "text", text: `GEN_ASSISTANT ${label}` }]; answer.message.usage.input_tokens = 20; answer.message.usage.output_tokens = 10
      add(answer); eventSourceUuids.push(answer.uuid); usageSourceIds.push(answer.message.id); inputTokens += 20; outputTokens += 10
      return rows.slice(-3)
    }
    ordinary("seed")
    for (let round = 0; round < count; round++) {
      for (let gap = 0; gap < round % 3; gap++) ordinary(`gap-${round}-${gap}`)
      const originals = ordinary(`before-${round}`), previousLeaf = leaf, manual = round % 3 === 1
      if (!manual) { slug ??= "generated-stable-slug"; for (const original of originals) { const copy = structuredClone(original); copy.slug ??= slug; rows.push(copy) } }
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
    return { sessionId, snapshots: [{ source: jsonl(rows), expected: { eventCount: eventSourceUuids.length, distinctUsageCount: usageSourceIds.length, inputTokens, outputTokens, eventSourceUuids, usageSourceIds } }] }
  }
}
