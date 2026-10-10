// Only setup/inspection use workspace Module Interfaces. Every start and capture
// executes the packed CLI and installed Cursor factory. All native data is synthetic.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CaptureJournals, ClientConfigStore, CLICredentialStore, applyToolChange, defaultSourceCollectionLimits,
  inspectManagedCollector, installAdapter, planToolChange, setAutomaticUpdates, setupProject,
  startManagedCollector, stopManagedCollector
} from "@atape/application"
import { Effect, Layer, Logger } from "effect"
import { makeNodeClientLayer, defaultNodeClientPaths } from "../src/runtime/clientLayers.ts"
import { makeNodeCollectorDaemonLayer } from "../src/runtime/collectorDaemonLayers.ts"
import { runtimeEntry } from "../src/runtime/runtimeSelection.ts"
import { createUpdateControl, updateControlProtocol } from "../src/runtime/updateControl.ts"

type Input = { phase: string; origin: string; credential: string; userId: string; home: string;
  tarball: string; cliTarball: string; projectId: string; projectCreatedAt: string; teamId: string; lossMarker: string }
const input: Input = JSON.parse(readFileSync(0, "utf8"))
const root = realpathSync(input.home), userHome = join(root, "user"), workspace = join(root, "workspace 项目 space")
const sourceHome = join(root, "cursor-native"), installed = join(root, "installed")
const paths = defaultNodeClientPaths({ ATAPE_HOME: join(root, "client") })
const binary = join(installed, "node_modules", "@atape", "cli", "dist", "atape.js")
const fakeBinary = fileURLToPath(new URL("./cursor-native-fixture.mjs", import.meta.url))
const controlFile = join(root, "native-control.json"), nativeStateFile = join(root, "native-source.json")
const secret = "CursorPrivateFixtureToken_0115"
const environment: NodeJS.ProcessEnv = { ...process.env, HOME: userHome, ATAPE_HOME: paths.atapeHome,
  ATAPE_DEVELOPMENT_ALLOW_HTTP: "true", ATAPE_LANG: "en", ATAPE_COLLECTOR_DAEMON: "0",
  XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"), XDG_STATE_HOME: join(root, "xdg-state"),
  CURSOR_CONFIG_DIR: sourceHome, CURSOR_DATA_DIR: sourceHome, ATAPE_CURSOR_EXECUTABLE: fakeBinary,
  CURSOR_FIXTURE_CONTROL: controlFile, ATAPE_REDACT_VALUES: JSON.stringify([secret]),
  ATAPE_GROK_HOME: join(root, "absent-grok"), ATAPE_KIMI_HOME: join(root, "absent-kimi"),
  ATAPE_CODEX_HOME: join(root, "absent-codex"), ATAPE_CLAUDE_HOME: join(root, "absent-claude"),
  ATAPE_CODEBUDDY_HOME: join(root, "absent-codebuddy"), OPENCODE_DB: join(root, "absent-opencode.db"),
  npm_config_prefix: join(root, "npm-prefix"), npm_config_cache: join(root, "npm-cache") }
