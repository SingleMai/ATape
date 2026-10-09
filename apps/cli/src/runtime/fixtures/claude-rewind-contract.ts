// Installed factory/Collector migration. Native snapshots are copied literally;
// the explicitly named generated appends are transport/recovery test data.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { CaptureJournals, CLICredentialStore, CollectorStateStore, defaultSourceCollectionLimits,
  installAdapter, planToolChange, applyToolChange, startManagedCollector, stopManagedCollector, inspectManagedCollector } from "@atape/application"
import type { StoredCLICredential } from "@atape/domain"
import { Effect, Layer, Logger } from "effect"
import { makeNodeClientLayer, defaultNodeClientPaths } from "../clientLayers.ts"
import { makeNodeCollectorDaemonLayer } from "../collectorDaemonLayers.ts"

const input = JSON.parse(readFileSync(0, "utf8")) as {
  phase: string; origin: string; credential: string; userId: string; home: string;
  tarball: string; legacyTarball: string; cliTarball: string; projectId: string; teamId: string
}
const phases = ["legacy-seed", "migration-lost-activate", "recover-deleted", "restored-idle", "retained-progress", "repair-child",
  "native-continue", "root-invalid", "root-repair", "raw-backfill", "abandon-child-and-empty", "abandoned-raw-backfill",
  "empty-idle", "fresh-after-empty", "final-idle", "native-compact-seed", "native-compact-continue", "native-compact-idle",
  "background-running", "background-child-only", "background-retained-progress", "background-retained-idle",
  "background-completed", "background-raw-backfill", "background-rewind", "background-rewind-idle"]
assert.ok(phases.includes(input.phase), "Unknown rewind contract phase")
const legacy = input.phase === "legacy-seed", adapterId = "claude"
const workspace = join(input.home, "workspace"), sourceHome = join(input.home, "source")
const directory = join(sourceHome, "projects", "opaque-native-project"), hidden = join(input.home, "temporarily-deleted-source")
const controlId = "739c7fd0-4b82-46e6-b77a-ca836df2294d", resumeId = "3a13403f-ab2d-4eed-9f2f-392e0dfe2a83"
const familyId = "4e028c9c-9c9f-4d2b-afb5-f58d1950b6ac", agentId = "aa2bb7928384f99e7"
const control = join(directory, `${controlId}.jsonl`), resume = join(directory, `${resumeId}.jsonl`)
const family = join(directory, `${familyId}.jsonl`), child = join(directory, familyId, "subagents", `agent-${agentId}.jsonl`)
const compact = join(directory, "2197a21d-e447-4ce2-bb24-4ae0c75b2c9d.jsonl")
const backgroundId = "2a7f13b3-532e-40ec-a959-41210525d00f", backgroundAgent = "a8722069f7a6392c3"
const background = join(directory, `${backgroundId}.jsonl`)
const backgroundChild = join(directory, backgroundId, "subagents", `agent-${backgroundAgent}.jsonl`)
const fixtures = new URL("../../../../../adapters/claude/fixtures/", import.meta.url)
const snapshot = (file: string) => readFileSync(new URL(`native-rewind-2.1.263/${file}`, fixtures), "utf8")
  .replaceAll("/atape/fixture/claude-rewind", workspace)
const familySnapshot = (file: string) => readFileSync(new URL(`native-thinking-2.1.263/${file}`, fixtures), "utf8")
  .replaceAll("/fixture/native-thinking", workspace)
