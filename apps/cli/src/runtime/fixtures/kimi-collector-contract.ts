// Controlled native source, installed CLI/Adapter and the real Go HTTP contract.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { CaptureJournals, CLICredentialStore, CollectorStateStore, runCollectionCycle, installAdapter, planToolChange, applyToolChange, startManagedCollector, stopManagedCollector, inspectManagedCollector, defaultSourceCollectionLimits } from "@atape/application"
import { type StoredCLICredential } from "@atape/domain"
import { Effect, Layer, Logger } from "effect"
import { makeNodeClientLayer, defaultNodeClientPaths } from "../clientLayers.ts"
import { makeNodeCollectorDaemonLayer } from "../collectorDaemonLayers.ts"

const input = JSON.parse(readFileSync(0, "utf8")) as { phase: string; origin: string; credential: string; userId: string; home: string; tarball: string; cliTarball: string; projectId: string; teamId: string }
const specimen = input.phase.startsWith("context-") ? "context" : input.phase === "auto" ? "auto" : input.phase === "clear" ? "clear" : "native"
const home = input.home, workspace = join(home, "workspace"), adapterId = "kimi"
const native = readFileSync(new URL(`../../../../../adapters/kimi/src/fixtures/${specimen}-0.42.0.jsonl`, import.meta.url), "utf8").replaceAll("/fixture/kimi-project", workspace)
const metadata = readFileSync(new URL(`../../../../../adapters/kimi/src/fixtures/${specimen}-0.42.0.state.json`, import.meta.url), "utf8").replaceAll("/fixture/kimi-project", workspace)
const sourceId = JSON.parse(metadata).id as string
const sourceHome = join(home, "source"), directory = join(sourceHome, "sessions", "opaque", sourceId), file = join(directory, "agents", "main", "wire.jsonl")
const paths = defaultNodeClientPaths({ ATAPE_HOME: join(home, "client") }), installed = join(home, "installed")
const binary = join(installed, "node_modules", "@atape", "cli", "dist", "atape.js")
const environment = { ...process.env, ATAPE_HOME: paths.atapeHome, ATAPE_KIMI_HOME: sourceHome,
  ATAPE_CODEX_HOME: join(home, "missing-codex"), ATAPE_CLAUDE_HOME: join(home, "missing-claude"), ATAPE_CODEBUDDY_HOME: join(home, "missing-codebuddy"), OPENCODE_DB: join(home, "missing-opencode"),
  ATAPE_DEVELOPMENT_ALLOW_HTTP: "true", ATAPE_COLLECTOR_DAEMON: "0", TEST_SECRET: "SENSITIVE_TEST_TOKEN" }
