// Controlled native source + real installed CLI/Adapter against the Go HTTP contract.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { CaptureJournals, CLICredentialStore, CollectorStateStore, runCollectionCycle, installAdapter, planToolChange, applyToolChange, startManagedCollector, stopManagedCollector, inspectManagedCollector } from "@atape/application"
import { type StoredCLICredential } from "@atape/domain"
import { Effect, Layer, Logger } from "effect"
import { makeNodeClientLayer, defaultNodeClientPaths } from "../clientLayers.ts"
import { makeNodeCollectorDaemonLayer } from "../collectorDaemonLayers.ts"
import { defaultSourceCollectionLimits } from "@atape/application"

const input = JSON.parse(readFileSync(0, "utf8")) as { phase: string; origin: string; credential: string; userId: string; home: string; tarball: string; cliTarball: string; projectId: string; teamId: string }
const forkPhase = input.phase.startsWith("fork-"), forkId = "atape-codebuddy-nested-fork-21240"
const sourceId = forkPhase && input.phase !== "fork-foreign" ? forkId : "atape-codebuddy-native-21240", home = input.home, workspace = join(home, "workspace")
const forkWorkspace = join(home, "fork-workspace")
const sourceHome = join(home, "source"), directory = join(sourceHome, "projects", "opaque"), file = join(directory, `${sourceId}.jsonl`)
const paths = defaultNodeClientPaths({ ATAPE_HOME: join(home, "client") }), installed = join(home, "installed")
const binary = join(installed, "node_modules", "@atape", "cli", "dist", "atape.js")
const environment = { ...process.env, ATAPE_HOME: paths.atapeHome, ATAPE_CODEBUDDY_HOME: sourceHome,
  ATAPE_CODEX_HOME: join(home, "missing-codex"), ATAPE_CLAUDE_HOME: join(home, "missing-claude"), OPENCODE_DB: join(home, "missing-opencode"),
  ATAPE_DEVELOPMENT_ALLOW_HTTP: "true", ATAPE_COLLECTOR_DAEMON: "0", TEST_SECRET: "SENSITIVE_TEST_TOKEN" }
process.env.ATAPE_CODEBUDDY_HOME = sourceHome
const native = readFileSync(new URL("../../../../../adapters/codebuddy/src/fixtures/native-2.124.0.jsonl", import.meta.url), "utf8").replaceAll("/fixture/codebuddy-project", workspace)
const at = "2026-09-12T16:00:00Z", adapterId = "codebuddy"
const forkSource = readFileSync(new URL("../../../../../adapters/codebuddy/src/fixtures/native-nested-fork-2.124.0.jsonl", import.meta.url), "utf8")
  .replaceAll("/fixture/codebuddy-project", workspace).replaceAll("/fixture/codebuddy-fork-project", forkWorkspace)