// These are literal complete-LF prefixes of the retained native files, not
// additional simultaneous observations of Claude's two independently written files.
const backgroundSnapshot = (file: string, lines?: number) => {
  const source = readFileSync(new URL(`native-background-child-2.1.263/${file}`, fixtures), "utf8")
    .replaceAll("/fixture/native-background-child/workspace", workspace)
  assert.ok(source.endsWith("\n"))
  return lines === undefined ? source : source.split("\n").slice(0, lines).join("\n") + "\n"
}
const replaceSnapshot = (file: string, next: string) => {
  assert.ok(next.startsWith(readFileSync(file, "utf8")), "Native snapshot changed an acknowledged physical prefix")
  writeFileSync(file, next)
}
type Row = Record<string, any>
const rows = (file: string): Row[] => readFileSync(file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
const append = (file: string, values: Row[]) => appendFileSync(file, values.map(row => JSON.stringify(row) + "\n").join(""))
const generatedReply = (slot: string) => {
  const source = rows(family), template = source.find(row => row.type === "assistant")!, last = source.findLast(row => row.uuid)!
  append(family, [{ ...template, uuid: `generated-rewind-${slot}`, parentUuid: last.uuid, timestamp: "2026-10-09T12:00:00Z",
    message: { ...template.message, id: `msg_generated_rewind_${slot}`, stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: `ATAPE_GENERATED_THOUGHT_${slot}: SENSITIVE_TEST_TOKEN`, signature: "ATAPE_PRIVATE_SIGNATURE" },
        { type: "text", text: `ATAPE_GENERATED_VISIBLE_${slot}: current root continues.` }],
      usage: { input_tokens: 19, output_tokens: 11, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }])
}
const paths = defaultNodeClientPaths({ ATAPE_HOME: join(input.home, "client") })
const installed = join(input.home, "installed"), binary = join(installed, "node_modules", "@atape", "cli", "dist", "atape.js")
const at = "2026-10-09T00:00:00Z"
const environment = { ...process.env, ATAPE_HOME: paths.atapeHome, ATAPE_CLAUDE_HOME: sourceHome, ATAPE_CLAUDE_SESSION_FILE: "",
  ATAPE_CODEX_HOME: join(input.home, "missing-codex"), ATAPE_KIMI_HOME: join(input.home, "missing-kimi"),
  ATAPE_GROK_HOME: join(input.home, "missing-grok"), ATAPE_CODEBUDDY_HOME: join(input.home, "missing-codebuddy"),
  OPENCODE_DB: join(input.home, "missing-opencode"), ATAPE_DEVELOPMENT_ALLOW_HTTP: "true", ATAPE_COLLECTOR_DAEMON: "0",
  TEST_SECRET: "SENSITIVE_TEST_TOKEN" }
process.env.ATAPE_CLAUDE_HOME = sourceHome; process.env.ATAPE_CLAUDE_SESSION_FILE = ""
if (legacy) {
  mkdirSync(workspace, { recursive: true }); mkdirSync(dirname(child), { recursive: true })
  writeFileSync(control, snapshot("control-02-discarded.jsonl")); writeFileSync(resume, snapshot("resume-02-discarded-0.jsonl"))
  writeFileSync(family, familySnapshot(`${familyId}.jsonl`)); writeFileSync(child, familySnapshot(`${familyId}/subagents/agent-${agentId}.jsonl`))
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installed, input.cliTarball],
    { cwd: input.home, stdio: "pipe", timeout: 120000 })
  mkdirSync(dirname(paths.configFile), { recursive: true, mode: 0o700 })
  writeFileSync(paths.configFile, JSON.stringify({ version: 3, toolsConfigured: true, enabledAdapterIds: [], adapters: [], projects: [{
    id: input.projectId, instanceOrigin: input.origin, userId: input.userId, teamId: input.teamId, teamSlug: "claude-rewind-contract",
    teamName: "Claude rewind contract", name: "Claude rewind", type: "directory", path: workspace, createdAt: at, adapterIds: [] }] }))
}
if (input.phase === "migration-lost-activate") {
  replaceSnapshot(control, snapshot("control-03-rewind-only.jsonl")); replaceSnapshot(resume, snapshot("resume-03-rewound-0.jsonl"))
  renameSync(child, join(input.home, "retained-child.jsonl")); generatedReply("migration")
}
if (input.phase === "recover-deleted") renameSync(directory, hidden)
if (input.phase === "restored-idle") renameSync(hidden, directory)
if (input.phase === "retained-progress") generatedReply("retained")
if (input.phase === "repair-child") renameSync(join(input.home, "retained-child.jsonl"), child)
if (input.phase === "native-continue") {
  replaceSnapshot(control, snapshot("control-04-current.jsonl")); replaceSnapshot(resume, snapshot("resume-04-continued-0.jsonl"))
}
if (input.phase === "root-invalid") {
  writeFileSync(join(input.home, "control-before-invalid.jsonl"), readFileSync(control))
  append(control, [{ type: "last-prompt", sessionId: controlId, leafUuid: "generated-unproved-selector", explicit: true, rewound: true }])
}
if (input.phase === "root-repair") writeFileSync(control, readFileSync(join(input.home, "control-before-invalid.jsonl")))
// Keep the family's first sourceCapture Raw observation until after its child
// leaves the selected path. Existing legacy Raw links remain independent.
if (input.phase === "raw-backfill") renameSync(family, join(input.home, "family-before-abandon.jsonl"))
if (input.phase === "abandon-child-and-empty") {
  renameSync(join(input.home, "family-before-abandon.jsonl"), family)
  replaceSnapshot(control, snapshot("control-05-empty-rewind.jsonl"))
  append(family, [{ type: "last-prompt", sessionId: familyId, leafUuid: rows(family).find(row => row.uuid)!.uuid, explicit: true, rewound: true }])
}
if (input.phase === "fresh-after-empty") {
  const source = rows(control), user = source.find(row => row.type === "user")!, assistant = source.find(row => row.type === "assistant")!
  append(control, [{ ...user, uuid: "generated-after-empty-user", parentUuid: null, timestamp: "2026-10-09T12:05:00Z",
    message: { role: "user", content: "ATAPE_GENERATED_AFTER_EMPTY_USER" } },
  { ...assistant, uuid: "generated-after-empty-assistant", parentUuid: "generated-after-empty-user", timestamp: "2026-10-09T12:05:01Z",
    message: { ...assistant.message, id: "msg_generated_after_empty", stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "ATAPE_GENERATED_AFTER_EMPTY_THOUGHT: SENSITIVE_TEST_TOKEN", signature: "ATAPE_PRIVATE_SIGNATURE" },
        { type: "text", text: "ATAPE_GENERATED_AFTER_EMPTY_VISIBLE" }],
      usage: { input_tokens: 12, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }])
}
if (input.phase === "native-compact-seed") writeFileSync(compact,
  readFileSync(new URL("native-manual-compact-2.1.263/before.jsonl", fixtures), "utf8").replaceAll("/fixture/native-manual-compact", workspace))
