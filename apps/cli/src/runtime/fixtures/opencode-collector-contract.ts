// Executed by the authenticated Go/PostgreSQL contract in a fresh Node process
// for every phase. Only a controlled native fixture is read; credentials use stdin.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { CaptureJournals, CLICredentialStore, CollectorStateStore, runCollectionCycle } from "@atape/application"
import { type CanonicalBatch, type StoredCLICredential } from "@atape/domain"
import { Effect, Logger } from "effect"
import { makeNodeClientLayer, defaultNodeClientPaths } from "../clientLayers.ts"
import { sourceCollectionLimits } from "./source-collection-test-support.ts"

const limits = { ...sourceCollectionLimits, recovery: { ...sourceCollectionLimits.recovery, sourceMs: 5000 }, sourceWorkMs: 30000, cycleMs: 90000 }

const input = JSON.parse(readFileSync(0, "utf8")) as {
  phase: string; origin: string; credential: string; userId: string; journal: string; tarball: string; batch: CanonicalBatch
}
const native = JSON.parse(readFileSync(new URL("../../../../../adapters/opencode/src/fixtures/native-v1.json", import.meta.url), "utf8")) as {
  rootID: string; childID: string; forkID: string; ddl: string[]; rows: Record<string, Record<string, SQLInputValue>[]>
}
const home = dirname(input.journal), path = join(home, "source.db"), workspace = join(home, "workspace")
const paths = defaultNodeClientPaths({ ATAPE_HOME: join(home, "client") })
const adapterId = "opencode", packageName = "@atape/adapter-opencode", at = "2026-09-10T00:00:00Z", secret = "SENSITIVE_TEST_TOKEN"
process.env.OPENCODE_DB = path // The installed foreign runtime selects its native source from process environment.
const initialPart = native.rows.part!.find(row => row.session_id === native.rootID && JSON.parse(String(row.data)).type === "text")!
const secondMessage = native.rows.message!.filter(row => row.session_id === native.rootID)[1]!
const project = { id: input.batch.projectId, instanceOrigin: input.origin, userId: input.userId,
  teamId: "fixture", teamSlug: "fixture", teamName: "Fixture", name: "Native Collector", type: "directory" as const,
  path: workspace, createdAt: at, adapterIds: [adapterId] }