process.env.ATAPE_KIMI_HOME = sourceHome
const at = "2026-09-13T00:00:00Z"
const save = (rows: unknown[]) => writeFileSync(file, rows.map(row => JSON.stringify(row) + "\n").join(""))
const restore = (wire: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, wire); writeFileSync(join(directory, "state.json"), metadata) }
const contextLength: Record<string, number> = { "context-seed": 32, "context-undo": 34, "context-restore": 34, "context-compact": 52, "context-afterundo": 68, "context-final": 88, "context-incomplete": 50 }
if (contextLength[input.phase]) restore(native.split("\n").slice(0, contextLength[input.phase]).join("\n") + "\n")
if (["auto", "clear"].includes(input.phase)) restore(native)
if (["context-recover", "context-recover-raw"].includes(input.phase)) rmSync(directory, { recursive: true })
if (input.phase === "context-raw-loss") {
  const rows = native.trim().split("\n").map(line => JSON.parse(line)); rows[49].extraRawField = "KimiCompactionRawOnly"; save(rows)
}
if (input.phase === "initial") {
  mkdirSync(workspace); mkdirSync(paths.atapeHome, { recursive: true, mode: 0o700 }); restore(native)
  const foreign = join(sourceHome, "sessions", "opaque", "foreign-kimi-session")
  mkdirSync(join(foreign, "agents", "main"), { recursive: true }); mkdirSync(join(home, "foreign-project"))
  writeFileSync(join(foreign, "state.json"), metadata.replaceAll(sourceId, "foreign-kimi-session").replaceAll(workspace, join(home, "foreign-project")))
  writeFileSync(join(foreign, "agents", "main", "wire.jsonl"), native)
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installed, input.cliTarball], { cwd: home, stdio: "pipe", timeout: 120000 })
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ version: 3, toolsConfigured: true, enabledAdapterIds: [], adapters: [], projects: [{
    id: input.projectId, instanceOrigin: input.origin, userId: input.userId, teamId: input.teamId, teamSlug: "acme", teamName: "Fixture", name: "Kimi", type: "directory", path: workspace, createdAt: at, adapterIds: [] }] }))
}
if (["edit", "raw-off", "lose-activation", "raw-only"].includes(input.phase)) {
  const values = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line))
  if (input.phase === "edit") values.push(
    { type: "turn.prompt", agentId: "main", promptId: "controlled-resume", origin: { kind: "user" }, input: [{ type: "text", text: "KimiResumeNeedle SENSITIVE_TEST_TOKEN" }], time: 1789264195000 },
    { type: "context.append_message", agentId: "main", message: { role: "user", id: "controlled-resume", origin: { kind: "user" }, toolCalls: [], content: [{ type: "text", text: "KimiResumeNeedle SENSITIVE_TEST_TOKEN" }] }, time: 1789264195000 },
    { type: "context.append_loop_event", agentId: "main", event: { type: "step.begin", uuid: "controlled-step", turnId: "3", step: 1 }, time: 1789264195001 },
    { type: "llm.request", agentId: "main", kind: "loop", turnStep: "3.1", model: "atape-controlled-model", time: 1789264195001 },
    { type: "context.append_loop_event", agentId: "main", event: { type: "content.part", uuid: "controlled-answer", stepUuid: "controlled-step", turnId: "3", step: 1, part: { type: "text", text: "KimiResumeAnswer" } }, time: 1789264195002 },
    { type: "context.append_loop_event", agentId: "main", event: { type: "step.end", uuid: "controlled-step", turnId: "3", step: 1, finishReason: "end_turn" }, time: 1789264195003 },
    { type: "turn.ended", agentId: "main", turnId: 3, reason: "completed", time: 1789264195003 })
  const answer = values.find(row => row.event?.uuid === "controlled-answer")
  if (input.phase === "raw-off") answer.event.part.text = "KimiPolicyNeedle"
  if (input.phase === "lose-activation") answer.event.part.text = "KimiFinalNeedle"
  if (input.phase === "raw-only") answer.extraRawField = "KimiRawOnlyNeedle"
  save(values)
}
if (["recover-activation", "recover-raw"].includes(input.phase)) rmSync(directory, { recursive: true })
if (["restore", "repair"].includes(input.phase)) restore(readFileSync(join(home, "saved.jsonl"), "utf8"))
if (input.phase === "malformed") writeFileSync(file, readFileSync(file, "utf8") + "unfinished")
if (input.phase === "unsupported") writeFileSync(join(directory, "state.json"), JSON.stringify({ ...JSON.parse(metadata), forkedFrom: "parent" }))
let lost = false, uploads = 0, puts = 0
const faultFetch: typeof fetch = async (url, init) => {
  const response = await fetch(url, init), target = String(url)
  if (init?.method === "PUT" && target.includes("/publications/attempts/")) puts++
  if (target.endsWith("/ingestion/raw/chunks")) uploads++
  if (!lost && (["lose-activation", "context-undo"].includes(input.phase) && target.endsWith("/activate") && response.status === 200 || ["raw-only", "context-raw-loss"].includes(input.phase) && target.endsWith("/ingestion/raw/chunks") && response.status === 201)) {
    lost = true; await response.arrayBuffer(); throw new TypeError("Controlled committed response loss")
  }
  return response
}
const layer = Layer.merge(makeNodeClientLayer(paths, environment, fetch, faultFetch), makeNodeCollectorDaemonLayer(paths, binary, environment))
const result = await Effect.runPromise(Effect.gen(function*() {
  if (input.phase === "initial") {
    const credentials = yield* CLICredentialStore
    const credential: StoredCLICredential = { version: 1, instanceOrigin: input.origin, apiOrigin: input.origin, credential: input.credential,
      credentialId: "integration-credential", capabilityVersion: "atape-cli.v1", createdAt: at, user: { id: input.userId, displayName: "Fixture" } }
    yield* credentials.replace({ credential })
    assert.equal((yield* installAdapter(input.tarball)).adapter.adapterId, adapterId)
    yield* planToolChange([adapterId]).pipe(Effect.flatMap(applyToolChange))
  }
  if (input.phase === "upgrade") {
    const config = JSON.parse(readFileSync(paths.configFile, "utf8")), slot = config.adapters.find((item: { adapterId: string }) => item.adapterId === adapterId)
    const replacement = join(home, "replacement"); assert.ok(typeof slot.packageSlot === "string")
    cpSync(join(paths.adapterDirectory, "slots", slot.packageSlot, "node_modules", "@atape", "adapter-kimi"), replacement, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(replacement, "package.json"), "utf8")); manifest.version += "-kimi-replacement"
    writeFileSync(join(replacement, "package.json"), JSON.stringify(manifest))
    const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", home], { cwd: replacement, encoding: "utf8" }))
    assert.equal((yield* installAdapter(join(home, packed[0].filename))).adapter.version, manifest.version)
  }
  let observations = 0, failures = 0, diagnostics = 0
  if (["initial", "upgrade"].includes(input.phase)) {
    const before = (yield* inspectManagedCollector()).lastCycleCompletedAt
    const job = yield* Effect.acquireUseRelease(startManagedCollector({ intervalMs: 10000, concurrency: 1 }), () => Effect.gen(function*() {
      for (let attempt = 0; attempt < 200; attempt++) {
        const status = yield* inspectManagedCollector()
        assert.ok(status.running, "Installed Collector exited"); assert.equal(status.collectorFailure, undefined)
        const current = status.jobs.find(job => job.adapterId === adapterId && job.projectId === input.projectId)
        if (status.lastCycleCompletedAt && status.lastCycleCompletedAt !== before && current && !current.hasMore) {
          assert.equal(current.state, "healthy", JSON.stringify(current)); return current
        }
        yield* Effect.sleep(100)
      }
      throw new Error("Installed Kimi Collector did not complete a cycle")
    }), () => stopManagedCollector().pipe(Effect.orDie))
    assert.equal((yield* inspectManagedCollector()).running, false)
    if (input.phase === "upgrade") { assert.equal(job.canonicalBatches, 0); assert.equal(job.rawChunks, 0) }
    observations = job.observations ?? 0
  } else {
    for (let cycle = 0; cycle < 5; cycle++) {
      const report = yield* runCollectionCycle(); failures += report.failures.length
      for (const job of report.jobs) { observations += job.observations; diagnostics += job.sourceFailures?.length ?? 0 }
      if (["malformed", "unsupported", "context-incomplete"].includes(input.phase)) { assert.ok(diagnostics > 0); break }
      if (lost || report.jobs.every(job => !job.hasMore)) break
      assert.ok(cycle < 4)
    }
  }
  if (["raw-only", "lose-activation"].includes(input.phase)) { assert.equal(lost, true); writeFileSync(join(home, "saved.jsonl"), readFileSync(file)) }
  if (["context-undo", "context-raw-loss"].includes(input.phase)) assert.equal(lost, true)
  if (input.phase === "context-recover-raw") assert.equal(uploads, 0)
  if (input.phase === "context-raw-on") { assert.equal(puts, 0); assert.ok(uploads > 0) }
  if (["noop", "raw-off", "recover-raw"].includes(input.phase)) assert.equal(uploads, 0)
  if (input.phase === "noop") { assert.equal(observations, 0); assert.equal(puts, 0) }
  if (input.phase === "raw-on") { assert.equal(puts, 0); assert.ok(uploads > 0) }
  const journals = yield* CaptureJournals, states = yield* CollectorStateStore
  const state = yield* states.snapshot(input.origin, input.userId, input.projectId, adapterId)
  const journal = yield* journals.open({ instanceOrigin: input.origin, userId: input.userId }, defaultSourceCollectionLimits.journal)
  assert.equal(state.installationId, journal.binding.installationId)
  const sources = yield* journal.sources(input.projectId, adapterId, { limit: 100 })
  assert.ok(sources.every(source => source.sourceSessionId !== "foreign-kimi-session"), "Foreign Project was captured")
  if (specimen === "native") assert.equal(sources.length, 1)
  const selected = sources.find(source => source.sourceSessionId === sourceId); assert.ok(selected)
  const owner = yield* journal.claim(selected), coverage = yield* journal.coverage(owner)
  const capture = (yield* journal.inspect(owner, coverage.canonicalCaptureId!, { kind: "canonical", limit: 1 })).capture
  const receipt = JSON.parse(capture.activationReceipt!) as { sessionId: string; head: string }
  const pending = yield* journal.pending(owner), records = yield* journal.records(owner, capture.id, { kind: "event", limit: 100 })
  return { ...receipt, checkpoint: owner.checkpoint, observations, failures, diagnostics, uploads, puts, pending: pending.length,
    records: records.map(row => ({ key: row.key, revision: row.revision, rawReference: row.rawReference })) }
}).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(Logger.layer([]))))
process.stdout.write(JSON.stringify(result))