if (input.phase === "native-compact-continue") replaceSnapshot(compact,
  readFileSync(new URL("native-manual-compact-2.1.263/continued.jsonl", fixtures), "utf8").replaceAll("/fixture/native-manual-compact", workspace))
if (input.phase === "background-running") {
  mkdirSync(dirname(backgroundChild), { recursive: true })
  writeFileSync(background, backgroundSnapshot("root.jsonl", 10)); writeFileSync(backgroundChild, backgroundSnapshot("child.jsonl", 5))
}
if (input.phase === "background-child-only") {
  const original = readFileSync(background)
  replaceSnapshot(backgroundChild, backgroundSnapshot("child.jsonl"))
  assert.deepEqual(readFileSync(background), original, "Child-only append must leave the parent physical bytes unchanged")
}
if (input.phase === "background-retained-progress") {
  renameSync(backgroundChild, join(input.home, "retained-background-child.jsonl"))
  replaceSnapshot(background, backgroundSnapshot("root.jsonl", 18))
}
if (input.phase === "background-completed") {
  renameSync(join(input.home, "retained-background-child.jsonl"), backgroundChild)
  replaceSnapshot(background, backgroundSnapshot("root.jsonl"))
}
if (input.phase === "background-rewind") append(background, [{ type: "last-prompt", sessionId: backgroundId,
  leafUuid: rows(background).find(row => row.type === "user")!.uuid, explicit: true, rewound: true }])
