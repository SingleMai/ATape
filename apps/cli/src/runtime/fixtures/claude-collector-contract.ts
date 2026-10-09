// Controlled native Claude sources, installed CLI/Adapter and authenticated Go HTTP.
// Synthetic policy/unsupported appends are explicit test mutations of that corpus.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { CLICredentialStore, CollectorStateStore, installAdapter, planToolChange, applyToolChange,
  startManagedCollector, stopManagedCollector, inspectManagedCollector } from "@atape/application"
import { type StoredCLICredential } from "@atape/domain"
import { Effect, Layer, Logger } from "effect"
import { makeNodeClientLayer, defaultNodeClientPaths } from "../clientLayers.ts"
import { makeNodeCollectorDaemonLayer } from "../collectorDaemonLayers.ts"

const input = JSON.parse(readFileSync(0, "utf8")) as {
  phase: string; origin: string; credential: string; userId: string; home: string;
  tarball: string; previousTarball?: string; cliTarball: string; projectId: string; teamId: string
}
const adapterId = "claude", workspace = join(input.home, "workspace"), sourceHome = join(input.home, "source")
const sourceDirectory = join(sourceHome, "projects", "opaque-native-project")
const familyId = "d33bd4a6-a5ce-47d3-b4d3-91e62386940f", agentId = "a5b93406db8c7fefd"
const compactId = "2197a21d-e447-4ce2-bb24-4ae0c75b2c9d"
const tailId = "48656330-5cf7-4f7c-97d4-674c41750762"
const autoId = "43526b2f-6f23-4f37-9627-c75f50bfb9b9"
const pairToolId = "d0a2fe9a-191b-4666-9dfc-7edda5abc1e3", pairPlanId = "cf19053f-9c3c-49b7-8fce-461ae05d8294"
const autoReadSingleId = "611cd738-0d92-41ce-b1e3-64ba1a10a70a", autoReadDualId = "bb9cf168-c9d3-4fea-9428-bd7fc8460755"
const largeManualReadId = "b179ae84-44d8-4f32-adee-7f176edf363c"
const repeatedAutoReadId = "f2479149-41f5-4f6c-a3e2-7d46eca6ff30"
const reversedReadPairId = "979aa7c7-7bdb-4a9e-8aea-7d36f8cb5f1a"
const thinkingId = "generated-claude-thinking-contract"
const rootFile = join(sourceDirectory, `${familyId}.jsonl`)
const childFile = join(sourceDirectory, familyId, "subagents", `agent-${agentId}.jsonl`)
const compactFile = join(sourceDirectory, `${compactId}.jsonl`)
const tailFile = join(sourceDirectory, `${tailId}.jsonl`)
const autoFile = join(sourceDirectory, `${autoId}.jsonl`)
const pairToolFile = join(sourceDirectory, `${pairToolId}.jsonl`), pairPlanFile = join(sourceDirectory, `${pairPlanId}.jsonl`)
const autoReadSingleFile = join(sourceDirectory, `${autoReadSingleId}.jsonl`), autoReadDualFile = join(sourceDirectory, `${autoReadDualId}.jsonl`)
const largeManualReadFile = join(sourceDirectory, `${largeManualReadId}.jsonl`)
const repeatedAutoReadFile = join(sourceDirectory, `${repeatedAutoReadId}.jsonl`)
const reversedReadPairFile = join(sourceDirectory, `${reversedReadPairId}.jsonl`)
const thinkingFile = join(sourceDirectory, `${thinkingId}.jsonl`)
const compactFixture = new URL("../../../../../adapters/claude/fixtures/native-manual-compact-2.1.263/", import.meta.url)
const tailFixture = new URL("../../../../../adapters/claude/fixtures/native-manual-text-tail-2.1.263/", import.meta.url)
const autoFixture = new URL("../../../../../adapters/claude/fixtures/native-auto-text-replay-rounds-2.1.263/", import.meta.url)
const familyFixture = new URL("../../../../../adapters/claude/fixtures/native-foreground-child-2.1.263/", import.meta.url)
const pairFixture = new URL("../../../../../adapters/claude/fixtures/native-read-pair-2.1.263/", import.meta.url)
const autoReadFixture = new URL("../../../../../adapters/claude/fixtures/native-auto-read-replay-2.1.263/", import.meta.url)
const manualReadFixture = new URL("../../../../../adapters/claude/fixtures/native-manual-read-reinjection-2.1.263/", import.meta.url)
const repeatedAutoReadFixture = new URL("../../../../../adapters/claude/fixtures/native-repeated-auto-read-2.1.263/", import.meta.url)
const reversedReadPairFixture = new URL("../../../../../adapters/claude/fixtures/native-reversed-read-pair-2.1.263/", import.meta.url)
const repeatedDualReadFixture = new URL("../../../../../adapters/claude/fixtures/native-repeated-dual-read-2.1.263/", import.meta.url)
const largeManualReadFixture = new URL("../../../../../adapters/claude/fixtures/native-manual-large-read-reinjection-2.1.263/", import.meta.url)
const compactSnapshot = (name: string) => readFileSync(new URL(`${name}.jsonl`, compactFixture), "utf8")
  .replaceAll("/fixture/native-manual-compact", workspace)