if (["initial", "daemon-source"].includes(input.phase)) {
  mkdirSync(workspace, { recursive: true })
  mkdirSync(paths.atapeHome, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  db.exec("PRAGMA foreign_keys=OFF") // The fixture contains only tables read by the source Interface.
  for (const ddl of native.ddl) db.exec(ddl)
  for (const [table, rows] of Object.entries(native.rows)) for (const row of rows) {
    const keys = Object.keys(row)
    db.prepare(`INSERT INTO "${table}" (${keys.map(key => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row))
  }
  db.prepare("UPDATE event SET data=json_set(data,'$.info.directory',?) WHERE type='session.created.1'").run(tmpdir())
  db.prepare("UPDATE event SET data=json_set(data,'$.info.directory',?) WHERE type='session.created.1' AND aggregate_id=?").run(workspace, native.rootID)
  db.prepare("UPDATE part SET data=json_set(data,'$.text',?) WHERE id=?").run(`${input.phase === "initial" ? "CollectorInitialNeedle" : "CollectorDaemonInitialNeedle"} ${secret}`, initialPart.id!)
  db.prepare("UPDATE part SET data=json_set(data,'$.text',?) WHERE session_id=? AND json_extract(data,'$.type')='text'").run("CollectorChildNeedle", native.childID)
  db.prepare("UPDATE part SET data=json_set(data,'$.text','CollectorSummaryNeedle ' || json_extract(data,'$.text')) WHERE session_id=? AND json_extract(data,'$.type')='text' AND message_id IN (SELECT id FROM message WHERE json_extract(data,'$.summary')=1)").run(native.rootID)
  db.prepare("UPDATE part SET data=json_set(data,'$.state.output',?,'$.state.metadata.output',?) WHERE session_id=? AND json_extract(data,'$.type')='tool'")
    .run(`CollectorToolNeedle ${secret}`, `CollectorToolNeedle ${secret}`, native.rootID)
  db.close()
}
if (input.phase === "initial") {
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", paths.adapterDirectory, input.tarball],
    { cwd: home, timeout: 120000, stdio: ["ignore", "pipe", "pipe"] })
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ version: 3, toolsConfigured: true, enabledAdapterIds: [adapterId], projects: [project],
    adapters: [{ adapterId, packageName, version: "0.0.0", displayName: "OpenCode", upgradeSpec: packageName, installedAt: at, updatedAt: at }] }))
}
if (input.phase === "recover-activation") {
  renameSync(path, `${path}.offline`); rmSync(workspace, { recursive: true })
}
if (input.phase === "raw-only") {
  renameSync(`${path}.offline`, path); mkdirSync(workspace)
}
if (input.phase === "recover-raw") { rmSync(path); rmSync(workspace, { recursive: true }) }
if (input.phase === "daemon-missing") rmSync(path)
if (["edit", "rewind", "unrevert", "fork", "raw-off", "lose-activation", "raw-only", "daemon-edit", "daemon-live-edit"].includes(input.phase)) {
  const db = new DatabaseSync(path)
  if (["edit", "raw-off", "lose-activation", "daemon-edit", "daemon-live-edit"].includes(input.phase)) {
    const needle = input.phase === "daemon-live-edit" ? "CollectorDaemonLiveNeedle" : input.phase === "daemon-edit" ? "CollectorDaemonUpdatedNeedle" : input.phase === "edit" ? "CollectorEditedNeedle" : input.phase === "raw-off" ? "CollectorPolicyNeedle" : "CollectorFinalNeedle"
    db.prepare("UPDATE part SET data=json_set(data,'$.text',?) WHERE id=?").run(`${needle} ${secret}`, initialPart.id!)
  }
  if (input.phase === "rewind") db.prepare("UPDATE session SET revert=? WHERE id=?").run(JSON.stringify({ messageID: secondMessage.id }), native.rootID)
  if (input.phase === "unrevert") db.prepare("UPDATE session SET revert=NULL WHERE id=?").run(native.rootID)
  if (input.phase === "fork") db.prepare("UPDATE event SET data=json_set(data,'$.info.directory',?) WHERE type='session.created.1' AND aggregate_id=?").run(workspace, native.forkID)
  if (input.phase === "raw-only") db.prepare("UPDATE part SET data=json_set(data,'$.freshArchive',?) WHERE id=?").run("CollectorFreshRawNeedle", initialPart.id!)
  db.close()
}
if (["daemon-source", "daemon-edit", "daemon-live-edit", "daemon-missing"].includes(input.phase)) {
  // Control only the external source. The installed CLI owns all collection.
  process.stdout.write(JSON.stringify({ atapeHome: paths.atapeHome, sourcePath: path, sourceLimits: limits }))
  process.exit(0)
}

let lost = false, uploads = 0, contentPuts = 0
const faultFetch: typeof fetch = async (url, init) => {
  const response = await fetch(url, init), target = String(url)
  if (init?.method === "PUT" && target.includes("/publications/attempts/")) contentPuts++
  if (target.endsWith("/ingestion/raw/chunks")) {
    uploads++
    if (input.phase === "raw-only" && !lost && response.status === 201) {
      lost = true; await response.arrayBuffer(); throw new TypeError("Controlled committed Raw response loss")
    }
  }
  if (input.phase === "lose-activation" && !lost && target.endsWith("/activate") && response.status === 200) {
    lost = true; await response.arrayBuffer(); throw new TypeError("Controlled committed activation response loss")
  }
  return response
}
const layer = makeNodeClientLayer(paths, { ATAPE_DEVELOPMENT_ALLOW_HTTP: "true", ATAPE_SOURCE_COLLECTION_LIMITS: JSON.stringify(limits), TEST_SECRET: secret }, fetch, faultFetch)
const result = await Effect.runPromise(Effect.gen(function*() {
  if (input.phase === "initial") {
    const credentials = yield* CLICredentialStore
    const stored: StoredCLICredential = { version: 1, instanceOrigin: input.origin, apiOrigin: input.origin,
      credential: input.credential, credentialId: "integration-credential", capabilityVersion: "atape-cli.v1", createdAt: at,
      user: { id: input.userId, displayName: "Fixture" } }
    yield* credentials.replace({ credential: stored })
  }
  let observations = 0, events = 0, failures = 0
  const missing = input.phase.startsWith("recover-")
  for (let cycle = 0; cycle < (input.phase === "daemon-snapshot" ? 0 : 10); cycle++) {
    const report = yield* runCollectionCycle()
    failures += report.failures.length
    if (!missing) assert.deepEqual(report.failures, [])
    for (const job of report.jobs) {
      observations += job.observations; events += job.canonicalEvents ?? 0
      if (!["raw-only", "lose-activation"].includes(input.phase)) assert.deepEqual(job.sourceFailures, [])
    }
    if (missing) {
      const settled = yield* Effect.scoped(Effect.gen(function*() {
        const factory = yield* CaptureJournals
        const journal = yield* factory.open({ instanceOrigin: input.origin, userId: input.userId }, limits.journal)
        for (const scope of yield* journal.sources(project.id, adapterId, { limit: 100 })) {
          if ((yield* journal.pending(yield* journal.claim(scope))).length > 0) return false
        }
        return true
      }))
      if (settled) break
    } else if (report.jobs.every(job => !job.hasMore)) break
    assert.ok(cycle < 9, "Discovery did not finish within its fixture bound")
  }
  if (["raw-only", "lose-activation"].includes(input.phase)) assert.equal(lost, true)
  if (missing) assert.ok(failures >= 1)
  if (input.phase === "recover-raw") assert.equal(uploads, 0)
  if (input.phase === "noop") { assert.equal(observations, 0); assert.equal(contentPuts, 0); assert.equal(uploads, 0) }
  if (input.phase === "raw-off") assert.equal(uploads, 0)
  if (["raw-on", "raw-only"].includes(input.phase)) { assert.equal(observations, 1); assert.equal(contentPuts, 0); assert.ok(uploads > 0) }
  const factory = yield* CaptureJournals, states = yield* CollectorStateStore
  const snapshot = yield* states.snapshot(input.origin, input.userId, project.id, adapterId)
  const journal = yield* factory.open({ instanceOrigin: input.origin, userId: input.userId }, limits.journal)
  assert.equal(snapshot.installationId, journal.binding.installationId)
  const scopes = yield* journal.sources(project.id, adapterId, { limit: 100 })
  assert.ok(scopes.length >= 1)
  const owner = yield* journal.claim(scopes.find(scope => scope.sourceSessionId === native.rootID)!)
  const coverage = yield* journal.coverage(owner)
  const capture = (yield* journal.inspect(owner, coverage.canonicalCaptureId!, { kind: "canonical", limit: 1 })).capture
  const receipt = JSON.parse(capture.activationReceipt!) as { sessionId: string; head: string }
  const records = yield* journal.records(owner, capture.id, { kind: "event", limit: 100 })
  const pending = yield* journal.pending(owner)
  if (missing) assert.equal(pending.length, 0)
  if (["raw-only", "lose-activation"].includes(input.phase)) assert.ok(pending.length > 0)
  const rawCoverage = coverage.observedRawCaptureId === null ? [] : yield* journal.records(owner, coverage.observedRawCaptureId, { kind: "raw", limit: 100 })
  const forkScope = scopes.find(scope => scope.sourceSessionId === native.forkID)
  let forkSessionId: string | null = null
  if (forkScope !== undefined) {
    const forkOwner = yield* journal.claim(forkScope), forkCoverage = yield* journal.coverage(forkOwner)
    const fork = (yield* journal.inspect(forkOwner, forkCoverage.canonicalCaptureId!, { kind: "canonical", limit: 1 })).capture
    forkSessionId = (JSON.parse(fork.activationReceipt!) as { sessionId: string }).sessionId
  }
  return { ...receipt, forkSessionId, checkpoint: owner.checkpoint, observations, events, uploads, contentPuts, failures,
    rawCaptureId: coverage.observedRawCaptureId, pending: pending.length,
    records: records.map(record => ({ key: record.key, revision: record.revision, rawReference: record.rawReference })),
    rawComplete: rawCoverage.every(record => record.disposition === "acknowledged" || record.disposition === "unavailable") }
}).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(Logger.layer([]))))
process.stdout.write(JSON.stringify(result))
