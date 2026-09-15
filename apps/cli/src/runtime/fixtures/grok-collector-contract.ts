// Controlled Grok native source and actual installed CLI/Adapter over authenticated HTTP.
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
const modernPhase = input.phase.startsWith("modern-"), casePhase = modernPhase ? input.phase.slice(7) : input.phase
const compactPhase = casePhase.startsWith("compact-"), nestedPhase = casePhase.startsWith("nested-"), forkPhase = nestedPhase || casePhase.startsWith("fork-")
const phase = compactPhase ? casePhase.slice(8) : nestedPhase ? casePhase.slice(7) : forkPhase ? casePhase.slice(5) : casePhase
const gitPhase = phase.startsWith("git-"), toolsPhase = phase.startsWith("tools-")
const sourceId = compactPhase ? "f1e31225-e22f-431b-88bc-73e270e6d45c" : nestedPhase ? (modernPhase ? "bad9620c-089d-472f-af1f-f36f5dc65d31" : "1edcf769-dc72-4253-8513-f266e62317b3") : forkPhase ? (modernPhase ? "f8938b1c-c9ac-498c-8920-b870682353c4" : "3480cfb1-f675-4b6e-80bc-b7adf55b8bee") : gitPhase ? "01a0988a-e389-73f0-a5d6-fcd91c1f822b" : toolsPhase ? "88789e9d-9240-47c6-8a89-0842fc706348" : "01a0987a-554b-7073-934d-da914245adbf"
const caseName = compactPhase ? "compact" : nestedPhase ? "nested" : forkPhase ? "fork" : gitPhase ? "git" : toolsPhase ? "tools" : undefined
const home = caseName ? join(input.home, `${modernPhase ? "modern-" : ""}${caseName}-case`) : input.home, workspace = join(home, "workspace")
const initialStage = compactPhase ? "compact-context" : nestedPhase ? (modernPhase ? "nested" : "fork-nested") : forkPhase ? (modernPhase ? "fork" : "fork-created") : toolsPhase ? "edit" : "resumed"
const resumedStage = compactPhase ? "compact-success-resumed" : nestedPhase ? (modernPhase ? "nested-resumed" : "fork-nested-resumed") : forkPhase ? "fork-resumed" : "shell"
const nativeVersion = modernPhase || compactPhase ? "1.0.30" : "1.0.3"
const worktree = join(home, "worktree")
const sourceHome = join(home, "source"), directory = join(sourceHome, "sessions", "opaque", sourceId), file = join(directory, "updates.jsonl")
const paths = defaultNodeClientPaths({ ATAPE_HOME: join(home, "client") }), installed = join(home, "installed")
const binary = join(installed, "node_modules", "@atape", "cli", "dist", "atape.js")
const environment = { ...process.env, ATAPE_HOME: paths.atapeHome, ATAPE_GROK_HOME: sourceHome,
  ATAPE_KIMI_HOME: join(home, "missing-kimi"), ATAPE_CODEX_HOME: join(home, "missing-codex"), ATAPE_CLAUDE_HOME: join(home, "missing-claude"), ATAPE_CODEBUDDY_HOME: join(home, "missing-codebuddy"), OPENCODE_DB: join(home, "missing-opencode"),
  ATAPE_DEVELOPMENT_ALLOW_HTTP: "true", ATAPE_COLLECTOR_DAEMON: "0", TEST_SECRET: "SENSITIVE_TEST_TOKEN" }