const tailSnapshot = (name: string) => readFileSync(new URL(`${name}.jsonl`, tailFixture), "utf8")
  .replaceAll("/fixture/native-manual-text-tail/workspace", workspace)
const autoSnapshot = (name: string) => readFileSync(new URL(`${name}.jsonl`, autoFixture), "utf8")
  .replaceAll("/fixture/native-auto-text-replay-rounds/workspace", workspace)
const pairSnapshot = (file: string) => readFileSync(new URL(file, pairFixture), "utf8")
  .replaceAll("/fixture/native-parallel-read/workspace", workspace)
const autoReadSnapshot = (file: string) => readFileSync(new URL(file, autoReadFixture), "utf8")
  .replaceAll("/fixture/native-auto-tool-replay/workspace", workspace)
const manualReadSnapshot = (phase: string) => readFileSync(new URL(`${phase}.jsonl`, manualReadFixture), "utf8")
  .replaceAll("/fixture/native-manual-read-reinjection/workspace", workspace)
const largeManualReadSnapshot = (phase: string) => readFileSync(new URL(`${phase}.jsonl`, largeManualReadFixture), "utf8")
  .replaceAll("/fixture/native-manual-large-read-reinjection/workspace", workspace)
const repeatedAutoReadSnapshot = (phase: string) => readFileSync(new URL(`${phase}.jsonl`, repeatedAutoReadFixture), "utf8")
  .replaceAll("/fixture/native-repeated-auto-read/workspace", workspace)
const reversedReadPairSnapshot = (phase: string) => readFileSync(new URL(`${phase}.jsonl`, reversedReadPairFixture), "utf8")
  .replaceAll("/fixture/native-reversed-read-pair/workspace", workspace)
const repeatedDualReadSnapshot = (phase: string) => readFileSync(new URL(`${phase}.jsonl`, repeatedDualReadFixture), "utf8")
  .replaceAll("/fixture/native-repeated-dual-read/workspace", workspace)
  // Both corpora are the same native source. Preserve the already captured
  // literal transcript-reference origin when appending the later snapshot.
  .replaceAll("/fixture/native-repeated-dual-read/config", "/fixture/native-reversed-read-pair/config")
  .replaceAll("/fixture/native-repeated-dual-read/home", "/fixture/native-reversed-read-pair/home")
  .replaceAll("-fixture-native-repeated-dual-read-workspace", "-fixture-native-reversed-read-pair-workspace")
const autoReadCases = (JSON.parse(readFileSync(new URL("provenance.json", autoReadFixture), "utf8")) as {
  cases: ReadonlyArray<{ id: string; profile: string; lines: { plan: number; calls: ReadonlyArray<number>; results: ReadonlyArray<number>; A: number; S: number; F0: number } }>
}).cases
const pairCases = (JSON.parse(readFileSync(new URL("provenance.json", pairFixture), "utf8")) as {
  cases: ReadonlyArray<{ id: string; batch: { calls: ReadonlyArray<{ line: number }>; results: ReadonlyArray<{ line: number }> } }>
}).cases
const autoRounds = (JSON.parse(readFileSync(new URL("provenance.json", autoFixture), "utf8")) as {
  rounds: ReadonlyArray<{ round: number; phase: string; lines: { originalG: number; copyU: number; copyG: number; B: number; S: number } }>
}).rounds
const completeLinePrefix = (source: string, lines: number) => {
  let end = 0
  for (let line = 0; line < lines; line++) {
    const newline = source.indexOf("\n", end)
    assert.ok(newline >= end, "Native complete-line prefix is incomplete")
    end = newline + 1
  }
  return source.slice(0, end)
}
const thinkingPhase = input.phase.startsWith("thinking-")
// The optional previous artifact must create its own real checkpoint. It cannot
// read a newer projection cursor from the preceding candidate-only scenarios.
const paths = defaultNodeClientPaths({ ATAPE_HOME: join(input.home, thinkingPhase ? "thinking-client" : "client") })
const installed = join(input.home, "installed"), binary = join(installed, "node_modules", "@atape", "cli", "dist", "atape.js")
const at = "2026-10-08T00:00:00Z"
const environment = { ...process.env, ATAPE_HOME: paths.atapeHome, ATAPE_CLAUDE_HOME: sourceHome,
  ATAPE_CLAUDE_SESSION_FILE: input.phase.startsWith("thinking-") ? thinkingFile : "", ATAPE_CODEX_HOME: join(input.home, "missing-codex"),
  ATAPE_KIMI_HOME: join(input.home, "missing-kimi"), ATAPE_GROK_HOME: join(input.home, "missing-grok"),
  ATAPE_CODEBUDDY_HOME: join(input.home, "missing-codebuddy"), OPENCODE_DB: join(input.home, "missing-opencode"),
  ATAPE_DEVELOPMENT_ALLOW_HTTP: "true", ATAPE_COLLECTOR_DAEMON: "0", TEST_SECRET: "SENSITIVE_TEST_TOKEN" }