const layer = Layer.merge(makeNodeClientLayer(paths, environment), makeNodeCollectorDaemonLayer(paths, binary, environment))
const result = await Effect.runPromise(Effect.gen(function*() {
  if (legacy) {
    const credentials = yield* CLICredentialStore
    const credential: StoredCLICredential = { version: 1, instanceOrigin: input.origin, apiOrigin: input.origin, credential: input.credential,
      credentialId: "claude-rewind-credential", capabilityVersion: "atape-cli.v1", createdAt: at, user: { id: input.userId, displayName: "Claude rewind fixture" } }
    yield* credentials.replace({ credential })
    assert.equal((yield* installAdapter(input.legacyTarball)).adapter.adapterId, adapterId)
    yield* planToolChange([adapterId]).pipe(Effect.flatMap(applyToolChange))
  }
  if (input.phase === "migration-lost-activate") assert.equal((yield* installAdapter(input.tarball)).adapter.adapterId, adapterId)
  const before = (yield* inspectManagedCollector()).lastCycleCompletedAt
  const job = yield* Effect.acquireUseRelease(startManagedCollector({ intervalMs: 10000, concurrency: 1 }),
    () => Effect.gen(function*() {
      for (let attempt = 0; attempt < 600; attempt++) {
        const status = yield* inspectManagedCollector()
        assert.ok(status.running, "Installed rewind Collector exited")
        assert.equal(status.collectorFailure, undefined)
        const current = status.jobs.find(job => job.adapterId === adapterId && job.projectId === input.projectId)
        if (status.lastCycleCompletedAt && status.lastCycleCompletedAt !== before && current && !current.hasMore) return current
        yield* Effect.sleep(100)
      }
      throw new Error("Installed rewind Collector did not finish a bounded cycle")
    }), () => stopManagedCollector().pipe(Effect.orDie))
  assert.equal((yield* inspectManagedCollector()).running, false)
  const state = yield* (yield* CollectorStateStore).snapshot(input.origin, input.userId, input.projectId, adapterId)
  assert.ok(state.checkpoint?.cursor); assert.equal(state.checkpoint.canonicalPublished, true)
  const cursor = state.checkpoint.cursor
  const checkpointDigest = createHash("sha256").update(cursor).digest("hex")
  const pending: Array<{ sourceId: string; state: string; activated: boolean; canonicalUnits: number; rawUnits: number }> = []
  let frozenLegacyDigest: string | undefined
  if (!legacy) {
    assert.equal(JSON.parse(cursor).protocol, "atape.source-collector.v1")
    assert.deepEqual(state.checkpoint.rawObjects, [])
    const journal = yield* (yield* CaptureJournals).open({ instanceOrigin: input.origin, userId: input.userId }, defaultSourceCollectionLimits.journal)
    const frozen = yield* journal.legacyMigration(input.projectId, adapterId, JSON.parse(cursor).legacyMigration.checkpointDigest)
    assert.ok(frozen); frozenLegacyDigest = frozen.checkpointDigest
    const original = JSON.parse(frozen.checkpointJson)
    assert.equal(original.installationId, state.installationId)
    assert.equal(original.projectCreatedAt, at)
    assert.deepEqual(original.checkpoint, JSON.parse(readFileSync(join(input.home, "legacy-checkpoint.json"), "utf8")),
      "Migration must freeze the actual acknowledged legacy checkpoint without rewriting its opaque cursor or Raw obligations")
    for (const scope of yield* journal.sources(input.projectId, adapterId, { limit: 100 })) {
      const owner = yield* journal.claim(scope)
      for (const capture of yield* journal.pending(owner, undefined, 100)) pending.push({ sourceId: scope.sourceSessionId,
        state: capture.state, activated: capture.activationReceipt !== null, canonicalUnits: capture.seal?.canonicalUnits ?? 0, rawUnits: capture.seal?.rawUnits ?? 0 })
    }
  } else {
    writeFileSync(join(input.home, "legacy-checkpoint.json"), JSON.stringify(state.checkpoint))
  }
  return { installationId: state.installationId, checkpointDigest, frozenLegacyDigest, pending,
    observations: job.observations ?? 0, canonicalEvents: job.canonicalEvents ?? 0, canonicalBatches: job.canonicalBatches ?? 0,
    rawChunks: job.rawChunks ?? 0, sourceFailures: job.sourceFailures ?? [], state: job.state }
}).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(Logger.layer([]))))
process.stdout.write(JSON.stringify(result))