process.env.ATAPE_GROK_HOME = sourceHome
const at = "2026-09-13T00:00:00Z", adapterId = "grok"
const writeNative = (stage: string, dest = directory, id = sourceId, cwd = workspace) => {
  mkdirSync(dest, { recursive: true })
  for (const name of ["summary.json", "signals.json", "updates.jsonl"]) {
    const native = readFileSync(new URL(`../../../../../adapters/grok/src/fixtures/native-${nativeVersion}/${stage}/${name}`, import.meta.url), "utf8")
    writeFileSync(join(dest, name), native.replaceAll("/fixture/grok-1030/project", cwd).replaceAll("/fixture/grok-compact/project", cwd).replaceAll("/fixture/grok-fork/project", cwd).replaceAll("/fixture/grok-project", cwd).replaceAll("/fixture/grok-worktree", cwd).replaceAll("/fixture/grok-edit", cwd).replaceAll(sourceId, id))
  }
}
if (phase === "initial" || phase === "git-initial" || phase === "tools-initial") {
  mkdirSync(workspace, { recursive: true }); mkdirSync(paths.atapeHome, { recursive: true, mode: 0o700 })
  if (gitPhase) {
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })
    git(workspace, "init"); git(workspace, "remote", "add", "origin", "https://github.com/atape-fixtures/grok-native.git")
    writeFileSync(join(workspace, "marker.txt"), "Controlled worktree")
    git(workspace, "add", "marker.txt"); git(workspace, "-c", "user.name=ATape Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture")
    git(workspace, "worktree", "add", "-b", "fixture-worktree", worktree)
    writeNative("worktree", directory, sourceId, worktree)
    const foreign = "01a0988a-e389-73f0-a5d6-fcd91c1f822c", cwd = join(home, "foreign-project"); mkdirSync(cwd)
    git(cwd, "init"); git(cwd, "remote", "add", "origin", "https://github.com/atape-fixtures/other.git")
    writeNative("worktree", join(sourceHome, "sessions", "foreign", foreign), foreign, cwd)
  } else {
    writeNative(initialStage)
    const foreign = "01a0987a-554b-7073-934d-da914245adbe", cwd = join(home, "foreign-project"); mkdirSync(cwd)
    writeNative(initialStage, join(sourceHome, "sessions", "foreign", foreign), foreign, cwd)
  }
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installed, input.cliTarball], { cwd: home, stdio: "pipe", timeout: 120000 })
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ version: 3, toolsConfigured: true, enabledAdapterIds: [], adapters: [], projects: [{
    id: input.projectId, instanceOrigin: input.origin, userId: input.userId, teamId: input.teamId, teamSlug: "grok-contract", teamName: "Fixture", name: "Grok", type: gitPhase ? "git" : "directory", path: workspace, createdAt: at, adapterIds: [] }] }))
}
if (phase === "tools-initial") {
  const rows = readFileSync(file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
  // Synthetic marker exists only in search output, encoded as native bytes.
  rows[3].params.update.rawOutput.stdout.push(...Buffer.from("\nGrokSearchOutputNeedle SENSITIVE_TEST_TOKEN"))
  writeFileSync(file, rows.map(row => JSON.stringify(row) + "\n").join(""))
}
if (phase === "git-relocated") {
  rmSync(workspace, { recursive: true }); rmSync(worktree, { recursive: true })
  const rows = readFileSync(file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
  rows.find(row => row.params.update.sessionUpdate === "agent_message_chunk").params.update.content.text = "GrokGitMovedNeedle"
  writeFileSync(file, rows.map(row => JSON.stringify(row) + "\n").join(""))
}
if (phase === "edit") writeNative(resumedStage)
if (["edit", "raw-off", "lose-activation", "raw-only"].includes(phase)) {
  const rows = readFileSync(file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
  const last = rows.findLast(row => row.params.update.sessionUpdate === "agent_message_chunk")
  if (phase === "edit") rows.findLast(row => row.params.update.sessionUpdate === "user_message_chunk").params.update.content.text += " GrokResumeNeedle SENSITIVE_TEST_TOKEN"
  if (phase === "raw-off") last.params.update.content.text = "GrokPolicyNeedle"
  if (phase === "lose-activation") last.params.update.content.text = "GrokFinalNeedle"
  if (phase === "raw-only") last.extraRawField = "GrokRawOnlyNeedle"
  writeFileSync(file, rows.map(row => JSON.stringify(row) + "\n").join(""))
}
if (["recover-activation", "recover-raw"].includes(phase)) rmSync(directory, { recursive: true })
if (["restore", "repair"].includes(phase)) {
  writeNative(resumedStage); writeFileSync(file, readFileSync(join(home, "saved.jsonl")))
}
if (phase === "unsupported") {
  const rows = readFileSync(file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
  if (compactPhase) rows.find(row => row.params.update.sessionUpdate === "compaction_checkpoint").params.update.prompt_index_at_compaction = 999
  else rows[1].params._meta.eventId = sourceId + "-4"
  writeFileSync(file, rows.map(row => JSON.stringify(row) + "\n").join(""))
}
if (phase === "malformed") writeFileSync(file, readFileSync(file, "utf8") + "unfinished")
let lost = false, uploads = 0, puts = 0
const faultFetch: typeof fetch = async (url, init) => {
  const response = await fetch(url, init), target = String(url)
  if (init?.method === "PUT" && target.includes("/publications/attempts/")) puts++
  if (target.endsWith("/ingestion/raw/chunks")) uploads++
  if (!lost && (["lose-activation"].includes(phase) && target.endsWith("/activate") && response.status === 200 || ["raw-only"].includes(phase) && target.endsWith("/ingestion/raw/chunks") && response.status === 201)) {
    lost = true; await response.arrayBuffer(); throw new TypeError("Controlled committed response loss")
  }
  return response
}
const layer = Layer.merge(makeNodeClientLayer(paths, environment, fetch, faultFetch), makeNodeCollectorDaemonLayer(paths, binary, environment))
const result = await Effect.runPromise(Effect.gen(function*() {
  if (phase === "initial" || phase === "git-initial" || phase === "tools-initial") {
    const credentials = yield* CLICredentialStore
    const credential: StoredCLICredential = { version: 1, instanceOrigin: input.origin, apiOrigin: input.origin, credential: input.credential,
      credentialId: "integration-credential", capabilityVersion: "atape-cli.v1", createdAt: at, user: { id: input.userId, displayName: "Fixture" } }
    yield* credentials.replace({ credential })
    assert.equal((yield* installAdapter(input.tarball)).adapter.adapterId, adapterId)
    yield* planToolChange([adapterId]).pipe(Effect.flatMap(applyToolChange))
  }
  if (phase === "upgrade") {
    const config = JSON.parse(readFileSync(paths.configFile, "utf8"))
    const slot = config.adapters.find((item: { adapterId: string }) => item.adapterId === adapterId)
    const fixture = join(home, "replacement")
    // Selected immutable package location is recorded by the management Interface.
    assert.ok(typeof slot.packageSlot === "string", "Installed package slot must be inspectable")
    cpSync(join(paths.adapterDirectory, "slots", slot.packageSlot, "node_modules", "@atape", "adapter-grok"), fixture, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(fixture, "package.json"), "utf8")); manifest.version += "-grok-replacement"
    writeFileSync(join(fixture, "package.json"), JSON.stringify(manifest))
    const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", home], { cwd: fixture, encoding: "utf8" }))
    assert.equal((yield* installAdapter(join(home, packed[0].filename))).adapter.version, manifest.version)
  }
  let observations = 0, failures = 0, diagnostics = 0
  // The console's Module Interfaces own setup; collection runs in the installed
  // executable. Every phase stops its owned process before inspecting the journal.
  if (["initial", "upgrade", "edit", "git-initial", "tools-initial"].includes(phase)) {
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
        throw new Error("Installed Grok Collector did not complete a cycle")
      }),
      () => stopManagedCollector().pipe(Effect.orDie)
    )
    assert.equal((yield* inspectManagedCollector()).running, false)
    if (phase === "upgrade") { assert.equal(job.canonicalBatches, 0); assert.equal(job.rawChunks, 0) }
    observations = job.observations ?? 0
  } else {
    for (let cycle = 0; cycle < 5; cycle++) {
      const report = yield* runCollectionCycle()
      failures += report.failures.length
      for (const job of report.jobs) { observations += job.observations; diagnostics += job.sourceFailures?.length ?? 0 }
      if (["malformed", "unsupported"].includes(phase)) { assert.ok(diagnostics > 0); break }
      if (lost || report.jobs.every(job => !job.hasMore)) break
      assert.ok(cycle < 4)
    }
  }
  if (["raw-only", "lose-activation"].includes(phase)) { assert.equal(lost, true); writeFileSync(join(home, "saved.jsonl"), readFileSync(file)) }
  if (["noop", "raw-off", "recover-raw"].includes(phase)) assert.equal(uploads, 0)
  if (phase === "noop") { assert.equal(observations, 0); assert.equal(puts, 0) }
  if (["raw-on", "tools-raw-on"].includes(phase)) { assert.equal(puts, 0); assert.ok(uploads > 0) }
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