process.env.ATAPE_CLAUDE_HOME = sourceHome
process.env.ATAPE_CLAUDE_SESSION_FILE = environment.ATAPE_CLAUDE_SESSION_FILE
if (input.phase === "initial") {
  mkdirSync(paths.atapeHome, { recursive: true, mode: 0o700 })
  mkdirSync(workspace, { recursive: true }); mkdirSync(dirname(childFile), { recursive: true })
  const root = readFileSync(new URL(`${familyId}.jsonl`, familyFixture), "utf8").replaceAll("/fixture/native-foreground-child", workspace)
  const child = readFileSync(new URL(`${familyId}/subagents/agent-${agentId}.jsonl`, familyFixture), "utf8").replaceAll("/fixture/native-foreground-child", workspace)
  writeFileSync(rootFile, root); writeFileSync(childFile, child); writeFileSync(compactFile, compactSnapshot("before"))
  // A complete native-line cut puts the same API response's head and tail in
  // different acknowledged daemon cycles without reserializing any record.
  writeFileSync(tailFile, completeLinePrefix(tailSnapshot("before"), 19))
  writeFileSync(autoFile, autoSnapshot("warmup"))
  // Native LF cuts stage each same-API call and its own-parent result in
  // separate installed daemon cycles. They are not new native invocations.
  writeFileSync(pairToolFile, completeLinePrefix(pairSnapshot("tool-only/tools.jsonl"), 4))
  writeFileSync(pairPlanFile, pairSnapshot("text-plan/warmup.jsonl"))
  writeFileSync(autoReadSingleFile, autoReadSnapshot("auto_single/warmup.jsonl"))
  writeFileSync(autoReadDualFile, autoReadSnapshot("auto/warmup.jsonl"))
  writeFileSync(largeManualReadFile, largeManualReadSnapshot("seed"))
  writeFileSync(repeatedAutoReadFile, repeatedAutoReadSnapshot("seed"))
  writeFileSync(reversedReadPairFile, reversedReadPairSnapshot("seed"))
  const foreign = join(input.home, "foreign-project"); mkdirSync(foreign)
  writeFileSync(join(sourceDirectory, "foreign.jsonl"), root.replaceAll(familyId, "foreign-claude-session").replaceAll(workspace, foreign))
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installed, input.cliTarball],
    { cwd: input.home, stdio: "pipe", timeout: 120000 })
}
if (input.phase === "initial" || input.phase === "thinking-seed") {
  mkdirSync(paths.atapeHome, { recursive: true, mode: 0o700 })
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ version: 3, toolsConfigured: true, enabledAdapterIds: [], adapters: [], projects: [{
    id: input.projectId, instanceOrigin: input.origin, userId: input.userId, teamId: input.teamId,
    teamSlug: "claude-contract", teamName: "Claude contract", name: "Claude", type: "directory", path: workspace, createdAt: at, adapterIds: [] }] }))
}
if (input.phase === "compact") writeFileSync(compactFile, compactSnapshot("compacted"))
if (input.phase === "continued") writeFileSync(compactFile, compactSnapshot("continued"))
if (input.phase === "tail-before") writeFileSync(tailFile, tailSnapshot("before"))
if (input.phase === "tail-compact") writeFileSync(tailFile, tailSnapshot("compacted"))
if (input.phase === "tail-continued") writeFileSync(tailFile, tailSnapshot("continued"))
if (input.phase === "tail-continued-again") writeFileSync(tailFile, tailSnapshot("continued-again"))
const autoStage = /^auto-(\d+)-(originals|copy-user|copy-gap|boundary|summary|answer)$/.exec(input.phase)
if (autoStage) {
  const round = autoRounds.find(round => round.round === Number(autoStage[1]))
  assert.ok(round, "Native automatic round is missing")
  const source = autoSnapshot(round.phase)
  const line = autoStage[2] === "originals" ? round.lines.originalG
    : autoStage[2] === "copy-user" ? round.lines.copyU : autoStage[2] === "copy-gap" ? round.lines.copyG
      : autoStage[2] === "boundary" ? round.lines.B : round.lines.S
  writeFileSync(autoFile, autoStage[2] === "answer" ? source : completeLinePrefix(source, line))
}
const pairStage = /^pair-(tool|plan)-(plan|call0|call1|r0|r1|final-a|final|resume)$/.exec(input.phase)
if (pairStage) {
  const planned = pairStage[1] === "plan", slot = pairStage[2]
  const fixtureCase = pairCases.find(fixtureCase => fixtureCase.id === (planned ? "text-plan" : "tool-only"))
  assert.ok(fixtureCase, "Native Read-pair case is missing")
  const file = planned ? pairPlanFile : pairToolFile
  const source = pairSnapshot(planned ? "text-plan/toolturn.jsonl" : slot === "resume" ? "tool-only/resume.jsonl" : "tool-only/tools.jsonl")
  const line = slot === "plan" ? 19 : slot === "call0" ? fixtureCase.batch.calls[0]!.line
    : slot === "call1" ? fixtureCase.batch.calls[1]!.line : slot === "r0" ? fixtureCase.batch.results[0]!.line
      : slot === "r1" ? fixtureCase.batch.results[1]!.line : slot === "final-a" ? 25 : undefined
  const next = line === undefined ? source : completeLinePrefix(source, line)
  assert.ok(next.startsWith(readFileSync(file, "utf8")), "Read-pair phase changed the native prefix")
  writeFileSync(file, next)
}
const autoReadStage = /^auto-read-(single|dual)-(plan|call0|call1|r0|r1|originals|summary|final-a|final|continue|secondcontinue)$/.exec(input.phase)
if (autoReadStage) {
  const fixtureCase = autoReadCases.find(fixtureCase => fixtureCase.profile === autoReadStage[1])
  assert.ok(fixtureCase, "Native automatic Read case is missing")
  const slot = autoReadStage[2], file = autoReadStage[1] === "single" ? autoReadSingleFile : autoReadDualFile
  const source = autoReadSnapshot(`${fixtureCase.id}/${slot === "continue" || slot === "secondcontinue" ? slot : "toolturn"}.jsonl`)
  const line = slot === "plan" ? fixtureCase.lines.plan : slot === "call0" ? fixtureCase.lines.calls[0]
    : slot === "call1" ? fixtureCase.lines.calls[1] : slot === "r0" ? fixtureCase.lines.results[0]
      : slot === "r1" ? fixtureCase.lines.results[1] : slot === "originals" ? fixtureCase.lines.A
        : slot === "summary" ? fixtureCase.lines.S : slot === "final-a" ? fixtureCase.lines.F0 : undefined
  if (slot === "call1" || slot === "r1") assert.ok(line, "Single Read has no second native call/result")
  const next = line === undefined ? source : completeLinePrefix(source, line)
  assert.ok(next.startsWith(readFileSync(file, "utf8")), "Automatic Read phase changed the native prefix")
  writeFileSync(file, next)
}
// Literal native LF cuts expose repeated compaction and independently captured
// Raw-only file context. The number of samples does not constrain continuation.
const repeatedAutoReadStage = /^repeated-auto-read-(warmup|r[12]-(plan|call|result|originals|summary|file|final-a|final)|ordinary-resume)$/.exec(input.phase)
if (repeatedAutoReadStage) {
  const slot = repeatedAutoReadStage[1]!
  const phase = slot === "warmup" || slot === "ordinary-resume" ? slot : slot.slice(0, 2)
  const source = repeatedAutoReadSnapshot(phase)
  const cuts: Record<string, number> = { "r1-plan": 22, "r1-call": 23, "r1-result": 24,
    "r1-originals": 25, "r1-summary": 33, "r1-final-a": 34, "r2-plan": 44,
    "r2-call": 45, "r2-result": 46, "r2-originals": 47, "r2-summary": 55,
    "r2-file": 56, "r2-final-a": 57 }
  assert.ok(slot !== "r1-file", "The first native round has no file reinjection")
  const next = cuts[slot] === undefined ? source : completeLinePrefix(source, cuts[slot])
  assert.ok(next.startsWith(readFileSync(repeatedAutoReadFile, "utf8")), "Repeated automatic Read changed its native prefix")
  writeFileSync(repeatedAutoReadFile, next)
}
const reversedReadPairStage = /^reversed-read-pair-(warmup|plan|call-a|call-b|result-b|result-a|originals|summary|final-a|final|ordinary-resume)$/.exec(input.phase)
if (reversedReadPairStage) {
  const slot = reversedReadPairStage[1]!
  const source = reversedReadPairSnapshot(slot === "warmup" || slot === "ordinary-resume" ? slot : "r1")
  const cuts: Record<string, number> = { plan: 22, "call-a": 23, "call-b": 24,
    "result-b": 25, "result-a": 26, originals: 27, summary: 37, "final-a": 38 }
  const next = cuts[slot] === undefined ? source : completeLinePrefix(source, cuts[slot])
  assert.ok(next.startsWith(readFileSync(reversedReadPairFile, "utf8")), "Reversed Read pair changed its native prefix")
  writeFileSync(reversedReadPairFile, next)
}
const repeatedDualReadStage = /^repeated-dual-read-(plan|call-a|call-b|result-a|result-b|originals|summary|file-a|files|final-a|final|ordinary-resume)$/.exec(input.phase)
if (repeatedDualReadStage) {
  const slot = repeatedDualReadStage[1]!
  const source = repeatedDualReadSnapshot(slot === "ordinary-resume" ? slot : "r2")
  const cuts: Record<string, number> = { plan: 54, "call-a": 55, "call-b": 56,
    "result-a": 57, "result-b": 58, originals: 59, summary: 69, "file-a": 70,
    files: 71, "final-a": 72 }
  const next = cuts[slot] === undefined ? source : completeLinePrefix(source, cuts[slot])
  assert.ok(next.startsWith(readFileSync(reversedReadPairFile, "utf8")), "Repeated dual Read changed its acknowledged native prefix")
  writeFileSync(reversedReadPairFile, next)
}
// This native manual source continues the existing text-plan Read-pair Session.
// Its toolturn prefix is identical after the declared workspace substitution;
// do not create a second source with the same Session identity.
const manualReadStage = /^manual-read-(boundary|summary|caveat|command|stdout|file-first|files|bookkeeping|meta|bridge|user|continue|secondcontinue)$/.exec(input.phase)
if (manualReadStage) {
  const slot = manualReadStage[1]!
  const source = manualReadSnapshot(slot === "secondcontinue" ? slot : slot === "meta" || slot === "bridge" || slot === "user" || slot === "continue" || slot === "bookkeeping" ? "continue" : "compact")
  const lines: Record<string, number> = { boundary: 32, summary: 33, caveat: 34, command: 35, stdout: 36,
    "file-first": 37, files: 38, bookkeeping: 41, meta: 42, bridge: 43, user: 44 }
  const next = lines[slot] === undefined ? source : completeLinePrefix(source, lines[slot])
  assert.ok(next.startsWith(readFileSync(pairPlanFile, "utf8")), "Manual Read phase changed the existing native prefix")
  writeFileSync(pairPlanFile, next)
}
const largeManualReadStage = /^large-manual-read-(warmup|toolturn|boundary|summary|caveat|command|stdout|file-first|files|bookkeeping|meta|bridge|user|continue|secondcontinue)$/.exec(input.phase)
if (largeManualReadStage) {
  const slot = largeManualReadStage[1]!
  const phase = ["warmup", "toolturn", "secondcontinue"].includes(slot) ? slot
    : ["bookkeeping", "meta", "bridge", "user", "continue"].includes(slot) ? "continue" : "compact"
  const source = largeManualReadSnapshot(phase)
  const cuts: Record<string, number> = { boundary: 34, summary: 35, caveat: 36, command: 37, stdout: 38,
    "file-first": 39, files: 40, bookkeeping: 45, meta: 46, bridge: 47, user: 48 }
  const next = cuts[slot] === undefined ? source : completeLinePrefix(source, cuts[slot])
  assert.ok(next.startsWith(readFileSync(largeManualReadFile, "utf8")), "Large manual Read phase changed the native prefix")
  writeFileSync(largeManualReadFile, next)
}
if (input.phase === "raw-off") {
  const source = readFileSync(compactFile, "utf8"), rows = source.trimEnd().split("\n").map(line => JSON.parse(line))
  const last = rows.findLast(row => typeof row.uuid === "string")
  writeFileSync(compactFile, source + JSON.stringify({ ...rows.find(row => row.type === "user"),
    uuid: "controlled-policy-user", parentUuid: last.uuid, timestamp: "2026-10-08T08:20:00Z",
    message: { role: "user", content: "ClaudePolicyNeedle SENSITIVE_TEST_TOKEN" } }) + "\n")
}
if (input.phase === "unsupported") {
  const source = readFileSync(compactFile, "utf8"), rows = source.trimEnd().split("\n").map(line => JSON.parse(line))
  const boundary = rows.find(row => row.subtype === "compact_boundary")
  writeFileSync(join(input.home, "retained.jsonl"), source)
  writeFileSync(compactFile, source + JSON.stringify({ ...boundary, uuid: "controlled-auto-boundary",
    logicalParentUuid: "controlled-stale-parent", compactMetadata: { ...boundary.compactMetadata, trigger: "auto" } }) + "\n")
}
if (input.phase === "repair") writeFileSync(compactFile, readFileSync(join(input.home, "retained.jsonl")))
// These are generated relationship mutations, not additional native lifecycle
// evidence. Their current Thread records retain the native ordinary schemas.
const generatedDelegation = (slot: "async" | "running" | "error" | "nested") => {
  const nested = slot === "nested", file = nested ? childFile : rootFile
  const source = readFileSync(file, "utf8"), rows = source.trimEnd().split("\n").map(line => JSON.parse(line))
  const last = rows.findLast(row => typeof row.uuid === "string")
  const template = rows.find(row => row.type === "assistant" && row.message.content.some((block: { type: string }) => block.type === "tool_use"))
  const receiptTemplate = JSON.parse(readFileSync(rootFile, "utf8").trimEnd().split("\n")
    .find(line => JSON.parse(line).toolUseResult?.agentId === agentId)!)
  const proposedAgent = `generated_unlinked_${slot}`, callId = `call_generated_unlinked_${slot}`
  const callUuid = `generated-unlinked-${slot}-call`, receiptUuid = `generated-unlinked-${slot}-receipt`
  const call = { ...template, uuid: callUuid, parentUuid: last.uuid, timestamp: "2026-10-08T12:00:00Z",
    message: { ...template.message, id: `msg_generated_unlinked_${slot}_call`, content: [{ type: "tool_use", id: callId,
      name: slot === "running" ? "Task" : "Agent", input: { description: "Generated unproved child",
        prompt: `ATAPE_UNLINKED_TOOL_${slot}: preserve current Thread`, run_in_background: slot === "async" } }] } }
  const receipt = { ...receiptTemplate, uuid: receiptUuid, parentUuid: callUuid, sourceToolAssistantUUID: callUuid,
    timestamp: "2026-10-08T12:00:01Z", isSidechain: nested,
    ...(nested ? { agentId } : {}), message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId,
      content: `ATAPE_UNLINKED_TOOL_${slot}: generated result`, ...(slot === "error" ? { is_error: true } : {}) }] },
    toolUseResult: { status: slot === "async" ? "async_launched" : slot === "running" ? "running" : "completed",
      isAsync: slot === "async", agentId: proposedAgent } }
  const reply = { ...template, uuid: `generated-unlinked-${slot}-reply`, parentUuid: receiptUuid,
    timestamp: "2026-10-08T12:00:02Z", message: { ...template.message, id: `msg_generated_unlinked_${slot}_reply`,
      stop_reason: "end_turn", content: [{ type: "text", text: `ATAPE_CURRENT_THREAD_${slot}: ordinary capture continues.` }] } }
  const unproved = readFileSync(new URL(`${familyId}/subagents/agent-${agentId}.jsonl`, familyFixture), "utf8")
    .replaceAll("/fixture/native-foreground-child", workspace).replaceAll(agentId, proposedAgent)
    .replaceAll("ATAPE_CHILD_FINAL", `ATAPE_UNPROVED_HISTORY_${slot}`)
  writeFileSync(join(dirname(childFile), `agent-${proposedAgent}.jsonl`), unproved)
  return { file, source, call: JSON.stringify(call) + "\n", tail: JSON.stringify(receipt) + "\n" + JSON.stringify(reply) + "\n" }
}
const rootDelegation = /^unlinked-root-(async|running|error)$/.exec(input.phase)
if (rootDelegation) {
  const generated = generatedDelegation(rootDelegation[1] as "async" | "running" | "error")
  writeFileSync(generated.file, generated.source + generated.call + generated.tail)
}
if (input.phase === "unlinked-nested-call") {
  const generated = generatedDelegation("nested")
  writeFileSync(generated.file, generated.source + generated.call)
  writeFileSync(join(input.home, "generated-nested-tail.jsonl"), generated.tail)
}
if (input.phase === "unlinked-nested-partial") {
  const source = readFileSync(childFile, "utf8"), tail = readFileSync(join(input.home, "generated-nested-tail.jsonl"), "utf8")
  writeFileSync(join(input.home, "generated-nested-before.jsonl"), source)
  writeFileSync(childFile, source + tail.slice(0, tail.indexOf("\n") - 1))
}
if (input.phase === "unlinked-nested-complete") {
  writeFileSync(childFile, readFileSync(join(input.home, "generated-nested-before.jsonl"), "utf8") +
    readFileSync(join(input.home, "generated-nested-tail.jsonl"), "utf8"))
}
if (input.phase === "unlinked-root-resume") {
  const source = readFileSync(rootFile, "utf8"), rows = source.trimEnd().split("\n").map(line => JSON.parse(line))
  const template = rows.find(row => row.type === "assistant"), last = rows.findLast(row => typeof row.uuid === "string")
  writeFileSync(rootFile, source + JSON.stringify({ ...template, uuid: "generated-unlinked-root-resume",
    parentUuid: last.uuid, timestamp: "2026-10-08T12:01:00Z", message: { ...template.message,
      id: "msg_generated_unlinked_root_resume", stop_reason: "end_turn",
      content: [{ type: "text", text: "ATAPE_CURRENT_THREAD_root_resume: both unlinked diagnostics remain visible." }] } }) + "\n")
}
// Generated mixed blocks establish projection and delivery behavior; they are
// not a claim of native acquisition or recovery of opaque provider reasoning.
if (input.phase === "thinking-seed") {
  const rows = readFileSync(rootFile, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
  const user = rows.find(row => row.type === "user"), assistant = rows.find(row => row.type === "assistant")
  const base = { cwd: workspace, sessionId: thinkingId, isSidechain: false, version: "2.1.263" }
  const mixed = { ...assistant, ...base, uuid: "generated-thinking-mixed", parentUuid: "generated-thinking-user",
    timestamp: "2026-10-08T13:00:01Z", message: { ...assistant.message, id: "msg_generated_thinking_mixed",
      content: [{ type: "thinking", thinking: "ATAPE_THOUGHT_ONLY_mixed: SENSITIVE_TEST_TOKEN reasoning text.", signature: "ATAPE_THOUGHT_SIGNATURE" },
        { type: "text", text: "ATAPE_THINKING_MESSAGE_mixed: a visible plan." },
        { type: "tool_use", id: "call_generated_thinking_read", name: "Read", input: { file_path: join(workspace, "thinking-fixture.txt") } },
        { type: "thinking", thinking: " \n\t " }, { type: "thinking", thinking: "\u0085" }, { type: "thinking", thinking: "\ufeff" }] } }
  const result = { ...user, ...base, uuid: "generated-thinking-result", parentUuid: mixed.uuid,
    sourceToolAssistantUUID: mixed.uuid, timestamp: "2026-10-08T13:00:02Z", message: { role: "user", content: [{
      type: "tool_result", tool_use_id: "call_generated_thinking_read", content: "ATAPE_THINKING_TOOL_OUTPUT: generated fixture contents." }] } }
  const final = { ...assistant, ...base, uuid: "generated-thinking-final", parentUuid: result.uuid,
    timestamp: "2026-10-08T13:00:03Z", message: { ...assistant.message, id: "msg_generated_thinking_final", stop_reason: "end_turn",
      content: [{ type: "redacted_thinking", data: "ATAPE_REDACTED_PAYLOAD" },
        { type: "thinking", thinking: "ATAPE_THOUGHT_ONLY_final: SENSITIVE_TEST_TOKEN conclusion.", signature: "ATAPE_THOUGHT_SIGNATURE" },
        { type: "text", text: "ATAPE_THINKING_MESSAGE_final: a visible answer." }] } }
  writeFileSync(thinkingFile, [{ ...user, ...base, uuid: "generated-thinking-user", parentUuid: null,
    timestamp: "2026-10-08T13:00:00Z", message: { role: "user", content: "ATAPE_GENERATED_THINKING_SEED: mixed blocks." } }, mixed, result, final]
    .map(row => JSON.stringify(row) + "\n").join(""))
}
if (input.phase === "thinking-append") {
  const source = readFileSync(thinkingFile, "utf8"), rows = source.trimEnd().split("\n").map(line => JSON.parse(line))
  const template = rows.find(row => row.type === "assistant"), last = rows.findLast(row => typeof row.uuid === "string")
  writeFileSync(thinkingFile, source + JSON.stringify({ ...template, uuid: "generated-thinking-append", parentUuid: last.uuid,
    timestamp: "2026-10-08T13:01:00Z", message: { ...template.message, id: "msg_generated_thinking_append", stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "ATAPE_THOUGHT_ONLY_append: SENSITIVE_TEST_TOKEN later thought.", signature: "ATAPE_THOUGHT_SIGNATURE" },
        { type: "text", text: "ATAPE_THINKING_MESSAGE_append: a later visible answer." }] } }) + "\n")
}
if (input.phase === "delete") rmSync(join(sourceHome, "projects"), { recursive: true })