const forkMeta = readFileSync(new URL("../../../../../adapters/codebuddy/src/fixtures/native-fork-2.124.0.meta.json", import.meta.url), "utf8")
const save = (rows: unknown[]) => writeFileSync(file, rows.map(row => JSON.stringify(row) + "\n").join(""))
if (input.phase === "initial") {
  mkdirSync(directory, { recursive: true }); mkdirSync(workspace); mkdirSync(paths.atapeHome, { recursive: true, mode: 0o700 })
  writeFileSync(file, native)
  // A valid foreign source must be discovered but excluded before capture.
  const foreign = native.replaceAll(sourceId, "foreign-codebuddy-session").replaceAll(workspace, join(home, "foreign-project"))
  mkdirSync(join(home, "foreign-project")); writeFileSync(join(directory, "foreign-codebuddy-session.jsonl"), foreign)
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installed, input.cliTarball], { cwd: home, stdio: "pipe", timeout: 120000 })
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ version: 3, toolsConfigured: true, enabledAdapterIds: [], adapters: [], projects: [{
    id: input.projectId, instanceOrigin: input.origin, userId: input.userId, teamId: input.teamId, teamSlug: "acme", teamName: "Fixture", name: "CodeBuddy", type: "directory", path: workspace, createdAt: at, adapterIds: [] }] }))
}
if (input.phase === "fork-foreign") {
  mkdirSync(forkWorkspace)
  writeFileSync(join(directory, `${forkId}.jsonl`), forkSource.trimEnd().split("\n").slice(0, 21).join("\n") + "\n")
  writeFileSync(join(directory, `${forkId}.meta.json`), forkMeta)
}
if (input.phase === "fork-initial") {
  const config = JSON.parse(readFileSync(paths.configFile, "utf8"))
  config.projects.push({ ...config.projects[0], id: input.projectId, name: "CodeBuddy fork", path: forkWorkspace })
  writeFileSync(paths.configFile, JSON.stringify(config))
}
if (input.phase === "fork-resume") writeFileSync(file, forkSource)
if (input.phase === "fork-invalid") writeFileSync(file.replace(/\.jsonl$/, ".meta.json"), '{"forkedFrom":"unrelated"}')
if (input.phase === "fork-repair") writeFileSync(file.replace(/\.jsonl$/, ".meta.json"), forkMeta)
if (input.phase === "fork-lost") {
  const values = forkSource.trimEnd().split("\n").map(line => JSON.parse(line))
  values.at(-1).content[0].text = "CodeBuddyForkFrozenNeedle"
  save(values)
}
if (input.phase === "fork-recover") { rmSync(file); rmSync(file.replace(/\.jsonl$/, ".meta.json")) }
if (["edit", "raw-off", "lose-activation", "raw-only"].includes(input.phase)) {
  const values = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line))
  if (input.phase === "edit") values.push(
    { id: "controlled-resume-user", parentId: values.at(-1).id, timestamp: 1789229300000, type: "message", role: "user", content: [{ type: "input_text", text: "CodeBuddyResumeNeedle SENSITIVE_TEST_TOKEN" }], sessionId: sourceId, cwd: workspace },
    { id: "controlled-resume-assistant", parentId: "controlled-resume-user", timestamp: 1789229300001, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "CodeBuddyResumeAnswer" }], sessionId: sourceId, cwd: workspace })
  if (input.phase === "raw-off") values.at(-1).content[0].text = "CodeBuddyPolicyNeedle"
  if (input.phase === "lose-activation") values.at(-1).content[0].text = "CodeBuddyFinalNeedle"
  if (input.phase === "raw-only") values.at(-1).extraRawField = "CodeBuddyRawOnlyNeedle"
  save(values)
}
if (input.phase === "recover-activation" || input.phase === "recover-raw") rmSync(file)
if (input.phase === "restore") {
  const saved = readFileSync(join(home, "saved.jsonl"), "utf8"); writeFileSync(file, saved)
}
if (input.phase === "malformed") writeFileSync(file, readFileSync(file, "utf8") + "unfinished")
if (input.phase === "repair") writeFileSync(file, readFileSync(join(home, "saved.jsonl"), "utf8"))
let lost = false, uploads = 0, puts = 0
const faultFetch: typeof fetch = async (url, init) => {
  const response = await fetch(url, init), target = String(url)
  if (init?.method === "PUT" && target.includes("/publications/attempts/")) puts++
  if (target.endsWith("/ingestion/raw/chunks")) uploads++
  if (!lost && (["lose-activation", "fork-lost"].includes(input.phase) && target.endsWith("/activate") && response.status === 200 || input.phase === "raw-only" && target.endsWith("/ingestion/raw/chunks") && response.status === 201)) {
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
    const config = JSON.parse(readFileSync(paths.configFile, "utf8"))
    const slot = config.adapters.find((item: { adapterId: string }) => item.adapterId === adapterId)
    const fixture = join(home, "replacement")
    // Selected immutable package location is recorded by the management Interface.
    assert.ok(typeof slot.packageSlot === "string", "Installed package slot must be inspectable")
    cpSync(join(paths.adapterDirectory, "slots", slot.packageSlot, "node_modules", "@atape", "adapter-codebuddy"), fixture, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(fixture, "package.json"), "utf8")); manifest.version += "-codebuddy-replacement"
    writeFileSync(join(fixture, "package.json"), JSON.stringify(manifest))
    const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", home], { cwd: fixture, encoding: "utf8" }))
    assert.equal((yield* installAdapter(join(home, packed[0].filename))).adapter.version, manifest.version)
  }
  let observations = 0, failures = 0, diagnostics = 0
  // The console's Module Interfaces own setup; collection runs in the installed
  // executable. Every phase stops its owned process before inspecting the journal.
  if (["initial", "upgrade", "fork-initial", "fork-resume"].includes(input.phase)) {
    const before = (yield* inspectManagedCollector()).lastCycleCompletedAt
    const job = yield* Effect.acquireUseRelease(
      startManagedCollector({ intervalMs: 10000, concurrency: 1 }),
      () => Effect.gen(function*() {
        for (let attempt = 0; attempt < 200; attempt++) {
          const status = yield* inspectManagedCollector()
          assert.ok(status.running, "Installed Collector exited")
          assert.equal(status.collectorFailure, undefined)
          const current = status.jobs.find(job => job.adapterId === adapterId && job.projectId === input.projectId)
          if (status.lastCycleCompletedAt && status.lastCycleCompletedAt !== before && current && !current.hasMore) {
            assert.equal(current.state, "healthy", JSON.stringify(current))
            return current
          }
          yield* Effect.sleep(100)
        }
        throw new Error("Installed CodeBuddy Collector did not complete a cycle")
      }),
      () => stopManagedCollector().pipe(Effect.orDie)
    )
    assert.equal((yield* inspectManagedCollector()).running, false)
    if (input.phase === "upgrade") { assert.equal(job.canonicalBatches, 0); assert.equal(job.rawChunks, 0) }
    observations = job.observations ?? 0
  } else {
    for (let cycle = 0; cycle < 5; cycle++) {
      const report = yield* runCollectionCycle()
      failures += report.failures.length
      for (const job of report.jobs) { observations += job.observations; diagnostics += job.sourceFailures?.length ?? 0 }
      if (["malformed", "fork-invalid"].includes(input.phase)) { assert.ok(diagnostics > 0); break }
      if (lost || report.jobs.every(job => !job.hasMore)) break
      assert.ok(cycle < 4)
    }
  }
  if (["raw-only", "lose-activation"].includes(input.phase)) { assert.equal(lost, true); writeFileSync(join(home, "saved.jsonl"), readFileSync(file)) }
  if (input.phase === "fork-lost") assert.equal(lost, true)
  if (["noop", "raw-off", "recover-raw"].includes(input.phase)) assert.equal(uploads, 0)
  if (input.phase === "noop") { assert.equal(observations, 0); assert.equal(puts, 0) }
  if (input.phase === "raw-on") { assert.equal(puts, 0); assert.ok(uploads > 0) }
  const journals = yield* CaptureJournals, states = yield* CollectorStateStore
  const state = yield* states.snapshot(input.origin, input.userId, input.projectId, adapterId)
  const journal = yield* journals.open({ instanceOrigin: input.origin, userId: input.userId }, defaultSourceCollectionLimits.journal)
  assert.equal(state.installationId, journal.binding.installationId)
  const sources = yield* journal.sources(input.projectId, adapterId, { limit: 100 })
  assert.equal(sources.length, 1, "Foreign Project was captured")
  assert.equal(sources[0]!.sourceSessionId, sourceId)
  const owner = yield* journal.claim(sources[0]!), coverage = yield* journal.coverage(owner)
  const capture = (yield* journal.inspect(owner, coverage.canonicalCaptureId!, { kind: "canonical", limit: 1 })).capture
  const receipt = JSON.parse(capture.activationReceipt!) as { sessionId: string; head: string }
  const pending = yield* journal.pending(owner)
  const records = yield* journal.records(owner, capture.id, { kind: "event", limit: 100 })
  return { ...receipt, checkpoint: owner.checkpoint, observations, failures, diagnostics, uploads, puts, pending: pending.length,
    records: records.map(row => ({ key: row.key, revision: row.revision, rawReference: row.rawReference })) }
}).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(Logger.layer([]))))
process.stdout.write(JSON.stringify(result))