for (const name of ["CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV",
  "ATAPE_BOOTSTRAP_ENTRY", "ATAPE_CONFIG_FILE", "ATAPE_COLLECTOR_STATE_FILE", "ATAPE_COLLECTOR_PROCESS_FILE",
  "ATAPE_COLLECTOR_STATUS_FILE", "ATAPE_COLLECTOR_LOG_FILE", "ATAPE_ADAPTER_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete environment[name]
assert.equal(process.env.HOME, userHome, "The helper itself must have disposable HOME, not only its installed child")
for (const directory of [userHome, workspace, sourceHome, paths.atapeHome]) mkdirSync(directory, { recursive: true, mode: 0o700 })
Object.assign(process.env, environment)
const user = (text: string) => ({ role: "user", message: { content: [{ type: "text", text }] } })
const assistant = (text: string) => ({ role: "assistant", message: { content: [{ type: "text", text }] } })
const initialRows = [user(`<user_query>\nCursorStartNeedle 中文 ${secret}\n</user_query>`), {
  role: "assistant", message: { content: [{ type: "text", text: "CursorAssistantNeedle" },
    { type: "tool_use", name: "write_file", input: { path: "notes/中文.md", content: secret, count: 0 } }] },
  future: { nested: [`CursorRawFutureNeedle ${secret}`] }
}, { type: "turn_ended", status: "success" }]
const layer = Layer.merge(makeNodeClientLayer(paths, environment), makeNodeCollectorDaemonLayer(paths, binary, environment))
let ptyResults: ReadonlyArray<unknown> = []

const native = () => JSON.parse(readFileSync(nativeStateFile, "utf8")) as { sourceId: string; file: string }
const append = (rows: ReadonlyArray<unknown>) => {
  const source = native()
  writeFileSync(source.file, readFileSync(source.file, "utf8") + rows.map(row => JSON.stringify(row) + "\n").join(""))
}
const startPTY = (mode: string, managedEntry?: string) => {
  const readyFile = join(root, `native-ready-${mode}.json`), exitedFile = join(root, `native-exited-${mode}.json`)
  for (const path of [readyFile, exitedFile]) rmSync(path, { force: true })
  writeFileSync(controlFile, JSON.stringify({ mode, cwd: realpathSync(workspace), rows: initialRows, readyFile, exitedFile }))
  const request = { node: process.execPath, binary, projectId: input.projectId, cwd: realpathSync(workspace), mode, readyFile,
    ...(managedEntry === undefined ? {} : { managedEntry }) }
  const output = execFileSync("python3", [fileURLToPath(new URL("./verify-cursor-start-terminal.py", import.meta.url))], {
    cwd: root, env: environment, input: JSON.stringify(request), encoding: "utf8", timeout: 90_000, maxBuffer: 2 * 1024 * 1024
  })
  const result = JSON.parse(output)
  assert.equal(result.terminalRestored, true)
  assert.equal(result.childJoined, true)
  assert.ok(result.output.includes(mode === "normal" ? `Session creation confirmed: ${result.sourceId}` :
    mode === "failed" ? `Session exited without confirmed creation: ${result.sourceId}` : ""),
  "Installed start did not report its creation outcome")
  if (mode === "normal") writeFileSync(nativeStateFile, JSON.stringify(result))
  return result
}
const assertNoNativeRegistration = () => {
  assert.equal(existsSync(join(paths.atapeHome, "updates", "wakeup", "registration.json")), false)
  assert.equal(existsSync(join(paths.atapeHome, "startup", "registration.json")), false)
  assert.equal(existsSync(join(userHome, "Library", "LaunchAgents")), false)
  assert.equal(existsSync(join(root, "xdg-config", "systemd", "user")), false)
}

try {
  const result = await Effect.runPromise(Effect.gen(function*() {
    if (input.phase === "initial") {
      execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installed, input.cliTarball], {
        cwd: root, env: environment, timeout: 120_000, stdio: "pipe"
      })
      chmodSync(fakeBinary, 0o755)
      // These preferences precede tool setup: applyToolChange now reconciles OS
      // update wakeup immediately, independently of Collector/login preference.
      yield* setAutomaticUpdates(false)
      yield* ClientConfigStore.use(store => store.transact(config => Effect.succeed({ value: undefined,
        config: { ...config, autoStartEnabled: false } })))
      yield* CLICredentialStore.use(store => store.replace({ credential: { version: 1, instanceOrigin: input.origin,
        apiOrigin: input.origin, credential: input.credential, credentialId: "cursor-contract", capabilityVersion: "atape-cli.v1",
        createdAt: "2026-10-10T00:00:00Z", user: { id: input.userId, displayName: "Cursor fixture" } } }))
      yield* installAdapter(input.tarball)
      yield* setupProject({ path: workspace, type: "directory", instanceOrigin: input.origin, userId: input.userId,
        teamId: input.teamId, teamSlug: "cursor-contract", teamName: "Cursor contract", projectId: input.projectId,
        name: "Controlled Cursor", createdAt: input.projectCreatedAt })
      yield* planToolChange(["cursor"]).pipe(Effect.flatMap(applyToolChange))
      yield* stopManagedCollector()
      // Same workspace and plausible sidecar still cannot establish creation.
      const historical = "21c6d8ce-589a-44cf-a6a2-dd9fcd29c83a"
      const slug = realpathSync(workspace).replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
      const historyDirectory = join(sourceHome, "projects", slug, "agent-transcripts", historical)
      mkdirSync(historyDirectory, { recursive: true })
      writeFileSync(join(historyDirectory, `${historical}.jsonl`), JSON.stringify(user("UnattributedCursorHistoryNeedle")) + "\n")
      const historyChat = join(sourceHome, "chats", createHash("md5").update(realpathSync(workspace)).digest("hex"), historical)
      mkdirSync(historyChat, { recursive: true })
      writeFileSync(join(historyChat, "meta.json"), JSON.stringify({ id: historical, cwd: realpathSync(workspace),
        createdAtMs: Date.now(), title: "Plausible history metadata is not creation proof" }))
      ptyResults = [startPTY("normal"), startPTY("failed"), startPTY("cancel")]
      // Same candidate, separate real installed generation: this verifies
      // bootstrap delegation/cancellation, not a cross-version upgrade.
      const manifest = JSON.parse(readFileSync(join(installed, "node_modules", "@atape", "cli", "package.json"), "utf8")) as {
        version: string; atapeRuntime: { stateContract: string; captureStateContract?: string }
      }
      execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix",
        join(paths.atapeHome, "releases", manifest.version), input.cliTarball], { cwd: root, env: environment, timeout: 120_000, stdio: "pipe" })
      const control = createUpdateControl(paths.atapeHome)
      yield* Effect.promise(async () => {
        const ticket = await control.prepare({ next: { protocol: updateControlProtocol, version: manifest.version,
          captureStateContract: manifest.atapeRuntime.captureStateContract ?? manifest.atapeRuntime.stateContract,
          bootstrapEntry: realpathSync(binary), bootstrapIdentity: createHash("sha256").update(readFileSync(binary)).digest("hex"), adapters: [] } })
        await control.begin(ticket)
        await control.complete(ticket)
      })
      ptyResults = [...ptyResults, startPTY("cancel", runtimeEntry(paths.atapeHome, manifest.version))]
    }
    if (input.phase === "append-one") append([user(`CursorAppendOneNeedle ${secret}`), assistant("CursorAppendOneAnswer")])
    if (input.phase === "append-two") append([user("CursorAppendTwoNeedle"), assistant("CursorAppendTwoAnswer")])
    if (input.phase === "raw-off") append([user(`CursorRawOffNeedle ${secret}`), assistant("CursorRawOffAnswer")])
    if (input.phase === "rewrite") writeFileSync(native().file, readFileSync(native().file))
    if (input.phase === "changed") {
      const file = native().file
      writeFileSync(join(root, "saved-transcript.jsonl"), readFileSync(file))
      writeFileSync(file, readFileSync(file, "utf8").replace("CursorAssistantNeedle", "CursorChangedPrefixNeedle"))
    }
    if (input.phase === "loss") writeFileSync(native().file, readFileSync(join(root, "saved-transcript.jsonl")))
    // loss needs a valid append after the deliberately changed-prefix case.
    if (input.phase === "loss") append([user(`CursorFrozenRecoveryNeedle ${secret}`), assistant("CursorFrozenAnswer")])
    if (input.phase === "recover") rmSync(native().file)
    if (input.phase === "cleanup") { yield* stopManagedCollector(); return { cleaned: true } }

    const before = (yield* inspectManagedCollector()).lastCycleCompletedAt
    let job: (Effect.Success<ReturnType<typeof inspectManagedCollector>>)["jobs"][number] | undefined
    yield* Effect.acquireUseRelease(startManagedCollector({ intervalMs: 10_000, concurrency: 1 }), () => Effect.gen(function*() {
      for (let n = 0; n < 600; n++) {
        const status = yield* inspectManagedCollector()
        assert.equal(status.running, true, "Installed Cursor Collector exited")
        assert.equal(status.collectorFailure, undefined)
        const current = status.jobs.find(item => item.adapterId === "cursor" && item.projectId === input.projectId)
        if (status.lastCycleCompletedAt && status.lastCycleCompletedAt !== before && current && !current.hasMore &&
          (input.phase !== "loss" || existsSync(input.lossMarker))) { job = current; return }
        yield* Effect.sleep(100)
      }
      throw new Error("Installed Cursor Collector did not complete its bounded fixture cycle")
    }), () => stopManagedCollector().pipe(Effect.orDie))
    assert.equal((yield* inspectManagedCollector()).running, false)
    // claim fences previous owners. It must only happen after the installed
    // daemon has stopped, never as a polling mechanism against a live owner.
    const journal = yield* (yield* CaptureJournals).open({ instanceOrigin: input.origin, userId: input.userId }, defaultSourceCollectionLimits.journal)
    const scopes = yield* journal.sources(input.projectId, "cursor", { limit: 100 })
    assert.equal(scopes.length, 1, "Unattributed history acquired a Canonical capture scope")
    assert.equal(scopes[0]!.sourceSessionId, native().sourceId)
    const owner = yield* journal.claim(scopes[0]!), coverage = yield* journal.coverage(owner)
    assert.ok(coverage.canonicalCaptureId)
    const capture = (yield* journal.inspect(owner, coverage.canonicalCaptureId, { kind: "canonical", limit: 1 })).capture
    assert.ok(capture.activationReceipt)
    const receipt = JSON.parse(capture.activationReceipt) as { sessionId: string; head: string }
    const pending = yield* journal.pending(owner)
    const records = yield* journal.records(owner, capture.id, { kind: "event", limit: 100 })
    const raw = coverage.observedRawCaptureId === null ? [] : yield* journal.records(owner, coverage.observedRawCaptureId, { kind: "raw", limit: 100 })
    return { ...receipt, sourceId: native().sourceId, checkpoint: owner.checkpoint, pending: pending.length,
      job, ptyResults, records: records.map(row => ({ key: row.key, revision: row.revision, rawReference: row.rawReference })),
      rawComplete: raw.every(row => row.disposition === "acknowledged" || row.disposition === "unavailable") }
  }).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(Logger.layer([]))))
  assertNoNativeRegistration()
  process.stdout.write(JSON.stringify(result))
} catch (cause) {
  await Effect.runPromise(stopManagedCollector().pipe(Effect.provide(layer))).catch(() => {})
  throw cause
}