const layer = Layer.merge(makeNodeClientLayer(paths, environment), makeNodeCollectorDaemonLayer(paths, binary, environment))
const result = await Effect.runPromise(Effect.gen(function*() {
  if (input.phase === "initial" || input.phase === "thinking-seed") {
    const credentials = yield* CLICredentialStore
    const credential: StoredCLICredential = { version: 1, instanceOrigin: input.origin, apiOrigin: input.origin,
      credential: input.credential, credentialId: "claude-integration-credential", capabilityVersion: "atape-cli.v1",
      createdAt: at, user: { id: input.userId, displayName: "Claude fixture" } }
    yield* credentials.replace({ credential })
    assert.equal((yield* installAdapter(input.phase === "thinking-seed" && input.previousTarball ? input.previousTarball : input.tarball)).adapter.adapterId, adapterId)
    yield* planToolChange([adapterId]).pipe(Effect.flatMap(applyToolChange))
  }
  if (input.phase === "thinking-upgrade") assert.equal((yield* installAdapter(input.tarball)).adapter.adapterId, adapterId)
  const before = (yield* inspectManagedCollector()).lastCycleCompletedAt
  const job = yield* Effect.acquireUseRelease(
    startManagedCollector({ intervalMs: 10000, concurrency: 1 }),
    () => Effect.gen(function*() {
      for (let attempt = 0; attempt < 400; attempt++) {
        const status = yield* inspectManagedCollector()
        assert.ok(status.running, "Installed Claude Collector exited")
        assert.equal(status.collectorFailure, undefined)
        const current = status.jobs.find(job => job.adapterId === adapterId && job.projectId === input.projectId)
        if (status.lastCycleCompletedAt && status.lastCycleCompletedAt !== before && current && !current.hasMore) {
          assert.equal(current.state, input.phase === "unsupported" || input.phase.startsWith("unlinked-") ? "partial" : "healthy", JSON.stringify(current))
          return current
        }
        yield* Effect.sleep(100)
      }
      throw new Error("Installed Claude Collector did not finish a bounded cycle")
    }),
    () => stopManagedCollector().pipe(Effect.orDie)
  )
  assert.equal((yield* inspectManagedCollector()).running, false)
  const states = yield* CollectorStateStore
  const state = yield* states.snapshot(input.origin, input.userId, input.projectId, adapterId)
  assert.ok(state.checkpoint?.cursor)
  assert.equal(state.checkpoint.canonicalPublished, true)
  const cursor = state.checkpoint.cursor
  const decoded = JSON.parse(cursor.startsWith("z3:")
    ? inflateRawSync(Buffer.from(cursor.slice(3), "base64url"), { maxOutputLength: 16 * 1024 * 1024 }).toString("utf8") : cursor)
  assert.deepEqual(decoded.sessions.map((entry: { checkpoint: { sessionId: string } }) => entry.checkpoint.sessionId).sort(), (thinkingPhase ? [thinkingId]
    : [compactId, familyId, tailId, autoId, pairToolId, pairPlanId, autoReadSingleId, autoReadDualId, largeManualReadId, repeatedAutoReadId, reversedReadPairId]).sort(),
    "Foreign source was captured or a known checkpoint was reset")
  return { installationId: state.installationId, cursor: state.checkpoint.cursor, rawObjects: state.checkpoint.rawObjects,
    observations: job.observations ?? 0, canonicalEvents: job.canonicalEvents ?? 0, canonicalBatches: job.canonicalBatches ?? 0,
    rawChunks: job.rawChunks ?? 0, sourceFailures: job.sourceFailures ?? [], progress: job.progress }
}).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(Logger.layer([]))))
process.stdout.write(JSON.stringify(result))
