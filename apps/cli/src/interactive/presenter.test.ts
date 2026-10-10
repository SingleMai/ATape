import { AdapterPackages, AutomaticUpdatePlatform, ClientConfigStore, CLIUpgradeError, CLIUpgradePlatform, CollectorDaemonProcess, CollectorDaemonProcessError, CollectorRunStatusStore, CollectorRunStatusError, LoginStartupPlatform, UpdateWakePlatform, ProjectSetupGateway, inspectCLIExperience, inspectClient, inspectRedactionSettings, setAutomaticUpdates, setupProject, type CollectorDaemonObservation } from "@atape/application"
import { Effect, Layer, ManagedRuntime } from "effect"
import { releasePackageNames, type CollectorRunState, type ReleaseBundle } from "@atape/domain"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { stripVTControlCharacters } from "node:util"
import { createElement } from "react"
import { render } from "ink"
import { ExperienceView } from "./view.ts"
import { afterEach, describe, expect, it } from "vitest"
import { defaultNodeClientPaths, makeNodeClientLayer } from "../runtime/clientLayers.ts"
import { ExperiencePresenter, type Screen } from "./presenter.ts"
import { makeCLISetupPlatformLayer } from "../runtime/cliSetupPlatform.ts"

const bundle = (version: string): ReleaseBundle => ({ protocol: "atape.release-bundle.v1", version,
  captureStateContract: "atape.client.v3-capture.v2", updateControlProtocol: "atape.update-control.v1",
  packages: releasePackageNames.map(name => ({ name, integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${version}.tgz` })) })
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose() })
const backgroundFixture = () => ({
  process: { generation: "collector-generation", pid: 42, startedAt: "2026-10-10T01:00:00Z" } as CollectorDaemonObservation | undefined,
  status: { version: 1, jobs: [] } as CollectorRunState,
  error: undefined as CollectorRunStatusError | undefined
})
const fixture = async (setup = false, update?: Promise<string>, failInstall = false, failFirstResume = false, toolUpdate = false, maintenance = false, setupReview = false, manualStartupUpdates = update !== undefined, privacyEnvironment: NodeJS.ProcessEnv = {}, background?: ReturnType<typeof backgroundFixture>) => {
  const root = await mkdtemp(join(tmpdir(), "atape-presenter-"))
  const environment = {
    ATAPE_HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
    ATAPE_KIMI_HOME: join(root, "no-kimi"), ATAPE_GROK_HOME: join(root, "no-grok"), ATAPE_CODEX_HOME: join(root, "no-codex"), ATAPE_CLAUDE_HOME: join(root, "no-claude"), ATAPE_CODEBUDDY_HOME: join(root, "no-codebuddy"), OPENCODE_DB: join(root, "no-opencode.db"),
    ...privacyEnvironment
  }
  let installs = 0, restarted = false, updateChecks = 0
  let syncRunning = failFirstResume
  let syncWanted = failFirstResume
  let loginRegistered = true
  const loginRegistrations: boolean[] = []
  const starts: Array<{ intervalMs: number; concurrency: number }> = []
  const startSync = (options: { intervalMs: number; concurrency: number }) => Effect.suspend(() => {
    syncWanted = true
    starts.push(options)
    if (starts.length === 1) return Effect.fail(new CollectorDaemonProcessError({ reason: "start", message: "temporary failure" }))
    syncRunning = true
    return Effect.succeed({ ...options, pid: 2, startedAt: "later", logFile: "log", created: true })
  })
  const toolInstalls: string[] = []
  const prunes: boolean[] = []
  const base = Layer.mergeAll(makeNodeClientLayer(defaultNodeClientPaths(environment), environment),
    ...(background ? [Layer.succeed(CollectorDaemonProcess, CollectorDaemonProcess.of({
      inspect: () => Effect.sync(() => background.process ? { ...background.process, logFile: "log", intervalMs: 45_000, concurrency: 2 } : undefined),
      observe: () => Effect.sync(() => background.process), refresh: () => Effect.succeed(false),
      start: () => Effect.die("Privacy observation must not start sync"),
      stop: () => Effect.die("Privacy observation must not stop sync"),
      pause: () => Effect.die("Privacy observation must not pause sync"),
      resume: () => Effect.die("Privacy observation must not resume sync")
    })), Layer.succeed(CollectorRunStatusStore, CollectorRunStatusStore.of({
      read: () => Effect.suspend(() => background.error ? Effect.fail(background.error) : Effect.succeed(background.status)),
      recordCycle: () => Effect.die("Privacy observation must not write status"),
      recordCollectorFailure: () => Effect.die("Privacy observation must not write status"),
      recordRedactionJob: () => Effect.die("Privacy observation must not write status")
    }))] : []),
    Layer.succeed(UpdateWakePlatform, UpdateWakePlatform.of({ inspect: () => Effect.succeed({ state: "registered" }),
      reconcile: enabled => Effect.succeed({ state: enabled ? "registered" : "missing" }) })),
    Layer.succeed(LoginStartupPlatform, LoginStartupPlatform.of({
      inspect: () => Effect.sync(() => ({ state: loginRegistered ? "registered" as const : "missing" as const })),
      reconcile: enabled => Effect.sync(() => { loginRegistrations.push(enabled); loginRegistered = enabled; return { state: enabled ? "registered" as const : "missing" as const } })
    })),
    makeCLISetupPlatformLayer(defaultNodeClientPaths(environment), environment, toolUpdate ? "0.4.4" : update ? "0.4.1" : "development"),
    ...(setupReview ? [Layer.succeed(ProjectSetupGateway, ProjectSetupGateway.of({
      loadWorkspace: () => Effect.succeed({ user: { id: "user-1", displayName: "Mai" },
        teams: [{ id: "team-1", slug: "team", displayName: "Team", role: "owner" }], projects: [] }),
      matchGitProject: () => Effect.succeed({ status: "none" }),
      createProject: () => Effect.die("Setup review must not create a Project")
    }))] : []),
    ...(toolUpdate ? [Layer.succeed(AdapterPackages, AdapterPackages.of({ prune: input => maintenance ? Effect.sync(() => {
      prunes.push(input.apply)
      return { applied: input.apply, removed: input.apply ? 1 : 0, more: false,
        slots: [{ slot: "old", packageName: "@atape/adapter-codex", version: "0.1.0", state: input.apply ? "removed" as const : "eligible" as const }] }
    }) : Effect.die("Unexpected package maintenance"), install: spec => Effect.sync(() => {
      toolInstalls.push(spec)
      return { packageName: "@atape/adapter-codex", upgradeSpec: "@atape/adapter-codex", version: "0.4.4",
        manifest: { protocolVersion: "atape.adapter.v1alpha1", adapterId: "codex", displayName: "Codex", entry: "./index.js", harnesses: ["codex"] } }
    }) }))] : []))
  const runtime = ManagedRuntime.make(update ? Layer.mergeAll(base, Layer.succeed(CLIUpgradePlatform, CLIUpgradePlatform.of({
    acquireOwnership: () => Effect.void,
    latest: () => Effect.suspend(() => {
      updateChecks++
      return Effect.tryPromise({ try: () => update.then(version => { if (version === "offline") throw new Error("offline"); return bundle(version) }), catch: () => new CLIUpgradeError({ reason: "check", message: "offline" }) })
    }),
    installedVersion: () => Effect.succeed("0.4.1"),
    install: () => Effect.sync(() => { installs++ }).pipe(Effect.andThen(failInstall
      ? Effect.fail(new CLIUpgradeError({ reason: "install", message: "Installation failed" })) : Effect.void))
  })), Layer.succeed(AutomaticUpdatePlatform, AutomaticUpdatePlatform.of({
    recoveryPending: () => Effect.succeed(false), supported: () => Effect.succeed(true), schedule: () => Effect.succeed({ nextCheckAt: 0, failures: 0 }),
    target: () => Effect.die("Manual update already selected a bundle"), prepare: selected => Effect.succeed({ bundle: selected, key: "prepared" }),
    activate: () => Effect.void, record: () => Effect.void, launch: () => Effect.void
  })), ...(failFirstResume ? [Layer.succeed(CollectorDaemonProcess, CollectorDaemonProcess.of({
      refresh: () => Effect.succeed(false),
    observe: () => Effect.sync(() => syncRunning ? { generation: "fixture", pid: 1, startedAt: "now" } : undefined),
    inspect: () => Effect.sync(() => syncRunning ? { pid: 1, startedAt: "now", logFile: "log", intervalMs: 45_000, concurrency: 2 } : undefined),
    stop: () => Effect.sync(() => { syncWanted = false; syncRunning = false; return true }),
    pause: () => Effect.sync(() => { syncRunning = false; return true }),
    resume: () => syncWanted ? startSync({ intervalMs: 45_000, concurrency: 2 }) : Effect.succeed(undefined),
    start: startSync
  }))] : [])) : base)
  if (manualStartupUpdates) await runtime.runPromise(setAutomaticUpdates(false))
  let exited = false
  let nextDelay: Promise<void> | undefined
  const releases: Array<() => void> = []
  const holdNext = () => {
    let release!: () => void
    nextDelay = new Promise<void>(resolve => { release = resolve })
    releases.push(release)
    return release
  }
  const presenter = new ExperiencePresenter((effect, signal) => {
    const delay = nextDelay
    nextDelay = undefined
    return delay ? delay.then(() => runtime.runPromise(effect, { signal })) : runtime.runPromise(effect, { signal })
  }, restart => { exited = true; restarted = Boolean(restart) }, {
    path: root, noBrowser: true, environment, version: update ? "0.4.1" : "development"
  })
  cleanup.push(async () => { releases.forEach(release => release()); presenter.close(); await runtime.dispose(); await rm(root, { recursive: true, force: true }) })
  const wait = async (matches: (screen: Screen) => boolean) => {
    await expect.poll(() => matches(presenter.getSnapshot()), { timeout: 3000 }).toBe(true)
    return presenter.getSnapshot()
  }
  const seed = async (id: string, sources = false) => {
    const path = join(root, id)
    await mkdir(path)
    const project = await runtime.runPromise(setupProject({ path, instanceOrigin: "https://atape.net", userId: "user-1",
      teamId: "team-1", teamSlug: "team", teamName: "Team", projectId: id, name: id,
      createdAt: "2026-09-08T00:00:00Z", type: "directory" }))
    if (sources) await runtime.runPromise(Effect.gen(function*() {
      const store = yield* ClientConfigStore
      yield* store.transact(config => Effect.succeed({ value: undefined, config: { ...config,
        adapters: [{ adapterId: "codex", displayName: "Codex", packageName: "@atape/adapter-codex", version: "0.3.0",
          upgradeSpec: "@atape/adapter-codex", installedAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z" }],
        toolsConfigured: true, enabledAdapterIds: ["codex"]
      } }))
    }))
    return project.project
  }
  const toolsReady = async (configured = true) => runtime.runPromise(Effect.gen(function*() {
    yield* (yield* ClientConfigStore).transact(config => Effect.succeed({ value: undefined, config: {
      ...config, toolsConfigured: configured, enabledAdapterIds: configured ? ["codex"] : [],
      adapters: [{ adapterId: "codex", displayName: "Codex", packageName: "@atape/adapter-codex", version: "0.3.1",
        upgradeSpec: "@atape/adapter-codex", installedAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z" }]
    } }))
  }))
  const start = presenter.start.bind(presenter)
  if (setup) presenter.start = () => {
    start()
    void wait(screen => screen.layout === "projects").then(() => presenter.submit("add"))
  }
  return { root, environment, presenter, runtime, wait, seed, toolsReady, holdNext, starts, toolInstalls, prunes, loginRegistrations,
    loseLoginRegistration: () => { loginRegistered = false },
    syncRunning: () => syncRunning, exited: () => exited, installs: () => installs, updateChecks: () => updateChecks, restarted: () => restarted }
}

const terminal = (presenter: ExperiencePresenter, rows = 14, columns = 80) => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const output = Object.assign(new PassThrough(), { columns, rows, isTTY: true })
  let text = ""
  output.on("data", chunk => { text += stripVTControlCharacters(chunk.toString()) })
  const renderer = render(createElement(ExperienceView, { presenter }), {
    stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream,
    stderr: output as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false
  })
  cleanup.unshift(async () => { renderer.unmount(); renderer.cleanup(); input.destroy(); output.destroy() })
  const frame = () => text.slice(text.lastIndexOf("ATape ·"))
  const send = async (keys: string) => {
    input.write(keys)
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  return { send, frame }
}

describe("interactive navigation through the presenter Interface", () => {
  const privacy = async (environment: NodeJS.ProcessEnv = {}, background?: ReturnType<typeof backgroundFixture>) => {
    const client = await fixture(false, undefined, false, false, false, false, false, false, environment, background)
    await client.toolsReady()
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit("settings")
    await client.wait(screen => screen.title === "Settings")
    client.presenter.submit("privacy")
    await client.wait(screen => screen.title === "Privacy rules" && screen.kind === "menu")
    return client
  }
  const privacyField = async (client: Awaited<ReturnType<typeof fixture>>, field: string, value: string, encoded = false) => {
    if (encoded) {
      client.presenter.submit("encoded")
      await client.wait(screen => screen.title === "Advanced: JSON encoded field")
    }
    client.presenter.submit(field)
    await client.wait(screen => screen.kind === "input" && screen.title === `Edit ${field}`)
    client.presenter.submit(value)
    await client.wait(screen => screen.title === "Custom rule 1")
  }
  it("shows effective privacy settings without exposing environment values or changing sync", async () => {
    const secret = "private-environment-value-123456"
    const client = await privacy({ APP_TOKEN: secret, ATAPE_REDACT_VALUES: JSON.stringify([secret, "second-private-literal"]) })
    const screen = client.presenter.getSnapshot()
    expect(screen.details).toContain("Built-in credential protection is always on. Custom rules add protection.")
    expect(screen.details).toContain("Custom rules: 0")
    expect(screen.details).toContain("Environment exact values: 2 (values are hidden)")
    expect(JSON.stringify(screen)).not.toContain(secret)
    expect(JSON.stringify(screen)).not.toContain("second-private-literal")
    expect(client.starts).toEqual([])
    expect(await readFile(join(client.environment.ATAPE_HOME!, "config", "redaction.json"), "utf8").catch(() => undefined)).toBeUndefined()
    client.presenter.submit("validate")
    await client.wait(screen => screen.notice === "Rules are valid. Validation does not save them.")
    expect(client.presenter.getSnapshot().options?.some(option => option.value === "save")).toBe(false)
  })
  it("preserves an unsaved draft and its saved comparison target across background refresh", async () => {
    const background = backgroundFixture()
    const client = await privacy({}, background)
    const saved = await client.runtime.runPromise(inspectRedactionSettings())
    const snapshot = { configFile: saved.configFile, revision: saved.revision, exists: saved.exists,
      origin: saved.origin, literalCount: saved.literalCount, customRuleCount: 0 }
    const job = { projectId: "project-1", adapterId: "codex", attemptId: "attempt-1",
      startedAt: "2026-10-10T01:01:00Z", updatedAt: "2026-10-10T01:01:01Z", phase: "active" as const, snapshot }
    background.status = { version: 1, jobs: [], redaction: { generation: background.process!.generation,
      configFile: saved.configFile, origin: saved.origin, jobs: [job] } }
    client.presenter.submit("add")
    await client.wait(screen => screen.title === "Custom rule 1")
    await privacyField(client, "name", "Draft kept")
    await privacyField(client, "type", "DRAFT")
    await privacyField(client, "pattern", "(?=invalid)")
    client.presenter.submit("done")
    const draft = await client.wait(screen => screen.title === "Privacy rules")
    expect(draft.options?.at(-1)).toEqual({ value: "background", label: "Background privacy status" })
    client.presenter.submit("background")
    const first = await client.wait(screen => screen.title === "Background privacy status" && screen.kind === "menu")
    expect(first.options).toEqual([{ value: "refresh", label: "Refresh background status" }, { value: "back", label: "Back to privacy rules" }])
    expect(first.details).toContain("Background sync: running")
    expect(first.details).toContain("This job loaded the compared file revision.")
    expect(first.details).toContain("Custom rules: 0 · Environment exact values: 0 (values are hidden)")
    expect(first.details).toContain("The comparison uses the file revision loaded or saved in this editor. Unsaved edits are excluded.")
    await mkdir(join(client.environment.ATAPE_HOME!, "config"), { recursive: true })
    const external = JSON.stringify({ patterns: [] })
    await writeFile(saved.configFile, external)
    const changed = await client.runtime.runPromise(inspectRedactionSettings())
    expect(changed.revision).not.toBe(saved.revision)
    background.status = { ...background.status, redaction: { ...background.status.redaction!, jobs: [{ ...job,
      phase: "completed", updatedAt: "2026-10-10T01:02:00Z", snapshot: { ...snapshot, exists: true, revision: changed.revision } }] } }
    client.presenter.submit("refresh")
    const refreshed = await client.wait(screen => screen.title === "Background privacy status" && screen.details.includes("Current Collector observation · Last recorded state: Job completed"))
    expect(refreshed.details).toContain(`Compared saved revision: ${JSON.stringify(saved.revision)}`)
    expect(refreshed.details).toContain(`Loaded revision: ${JSON.stringify(changed.revision)}`)
    expect(refreshed.details).toContain("This job loaded a different file revision. Future jobs reload their selected file.")
    client.presenter.back()
    const returned = await client.wait(screen => screen.title === "Privacy rules")
    expect(returned.details).toContain("Custom rules: 1 · unsaved draft")
    expect(returned.details).toContain("Validation: Draft needs validation")
    client.presenter.submit("rule:0")
    const rule = await client.wait(screen => screen.title === "Custom rule 1")
    expect(rule.details).toContain('name: "Draft kept"')
    expect(rule.details).toContain('pattern: "(?=invalid)"')
    client.presenter.submit("done")
    client.presenter.submit("save")
    await client.wait(screen => screen.title === "Privacy rules" && Boolean(screen.notice?.startsWith("Rules are invalid")))
    expect(await readFile(saved.configFile, "utf8")).toBe(external)
    expect(client.starts).toEqual([])
  })
  it("reports each concurrent job's snapshot and last recorded state without a global effective claim", async () => {
    const background = backgroundFixture()
    const secret = "background-environment-secret-123456"
    const client = await privacy({ APP_TOKEN: secret }, background)
    const saved = await client.runtime.runPromise(inspectRedactionSettings())
    const otherFile = join(client.root, "background\n\u001b[31m\u202e.json")
    const snapshot = { configFile: saved.configFile, revision: saved.revision, exists: saved.exists,
      origin: saved.origin, literalCount: 8, customRuleCount: 3 }
    const job = { projectId: "project-1", adapterId: "codex", attemptId: "attempt-1",
      startedAt: "2026-10-10T01:01:00Z", updatedAt: "2026-10-10T01:01:01Z", phase: "active" as const, snapshot }
    background.status = { version: 1, jobs: [], redaction: { generation: background.process!.generation,
      configFile: otherFile, origin: "environment", jobs: [job,
        { ...job, projectId: "different-revision", attemptId: "attempt-2", snapshot: { ...snapshot, revision: "another-revision" } },
        { ...job, projectId: "another-file\n\u001b[32m\u2066", adapterId: "custom\u001b[33m", attemptId: "attempt-3", snapshot: { ...snapshot, configFile: otherFile } },
        { projectId: "load-failed", adapterId: "claude", attemptId: "attempt-4", startedAt: job.startedAt, updatedAt: job.updatedAt, phase: "load_failed" },
        { projectId: "loading", adapterId: "codex", attemptId: "attempt-5", startedAt: job.startedAt, updatedAt: job.updatedAt, phase: "loading" },
        { ...job, projectId: "failed-after-load", attemptId: "attempt-6", phase: "failed" },
        { ...job, projectId: "interrupted", attemptId: "attempt-7", phase: "interrupted" }
      ] } }
    client.presenter.submit("background")
    const screen = await client.wait(screen => screen.title === "Background privacy status" && screen.kind === "menu")
    expect(screen.details).toContain("This job loaded the compared file revision.")
    expect(screen.details).toContain("This job loaded a different file revision. Future jobs reload their selected file.")
    expect(screen.details).toContain("This job selected another file. Saving the console file does not change it.")
    expect(screen.details).toContain("Current Collector observation · Last recorded state: Privacy rules could not be loaded")
    expect(screen.details).toContain("Current Collector observation · Last recorded state: Loading privacy rules")
    expect(screen.details).toContain("Current Collector observation · Last recorded state: Job failed")
    expect(screen.details).toContain("Current Collector observation · Last recorded state: Job interrupted")
    expect(screen.details.filter(line => line === "No loaded snapshot was reported for this job.")).toHaveLength(2)
    expect(screen.details).toContain("Custom rules: 3 · Environment exact values: 8 (values are hidden)")
    expect(screen.details).toContain("A matching revision compares the file only. Environment values and upload results are not compared.")
    expect(screen.details).toContain("Job states are last recorded observations. Missing updates can leave an earlier state.")
    expect(screen.details.join("\n")).not.toContain(secret)
    expect(screen.details.join("")).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/)
    expect(screen.details.some(line => line.includes("background\\n\\u001b[31m\\u202e.json"))).toBe(true)
    expect(screen.details.some(line => line.includes("custom\\u001b[33m"))).toBe(true)
    const view = terminal(client.presenter, 14, 80)
    await view.send("\x1b[6~")
    expect(view.frame()).toContain("Refresh background status")
    expect(view.frame()).toContain("Back to privacy rules")
    client.presenter.submit("back")
    await client.wait(screen => screen.title === "Privacy rules")
    expect(client.starts).toEqual([])
  })
  it("compares a newly saved revision while waiting for separately observed later jobs", async () => {
    const background = backgroundFixture()
    const client = await privacy({}, background)
    const before = await client.runtime.runPromise(inspectRedactionSettings())
    const job = { projectId: "project-1", adapterId: "codex", attemptId: "attempt-1",
      startedAt: "2026-10-10T01:01:00Z", updatedAt: "2026-10-10T01:01:01Z", phase: "active" as const,
      snapshot: { configFile: before.configFile, revision: before.revision, exists: before.exists,
        origin: before.origin, literalCount: before.literalCount, customRuleCount: 0 } }
    background.status = { version: 1, jobs: [], redaction: { generation: background.process!.generation,
      configFile: before.configFile, origin: before.origin, jobs: [job] } }
    client.presenter.submit("add")
    await client.wait(screen => screen.title === "Custom rule 1")
    await privacyField(client, "name", "Saved rule")
    await privacyField(client, "type", "PRIVATE")
    await privacyField(client, "pattern", "private_value")
    client.presenter.submit("done")
    client.presenter.submit("save")
    const review = await client.wait(screen => screen.title === "Save global privacy rules?")
    expect(review.details).toContain("Future jobs that select this file load it at job start. Running jobs keep their current snapshots.")
    client.presenter.submit("confirm")
    await client.wait(screen => screen.notice === "Privacy rules saved. Check background status for jobs using this file revision.")
    const saved = await client.runtime.runPromise(inspectRedactionSettings())
    client.presenter.submit("background")
    const waiting = await client.wait(screen => screen.title === "Background privacy status" && screen.kind === "menu")
    expect(waiting.details).toContain(`Compared saved revision: ${JSON.stringify(saved.revision)}`)
    expect(waiting.details).toContain("This job loaded a different file revision. Future jobs reload their selected file.")
    background.status = { ...background.status, redaction: { ...background.status.redaction!, jobs: [{ ...job, attemptId: "attempt-2",
      snapshot: { ...job.snapshot, revision: saved.revision, exists: true, customRuleCount: 1 } }] } }
    client.presenter.submit("refresh")
    await client.wait(screen => screen.title === "Background privacy status" && screen.details.includes("This job loaded the compared file revision."))
    client.presenter.submit("back")
    const returned = await client.wait(screen => screen.title === "Privacy rules")
    expect(returned.details).toContain("Custom rules: 1")
    expect(returned.details).toContain("Validation: Valid")
    expect(client.starts).toEqual([])
  })
  it("separates stopped history from unknown observations and allows status without readable console rules", async () => {
    const background = backgroundFixture()
    const client = await privacy({}, background)
    const saved = await client.runtime.runPromise(inspectRedactionSettings())
    background.process = undefined
    background.status = { version: 1, jobs: [], redaction: { generation: "preceding-collector", configFile: saved.configFile,
      origin: saved.origin, jobs: [{ projectId: "historical", adapterId: "codex", attemptId: "attempt-1", startedAt: "2026-10-10T01:01:00Z",
        updatedAt: "2026-10-10T01:01:01Z", phase: "active", snapshot: { configFile: saved.configFile, revision: saved.revision,
          exists: saved.exists, origin: saved.origin, literalCount: 0, customRuleCount: 0 } }] } }
    client.presenter.submit("background")
    const stopped = await client.wait(screen => screen.title === "Background privacy status" && screen.kind === "menu")
    expect(stopped.details).toContain("Background sync: stopped")
    expect(stopped.details).toContain("Shown jobs are historical observations, not active jobs.")
    expect(stopped.details).toContain("Historical observation · Last recorded state: Job active")
    background.process = { generation: "new-collector", pid: 43, startedAt: "2026-10-10T01:03:00Z" }
    client.presenter.submit("refresh")
    const unknown = await client.wait(screen => screen.title === "Background privacy status" && screen.details.includes("Background sync: unknown"))
    expect(unknown.details).toContain("The current Collector and its task snapshots could not be confirmed.")
    expect(unknown.details).toContain("No task snapshots are available for this observation.")
    expect(unknown.details.some(line => line.includes("historical"))).toBe(false)
    const privateError = "unreadable-status-secret-123456"
    background.error = new CollectorRunStatusError({ reason: "io", message: privateError })
    client.presenter.submit("refresh")
    await client.wait(screen => screen.title === "Background privacy status" && screen.kind === "menu")
    expect(JSON.stringify(client.presenter.getSnapshot())).not.toContain(privateError)
    client.presenter.submit("back")
    await client.wait(screen => screen.title === "Privacy rules")
    await mkdir(join(client.environment.ATAPE_HOME!, "config"), { recursive: true })
    await writeFile(saved.configFile, "malformed JSON must be preserved")
    client.presenter.submit("reload")
    const unreadable = await client.wait(screen => screen.title === "Privacy rules" && Boolean(screen.details[0]?.startsWith("Rules are invalid")))
    expect(unreadable.options).toContainEqual({ value: "background", label: "Background privacy status" })
    background.error = undefined
    background.process = undefined
    client.presenter.submit("background")
    const noTarget = await client.wait(screen => screen.title === "Background privacy status" && screen.kind === "menu")
    expect(noTarget.details).toContain("Console rules could not be loaded, so no file revision is being compared.")
    expect(noTarget.details).not.toContain("This job loaded the compared file revision.")
    expect(noTarget.details.some(line => line.startsWith("Compared saved revision:"))).toBe(false)
    client.presenter.back()
    await client.wait(screen => screen.title === "Privacy rules")
    expect(await readFile(saved.configFile, "utf8")).toBe("malformed JSON must be preserved")
  })
  it("edits every custom field, validates, cancels by default, and saves an exact global draft", async () => {
    const client = await privacy()
    const configBefore = await client.runtime.runPromise(inspectClient())
    const configFile = join(client.environment.ATAPE_HOME!, "config", "redaction.json")
    client.presenter.submit("add")
    await client.wait(screen => screen.title === "Custom rule 1")
    await privacyField(client, "name", "内部凭据 \"primary\"")
    await privacyField(client, "type", "INTERNAL")
    await privacyField(client, "pattern", "token=(\\w+)")
    await privacyField(client, "field_pattern", "(?i)^credential$")
    await privacyField(client, "capture_group", "1")
    client.presenter.submit("done")
    await client.wait(screen => screen.title === "Privacy rules")
    client.presenter.submit("save")
    const review = await client.wait(screen => screen.title === "Save global privacy rules?")
    expect(review.options?.[0]).toEqual({ value: "back", label: "Cancel" })
    expect(review.details).toContain("Already accepted history stays unchanged. Some uncertain deliveries under an older policy may pause for recovery.")
    client.presenter.submit("back")
    await client.wait(screen => screen.title === "Privacy rules")
    expect(await readFile(configFile, "utf8").catch(() => undefined)).toBeUndefined()
    client.presenter.submit("save")
    await client.wait(screen => screen.title === "Save global privacy rules?")
    client.presenter.submit("confirm")
    await client.wait(screen => screen.notice === "Privacy rules saved. Check background status for jobs using this file revision.")
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({ patterns: [{ name: "内部凭据 \"primary\"", type: "INTERNAL", pattern: "token=(\\w+)", field_pattern: "(?i)^credential$", capture_group: 1 }] })
    expect(await client.runtime.runPromise(inspectClient())).toEqual(configBefore)
    expect(client.starts).toEqual([])
    client.presenter.submit("rule:0")
    await client.wait(screen => screen.title === "Custom rule 1")
    await privacyField(client, "capture_group", "")
    client.presenter.submit("delete")
    await client.wait(screen => screen.title === "Delete this custom rule?")
    client.presenter.submit("confirm")
    await client.wait(screen => screen.title === "Privacy rules" && screen.details.includes("Custom rules: 0 · unsaved draft"))
    expect(JSON.parse(await readFile(configFile, "utf8")).patterns).toHaveLength(1)
    client.presenter.submit("save")
    await client.wait(screen => screen.title === "Save global privacy rules?")
    client.presenter.submit("confirm")
    await client.wait(screen => screen.notice === "Privacy rules saved. Check background status for jobs using this file revision.")
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({ patterns: [] })
  })
  it("retains invalid drafts and rejects a concurrent overwrite until explicit reload", async () => {
    const client = await privacy()
    const configFile = join(client.environment.ATAPE_HOME!, "config", "redaction.json")
    client.presenter.submit("add")
    await client.wait(screen => screen.title === "Custom rule 1")
    await privacyField(client, "name", "Draft")
    await privacyField(client, "type", "INTERNAL")
    await privacyField(client, "pattern", "(?=unsupported)")
    client.presenter.submit("done")
    await client.wait(screen => screen.title === "Privacy rules")
    client.presenter.submit("save")
    await client.wait(screen => screen.title === "Privacy rules" && Boolean(screen.notice?.startsWith("Rules are invalid")))
    expect(client.presenter.getSnapshot().details).toContain("Custom rules: 1 · unsaved draft")
    expect(await readFile(configFile, "utf8").catch(() => undefined)).toBeUndefined()
    client.presenter.submit("rule:0")
    await client.wait(screen => screen.title === "Custom rule 1")
    await privacyField(client, "pattern", "draft_secret")
    client.presenter.submit("done")
    await client.wait(screen => screen.title === "Privacy rules")
    await mkdir(join(client.environment.ATAPE_HOME!, "config"), { recursive: true })
    const external = JSON.stringify({ patterns: [{ name: "External", type: "OTHER", pattern: "external_secret" }] })
    await writeFile(configFile, external, { mode: 0o600 })
    client.presenter.submit("save")
    await client.wait(screen => screen.title === "Save global privacy rules?")
    client.presenter.submit("confirm")
    await client.wait(screen => screen.title === "Privacy rules" && Boolean(screen.notice?.startsWith("The saved rules changed elsewhere")))
    expect(await readFile(configFile, "utf8")).toBe(external)
    client.presenter.submit("rule:0")
    const retained = await client.wait(screen => screen.title === "Custom rule 1")
    expect(retained.details).toContain('name: "Draft"')
    client.presenter.submit("done")
    client.presenter.submit("reload")
    const discard = await client.wait(screen => screen.title === "Discard unsaved rules?")
    expect(discard.options?.[0]).toEqual({ value: "back", label: "Cancel" })
    client.presenter.submit("back")
    await client.wait(screen => screen.title === "Privacy rules")
    client.presenter.submit("reload")
    await client.wait(screen => screen.title === "Discard unsaved rules?")
    client.presenter.submit("confirm")
    await client.wait(screen => screen.title === "Privacy rules" && screen.details.includes("Custom rules: 1"))
    client.presenter.submit("rule:0")
    const loaded = await client.wait(screen => screen.title === "Custom rule 1")
    expect(loaded.details).toContain('name: "External"')
  })
  it("round trips exact control characters through the optional encoded editor", async () => {
    const client = await privacy()
    client.presenter.submit("add")
    await client.wait(screen => screen.title === "Custom rule 1")
    await privacyField(client, "name", "Line break")
    await privacyField(client, "type", "EXACT")
    await privacyField(client, "pattern", JSON.stringify("line\nbreak\u001b"), true)
    client.presenter.submit("pattern")
    const encoded = await client.wait(screen => screen.kind === "input" && screen.title === "Edit pattern")
    expect(encoded.inputEncoding).toBe("json")
    expect(encoded.initial).toBe('"line\\nbreak\\u001b"')
    expect(JSON.stringify(encoded)).not.toContain("\u001b")
    client.presenter.submit(encoded.initial!)
    await client.wait(screen => screen.title === "Custom rule 1")
    client.presenter.submit("done")
    client.presenter.submit("save")
    await client.wait(screen => screen.title === "Save global privacy rules?")
    client.presenter.submit("confirm")
    await client.wait(screen => screen.notice === "Privacy rules saved. Check background status for jobs using this file revision.")
    const config = JSON.parse(await readFile(join(client.environment.ATAPE_HOME!, "config", "redaction.json"), "utf8"))
    expect(config.patterns[0]).toEqual({ name: "Line break", type: "EXACT", pattern: "line\nbreak\u001b" })
  })
  it("waits for a confirmed save behind a real file lock and keeps the completed revision", async () => {
    const client = await privacy()
    const configFile = join(client.environment.ATAPE_HOME!, "config", "redaction.json")
    client.presenter.submit("add")
    await client.wait(screen => screen.title === "Custom rule 1")
    await privacyField(client, "name", "First")
    await privacyField(client, "type", "LOCKED")
    await privacyField(client, "pattern", "locked_secret")
    client.presenter.submit("done")
    client.presenter.submit("save")
    await client.wait(screen => screen.title === "Save global privacy rules?")
    await mkdir(join(client.environment.ATAPE_HOME!, "config"), { recursive: true })
    await writeFile(`${configFile}.lock`, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 })
    const view = terminal(client.presenter, 24, 100)
    try {
      client.presenter.submit("confirm")
      await client.wait(screen => screen.kind === "busy" && screen.backDisabled === true)
      // The real Node Adapter is waiting on the file exclusion boundary. Back and
      // Escape cannot report a false cancellation once the user confirms saving.
      await view.send("\x1b")
      client.presenter.back()
      expect(client.presenter.getSnapshot()).toMatchObject({ kind: "busy", backDisabled: true })
      expect(view.frame()).toContain("Saving… · Ctrl+C Exit")
      expect(view.frame()).not.toContain("Esc Cancel")
      expect(await readFile(configFile, "utf8").catch(() => undefined)).toBeUndefined()
    } finally { await rm(`${configFile}.lock`, { force: true }) }
    await client.wait(screen => screen.notice === "Privacy rules saved. Check background status for jobs using this file revision.")
    expect(JSON.parse(await readFile(configFile, "utf8")).patterns[0].name).toBe("First")
    // A second edit saves from the completed snapshot rather than the pre-save
    // revision, which would incorrectly conflict with our own successful write.
    client.presenter.submit("rule:0")
    await client.wait(screen => screen.title === "Custom rule 1")
    await privacyField(client, "name", "Second")
    client.presenter.submit("done")
    client.presenter.submit("save")
    await client.wait(screen => screen.title === "Save global privacy rules?")
    client.presenter.submit("confirm")
    await client.wait(screen => screen.notice === "Privacy rules saved. Check background status for jobs using this file revision.")
    expect(JSON.parse(await readFile(configFile, "utf8")).patterns[0].name).toBe("Second")
  })
  it("rejects raw control pastes without stripping their meaning or accepting a stale input", async () => {
    const client = await privacy()
    client.presenter.submit("add")
    await client.wait(screen => screen.title === "Custom rule 1")
    client.presenter.submit("pattern")
    await client.wait(screen => screen.kind === "input")
    const view = terminal(client.presenter, 24, 100)
    await view.send("\x1b[200~first\nsecond\x1b[201~")
    expect(view.frame()).toContain("Input was not inserted")
    await view.send("\r")
    expect(client.presenter.getSnapshot().kind).toBe("input")
    await view.send("safe_secret")
    await view.send("\r")
    const rule = await client.wait(screen => screen.title === "Custom rule 1")
    expect(rule.details).toContain('pattern: "safe_secret"')
    expect(rule.details.some(detail => detail.includes("firstsecond"))).toBe(false)
  })
  it("turns login startup off and on without changing sync intent or other settings", async () => {
    const client = await fixture()
    await client.toolsReady()
    const before = await client.runtime.runPromise(inspectClient())
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit("settings")
    await client.wait(screen => screen.title === "Settings" && screen.details.includes("Login startup: on · resumes sync unless you stopped it"))
    client.presenter.submit("login-startup")
    await client.wait(screen => screen.title === "Settings" && screen.details.includes("Login startup: off · current sync is unchanged"))
    expect(await client.runtime.runPromise(inspectClient())).toEqual({ ...before, autoStartEnabled: false })
    client.presenter.submit("login-startup")
    await client.wait(screen => screen.title === "Settings" && screen.details.includes("Login startup: on · resumes sync unless you stopped it"))
    expect(await client.runtime.runPromise(inspectClient())).toEqual({ ...before, autoStartEnabled: true })
    expect(client.loginRegistrations).toEqual([false, true])
    expect(client.starts).toEqual([])
  })

  it("shows and repairs a missing native registration separately from the on preference", async () => {
    const client = await fixture()
    await client.toolsReady()
    client.loseLoginRegistration()
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit("settings")
    const pending = await client.wait(screen => screen.title === "Settings" && screen.details.includes("Login startup: on · needs attention"))
    expect(pending.options).toContainEqual({ value: "repair-login-startup", label: "Retry login startup registration" })
    client.presenter.submit("repair-login-startup")
    const registered = await client.wait(screen => screen.title === "Settings" && screen.details.includes("Login startup: on · resumes sync unless you stopped it"))
    expect(registered.options?.some(option => option.value === "repair-login-startup")).toBe(false)
    expect(client.loginRegistrations).toEqual([true])
  })

  it("opens Projects with automatic updates on by default without asking the manual release platform", async () => {
    const client = await fixture(false, new Promise<string>(() => {}), false, false, false, false, false, false)
    await client.toolsReady()
    expect((await client.runtime.runPromise(inspectClient())).autoUpdateEnabled).toBeUndefined()
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    expect(client.updateChecks()).toBe(0)
    expect(client.installs()).toBe(0)
  })

  it("turns automatic updates off and on in Settings without changing capture settings", async () => {
    const client = await fixture()
    await client.toolsReady()
    const before = await client.runtime.runPromise(inspectClient())
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit("settings")
    const enabled = await client.wait(screen => screen.title === "Settings")
    expect(enabled.details).toContain("Automatic updates: on · ATape and official npm integrations")
    expect(enabled.options).toContainEqual({ value: "automatic-updates", label: "Turn off automatic updates" })
    client.presenter.submit("automatic-updates")
    const disabled = await client.wait(screen => screen.title === "Settings" && screen.details.includes("Automatic updates: off"))
    expect(disabled.options).toContainEqual({ value: "automatic-updates", label: "Turn on automatic updates" })
    expect(await client.runtime.runPromise(inspectClient())).toEqual({ ...before, autoUpdateEnabled: false })
    client.presenter.submit("automatic-updates")
    await client.wait(screen => screen.title === "Settings" && screen.details.includes("Automatic updates: on · ATape and official npm integrations"))
    expect(await client.runtime.runPromise(inspectClient())).toEqual({ ...before, autoUpdateEnabled: true })
  })
  it.each([true, false])("explains automatic updates in initialization review when enabled is %s", async enabled => {
    const client = await fixture(false, undefined, false, false, false, false, true)
    await client.toolsReady()
    if (!enabled) await client.runtime.runPromise(setAutomaticUpdates(false))
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit("add")
    await client.wait(screen => screen.pathInput === true)
    client.presenter.submit(client.root)
    const review = await client.wait(screen => screen.title === "Review and connect")
    expect(review.details).toContain(enabled
      ? "Automatic updates are on by default for ATape and official npm integrations. Turn off in Settings."
      : "Automatic updates are off. Turn on in Settings.")
    expect((await client.runtime.runPromise(inspectClient())).projects).toEqual([])
  })
  it("saves a language from Settings without modifying tool or project choices", async () => {
    const client = await fixture()
    await client.toolsReady()
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit("settings")
    await client.wait(screen => screen.title === "Settings")
    client.presenter.submit("language")
    await client.wait(screen => screen.title === "Language")
    client.presenter.submit("zh-CN")
    await client.wait(screen => screen.details.includes("Language saved. Reopen ATape to use it."))
    expect(await client.runtime.runPromise(inspectClient())).toMatchObject({ locale: "zh-CN", enabledAdapterIds: ["codex"], projects: [] })
    client.presenter.back()
    await client.wait(screen => screen.title === "Settings")
  })
  it("requires review for package installation and cleanup, preserving capture selection on cancel and apply", async () => {
    const client = await fixture(false, undefined, false, false, true, true)
    await client.toolsReady()
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit("tools")
    await client.wait(screen => screen.title === "Tools and updates")
    client.presenter.submit("maintenance")
    await client.wait(screen => screen.title === "Integration maintenance")
    client.presenter.submit("install")
    await client.wait(screen => screen.kind === "input")
    client.presenter.submit("/trusted/local-package")
    const review = await client.wait(screen => screen.title === "Install integration?")
    expect(review.options?.[0]?.value).toBe("back")
    expect(client.toolInstalls).toEqual([])
    client.presenter.back()
    expect(client.presenter.getSnapshot().initial).toBe("/trusted/local-package")
    client.presenter.submit("/trusted/local-package")
    await client.wait(screen => screen.title === "Install integration?")
    client.presenter.submit("confirm")
    await client.wait(screen => screen.title === "Integration maintenance")
    expect(client.toolInstalls).toEqual(["/trusted/local-package"])
    client.presenter.submit("prune")
    const cleanup = await client.wait(screen => screen.title === "Remove unused integration versions?")
    expect(cleanup.options?.[0]?.value).toBe("back")
    expect(client.prunes).toEqual([false])
    client.presenter.back()
    await client.wait(screen => screen.title === "Integration maintenance")
    expect(client.prunes).toEqual([false])
    client.presenter.submit("prune")
    await client.wait(screen => screen.title === "Remove unused integration versions?")
    client.presenter.submit("confirm")
    await client.wait(screen => Boolean(screen.notice?.includes("Removed 1")))
    expect(client.prunes).toEqual([false, false, true])
    expect(await client.runtime.runPromise(inspectClient())).toMatchObject({ enabledAdapterIds: ["codex"], projects: [] })
  })
  it("shows versions, switches a local integration to its published release and returns home with Escape", async () => {
    const client = await fixture(false, undefined, false, false, true)
    await client.toolsReady()
    await client.runtime.runPromise(Effect.gen(function*() {
      yield* (yield* ClientConfigStore).transact(config => Effect.succeed({ value: undefined,
        config: { ...config, adapters: config.adapters.map(adapter => ({ ...adapter, upgradeSpec: "file:/old/codex" })) } }))
    }))
    client.presenter.start()
    const home = await client.wait(screen => screen.layout === "projects")
    expect(home.actions?.find(action => action.value === "tools")?.label).toBe("Tools and updates")
    client.presenter.submit("tools")
    const tools = await client.wait(screen => screen.title === "Tools and updates")
    expect(tools.details.join("\n")).toContain("Codex sync: 0.3.1 · for ATape 0.4.4 · enabled · file/URL install")
    expect(tools.options?.[0]?.label).toBe("Use published Codex integration 0.4.4")
    const ui = terminal(client.presenter, 24)
    await expect.poll(() => ui.frame()).toContain("Use published Codex integration 0.4.4")
    await ui.send("\r")
    const updated = await client.wait(screen => Boolean(screen.notice?.includes("integration updated")))
    expect(updated.details.join("\n")).toContain("Codex sync: 0.4.4 · for ATape 0.4.4 · enabled")
    expect(client.toolInstalls).toEqual(["@atape/adapter-codex@0.4.4"])
    expect((await client.runtime.runPromise(inspectClient())).enabledAdapterIds).toEqual(["codex"])
    client.presenter.back()
    await client.wait(screen => screen.layout === "projects")
  })
  it("allows updating the CLI after skipping the startup prompt", async () => {
    const client = await fixture(false, Promise.resolve("0.4.4"))
    await client.toolsReady()
    client.presenter.start()
    await client.wait(screen => screen.title === "Update available")
    client.presenter.submit("skip")
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit("tools")
    const tools = await client.wait(screen => screen.title === "Tools and updates")
    expect(tools.details.join("\n")).toContain("Codex sync: 0.3.1")
    expect(tools.options?.[0]?.label).toBe("Update ATape to 0.4.4")
    client.presenter.submit("update:cli")
    await expect.poll(client.restarted).toBe(true)
    expect(client.installs()).toBe(1)
  })
  it("retries sync recovery without another install, or opens the installed version when skipped", async () => {
    for (const action of ["upgrade", "skip"]) {
      const client = await fixture(false, Promise.resolve("0.4.2"), false, true)
      client.presenter.start()
      await client.wait(screen => screen.title === "Update available")
      client.presenter.submit("upgrade")
      const recovery = await client.wait(screen => screen.title === "Updated, but sync is stopped")
      expect(recovery.options?.[0]?.label).toBe("Resume sync and continue")
      client.presenter.submit(action)
      await expect.poll(client.restarted).toBe(true)
      expect(client.installs()).toBe(1)
      expect(client.syncRunning()).toBe(action === "upgrade")
      expect(client.starts).toEqual(Array(action === "upgrade" ? 2 : 1).fill({ intervalMs: 45_000, concurrency: 2 }))
    }
  })
  it("waits for the update choice before opening Projects and skips only this session", async () => {
    let complete!: (version: string) => void
    const client = await fixture(false, new Promise<string>(resolve => { complete = resolve }))
    await client.toolsReady()
    client.presenter.start()
    expect(client.presenter.getSnapshot()).toMatchObject({ kind: "busy", title: "Checking for updates" })
    complete("0.4.2")
    const choice = await client.wait(screen => screen.title === "Update available")
    expect(choice.layout).toBeUndefined()
    expect(choice.options?.map(option => option.value)).toEqual(["upgrade", "skip"])
    const ui = terminal(client.presenter)
    await expect.poll(() => ui.frame()).toContain("Upgrade and continue")
    expect(ui.frame()).not.toContain("Your Projects")
    await ui.send("\x1b[B\r")
    await client.wait(screen => screen.layout === "projects")
    expect(client.installs()).toBe(0)
    client.presenter.submit("tools")
    await client.wait(screen => screen.title === "Tools and updates")
    client.presenter.back()
    await client.wait(screen => screen.layout === "projects")
  })
  it("reopens the updated executable only after the selected upgrade succeeds", async () => {
    const client = await fixture(false, Promise.resolve("0.4.2"))
    client.presenter.start()
    await client.wait(screen => screen.title === "Update available")
    client.presenter.submit("upgrade")
    await expect.poll(client.restarted).toBe(true)
    expect(client.installs()).toBe(1)
    expect(client.exited()).toBe(true)
    expect(client.presenter.getSnapshot().layout).not.toBe("projects")
  })
  it("keeps upgrade errors at the choice with retry and skip", async () => {
    const client = await fixture(true, Promise.resolve("0.4.2"), true)
    await client.toolsReady()
    client.presenter.start()
    await client.wait(screen => screen.title === "Update available")
    client.presenter.submit("upgrade")
    const failed = await client.wait(screen => screen.title === "Update could not finish")
    expect(failed.details.join("\n")).toContain("Installation failed")
    expect(failed.options?.map(option => option.value)).toEqual(["upgrade", "skip"])
    expect(client.restarted()).toBe(false)
    client.presenter.submit("skip")
    await client.wait(screen => screen.pathInput === true)
  })
  it("enters normally when current or offline and exits instead of bypassing an update with Escape", async () => {
    for (const latest of ["0.4.1", "offline"]) {
      const client = await fixture(false, Promise.resolve(latest))
      client.presenter.start()
      await client.wait(screen => screen.layout === "welcome")
      expect(client.installs()).toBe(0)
    }
    const client = await fixture(false, Promise.resolve("0.4.2"))
    client.presenter.start()
    await client.wait(screen => screen.title === "Update available")
    client.presenter.back()
    expect(client.exited()).toBe(true)
    expect(client.restarted()).toBe(false)
  })
  it("welcomes a new user and retains an edited directory after Back without configuring capture", async () => {
    const client = await fixture()
    const directory = join(client.root, "项目 space")
    await mkdir(directory)
    await client.toolsReady(false)
    client.presenter.start()
    await client.wait(screen => screen.layout === "welcome")
    client.presenter.submit("connect")
    const tools = await client.wait(screen => screen.title === "Which conversations should ATape sync?")
    expect(tools.details).toContain("Login startup is on by default. Sync resumes when you log in, unless you stopped it. Turn off in Settings.")
    client.presenter.submit(["codex"])
    await client.wait(screen => screen.suggestions?.some(item => item.path === directory + "/") ?? false)
    client.presenter.pathChanged(directory)
    client.presenter.back()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit("add")
    expect(client.presenter.getSnapshot().initial).toBe(directory)
    expect((await client.runtime.runPromise(inspectClient())).projects).toEqual([])
    client.presenter.close()
    expect(client.exited()).toBe(true)
  })

  it("opens an empty Project list when tool setup was completed on an earlier launch", async () => {
    const client = await fixture()
    await client.toolsReady()
    client.presenter.start()
    const screen = await client.wait(screen => screen.layout === "projects")
    expect(screen.options).toEqual([])
    expect(screen.details.join(" ")).toContain("Tools: Codex")
    client.presenter.submit("add")
    await client.wait(screen => screen.pathInput === true)
    expect((await client.runtime.runPromise(inspectClient())).projects).toEqual([])
  })

  it("keeps Add project in the footer and opens it as a modal while n remains text during list search", async () => {
    const client = await fixture()
    await client.toolsReady()
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    const ui = terminal(client.presenter, 12)
    await expect.poll(() => ui.frame()).toMatch(/Projects\s+Tools and updates\s+Settings/)
    expect(ui.frame().trimEnd().split("\n").at(-1)).toContain("n Add")
    await ui.send("/")
    await ui.send("n")
    expect(client.presenter.getSnapshot().layout).toBe("projects")
    expect(ui.frame()).toContain("/ n")
    await ui.send("\x1b")
    await ui.send("n")
    await client.wait(screen => screen.pathInput === true)
    const modal = ui.frame()
    expect(modal).toContain("Add project")
    expect(modal).toContain("Project directory")
    expect(modal).toContain("Esc Close")
    await ui.send("q")
    expect(ui.frame()).toContain("Search: q")
    expect(client.exited()).toBe(false)
    await ui.send("\x1b")
    await client.wait(screen => screen.layout === "projects")
  })

  it("renders the Project console as a full-height shell with navigation, a framed workspace and fixed controls", async () => {
    const client = await fixture()
    await client.seed("project")
    const ui = terminal(client.presenter, 24)
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    await expect.poll(() => ui.frame()).toContain("▌ project")
    const frame = ui.frame()
    expect(frame).toContain("ATape · Your Projects")
    expect(frame).toMatch(/Projects\s+Tools and updates\s+Settings/)
    expect(frame).toContain("┌")
    expect(frame).toContain("└")
    expect(frame.trimEnd().split("\n").at(-1)).toContain("Tab Actions · q Exit")
    expect(frame.split("\n")).toHaveLength(24)
    await ui.send("n")
    await client.wait(screen => screen.pathInput === true)
    expect(ui.frame()).toContain("Project directory")
    await ui.send("\x1b")
    await client.wait(screen => screen.layout === "projects")
    await ui.send("\t")
    expect(ui.frame()).toContain("Actions: Tools and updates · ←→ Choose")
  })

  it("keeps the framed shell and compact navigation within a narrow terminal", async () => {
    const client = await fixture()
    await client.seed("project")
    const ui = terminal(client.presenter, 14, 42)
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    await expect.poll(() => ui.frame()).toMatch(/Projects\s+Tools\s+Settings/)
    const frame = ui.frame()
    expect(frame).toMatch(/Projects\s+Tools\s+Settings/)
    expect(frame).toContain("▌ project")
    expect(frame.split("\n")).toHaveLength(14)
    expect(frame.split("\n").every(line => line.length <= 42)).toBe(true)
  })

  it("types a fuzzy project name, browses the selected result, and clears search when reopening Add project", async () => {
    const client = await fixture(true)
    await client.toolsReady()
    const path = join(client.root, "work/Payments-Service")
    await mkdir(path, { recursive: true })
    const ui = terminal(client.presenter)
    client.presenter.start()
    await client.wait(screen => screen.pathInput === true && !screen.directoriesLoading)
    await ui.send("pmts")
    await client.wait(screen => screen.suggestions?.some(item => item.path === path + "/") ?? false)
    expect(ui.frame()).toContain("Search: pmts")
    await ui.send("\x1b")
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit("add")
    await client.wait(screen => screen.pathInput === true && !screen.directoriesLoading)
    expect(ui.frame()).not.toContain("Search: pmts")
    await ui.send("pmts")
    await client.wait(screen => screen.suggestions?.some(item => item.path === path + "/") ?? false)
    await ui.send("\r")
    await client.wait(screen => screen.suggestions?.some(item => item.parent && item.path === join(client.root, "work") + "/") ?? false)
    expect(ui.frame()).toContain("Use current directory")
    expect((await client.runtime.runPromise(inspectClient())).projects).toEqual([])
  })

  it("opens global checkboxes from Tools, cancels without saving and keeps project recovery direct", async () => {
    const client = await fixture()
    const project = await client.seed("project", true)
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit("tools")
    await client.wait(screen => screen.title === "Tools and updates")
    client.presenter.submit("configure")
    const tools = await client.wait(screen => screen.kind === "sources")
    expect(tools.options).toEqual([{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude Code" }, { value: "codebuddy", label: "CodeBuddy Code CLI" }, { value: "kimi", label: "Kimi Code CLI" }, { value: "opencode", label: "OpenCode" }, { value: "grok", label: "Grok Build" }, { value: "cursor", label: "Cursor" }])
    expect(tools.selected).toEqual(["codex"])
    client.presenter.back()
    await client.wait(screen => screen.title === "Tools and updates")
    client.presenter.back()
    await client.wait(screen => screen.layout === "projects")
    expect((await client.runtime.runPromise(inspectClient())).enabledAdapterIds).toEqual(["codex"])
    await client.runtime.runPromise(Effect.gen(function*() {
      yield* (yield* ClientConfigStore).transact(config => Effect.succeed({ value: undefined,
        config: { ...config, enabledAdapterIds: [] } }))
    }))
    client.presenter.submit(`project:${project.instanceOrigin}:${project.id}`)
    const empty = await client.wait(screen => screen.title === "project")
    expect(empty.options?.[0]?.value).toBe("tools")
    client.presenter.submit("tools")
    await client.wait(screen => screen.kind === "sources")
    client.presenter.submit([])
    await client.wait(screen => screen.title === "project")
    expect((await client.runtime.runPromise(inspectClient())).enabledAdapterIds).toEqual([])
  })

  it("Add project opens the picker while home separates Projects from global actions", async () => {
    const explicit = await fixture(true)
    await explicit.toolsReady()
    explicit.presenter.start()
    await explicit.wait(screen => Boolean(screen.pathInput))
    const client = await fixture()
    const first = await client.seed("first")
    const second = await client.seed("second")
    client.presenter.start()
    const list = await client.wait(screen => screen.layout === "projects")
    expect(list.options).toHaveLength(2)
    expect(list.options?.every(option => option.value.startsWith("project:"))).toBe(true)
    expect(list.actions?.map(action => action.value)).toEqual(["tools", "settings"])
    client.presenter.submit(`project:${second.instanceOrigin}:${second.id}`)
    await client.wait(screen => screen.title === "second")
    client.presenter.back()
    const returned = await client.wait(screen => screen.layout === "projects")
    expect(returned.focusedProject).toBe(`project:${second.instanceOrigin}:${second.id}`)
    expect(returned.projects?.map(project => project.name)).toEqual([first.name, second.name])
  })

  it("routes tool setup globally, keeps Project actions shallow and requires confirmation to disconnect", async () => {
    const client = await fixture()
    const empty = await client.seed("empty")
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit(`project:${empty.instanceOrigin}:${empty.id}`)
    const noSources = await client.wait(screen => screen.title === "empty")
    expect(noSources.options?.[0]?.value).toBe("tools")
    const stopped = await client.seed("stopped", true)
    client.presenter.back()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit(`project:${stopped.instanceOrigin}:${stopped.id}`)
    const resume = await client.wait(screen => screen.title === "stopped")
    const ui = terminal(client.presenter)
    expect(resume.options?.[0]).toEqual({ value: "start", label: "Start sync for all projects" })
    expect(resume.options?.map(option => option.value)).not.toContain("login")
    expect(resume.options?.map(option => option.value)).toContain("remove")
    expect(resume.options?.map(option => option.value)).not.toContain("settings")
    expect(resume.options?.map(option => option.value)).not.toContain("back")
    client.presenter.submit("diagnostics")
    expect(client.presenter.getSnapshot().options?.map(option => option.value)).not.toContain("back")
    await ui.send("\x1b")
    await client.wait(screen => screen.title === "stopped")
    await ui.send("\x1b")
    await client.wait(screen => screen.layout === "projects")
    expect(client.presenter.getSnapshot().focusedProject).toBe(`project:${stopped.instanceOrigin}:${stopped.id}`)
    client.presenter.submit(`project:${stopped.instanceOrigin}:${stopped.id}`)
    await client.wait(screen => screen.title === "stopped")
    client.presenter.submit("remove")
    expect(client.presenter.getSnapshot().options?.[0]?.value).toBe("back")
    client.presenter.back()
    await client.wait(screen => screen.title === "stopped")
    expect((await client.runtime.runPromise(inspectClient())).projects).toHaveLength(2)
  })
  it("keeps the filtered viewport and selected Project after details and an in-place refresh", async () => {
    const client = await fixture()
    for (let i = 0; i < 12; i++) await client.seed(`project-${String(i).padStart(2, "0")}`)
    const ui = terminal(client.presenter)
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    await ui.send("/")
    await ui.send("project-")
    for (let i = 0; i < 9; i++) await ui.send("\x1b[B")
    const viewport = ui.frame().split("\n").filter(line => /project-\d/.test(line))
    expect(viewport.some(line => line.includes("project-09"))).toBe(true)
    expect(viewport.some(line => line.includes("project-00"))).toBe(false)
    await ui.send("\r")
    await client.wait(screen => screen.title === "project-09")
    await ui.send("\x1b")
    await client.wait(screen => screen.layout === "projects")
    await expect.poll(() => ui.frame()).toContain("/ project-")
    expect(ui.frame().split("\n").filter(line => /project-\d/.test(line))).toEqual(viewport)
    const revision = client.presenter.getSnapshot().revision
    client.presenter.submit("refresh")
    expect(client.presenter.getSnapshot()).toMatchObject({ revision, layout: "projects", refreshing: true })
    await client.wait(screen => screen.layout === "projects" && !screen.refreshing)
    expect(client.presenter.getSnapshot().revision).toBe(revision)
    expect(ui.frame().split("\n").filter(line => /project-\d/.test(line))).toEqual(viewport)
    await ui.send("\r")
    await client.wait(screen => screen.title === "project-09")
  })

  it("treats Enter on directory candidates as browsing and requires the connection action", async () => {
    const client = await fixture(true)
    await client.toolsReady()
    const directory = join(client.root, "child")
    await mkdir(directory)
    const ui = terminal(client.presenter)
    client.presenter.start()
    await client.wait(screen => screen.suggestions?.some(item => item.path === directory + "/") ?? false)
    // Initial focus is Use current directory; the parent is the first candidate.
    await ui.send("\x1b[B")
    await ui.send("\x1b[B")
    const release = client.holdNext()
    await ui.send("\r")
    expect(client.presenter.getSnapshot().pathInput).toBe(true)
    // Navigation while the next directory is still loading must not fall back
    // to the connection action when no candidate is available yet.
    await ui.send("\x1b[B")
    await ui.send("\r")
    expect(client.presenter.getSnapshot()).toMatchObject({ pathInput: true, directoriesLoading: true })
    release()
    await client.wait(screen => screen.suggestions?.some(item => item.parent && item.path === client.root + "/") ?? false)
    expect((await client.runtime.runPromise(inspectClient())).projects).toEqual([])
    expect(ui.frame()).toContain("Use current directory")
    // Editing and confirming the edit only focuses the explicit connection row.
    await ui.send("\x15")
    await ui.send(directory)
    await ui.send("\r")
    expect(client.presenter.getSnapshot().pathInput).toBe(true)
  })

  it("does not navigate back when a slow refresh completes after opening global tools", async () => {
    const client = await fixture()
    const project = await client.seed("project")
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit(`project:${project.instanceOrigin}:${project.id}`)
    await client.wait(screen => screen.title === "project")
    const release = client.holdNext()
    client.presenter.submit("refresh")
    expect(client.presenter.getSnapshot().refreshing).toBe(true)
    client.presenter.submit("tools")
    await client.wait(screen => screen.kind === "sources")
    release()
    // Allow the real filesystem-backed refresh to finish after navigation.
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(client.presenter.getSnapshot().kind).toBe("sources")
  })

  it("shows every retained source diagnostic and identifies report truncation inside ATape", async () => {
    const client = await fixture()
    const project = await client.seed("partial", true)
    await client.runtime.runPromise(Effect.gen(function*() {
      yield* (yield* CollectorRunStatusStore).recordCycle({
        startedAt: "2026-09-08T00:00:00Z", completedAt: "2026-09-08T00:00:01Z", failures: [],
        jobs: [{ projectId: project.id, adapterId: "codex", pages: 1, observations: 1, canonicalBatches: 1, rawChunks: 0, redactions: 0, hasMore: false,
          sourceFailures: Array.from({ length: 5 }, (_, index) => ({ source: `source-${index}`, reason: "format" as const })), sourceFailuresTruncated: true }]
      })
    }))
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit(`project:${project.instanceOrigin}:${project.id}`)
    await client.wait(screen => screen.title === "partial")
    client.presenter.submit("diagnostics")
    const details = client.presenter.getSnapshot().details
    for (let index = 0; index < 5; index++) expect(details).toContain(`source-${index}`)
    expect(details.join(" ")).toContain("only a sample")
    expect(details.join(" ")).not.toContain("atape status")
  })

  it("prioritizes the required fix and keeps diagnostics refresh read-only and in place", async () => {
    const client = await fixture()
    const project = await client.seed("broken", true)
    const record = (failed: boolean) => client.runtime.runPromise(Effect.gen(function*() {
      yield* (yield* CollectorRunStatusStore).recordCycle({
        startedAt: "2026-09-08T00:00:00Z", completedAt: "2026-09-08T00:00:01Z",
        jobs: failed ? [] : [{ projectId: project.id, adapterId: "codex", pages: 1, observations: 1, canonicalBatches: 1, rawChunks: 0, redactions: 0, hasMore: false }],
        failures: failed ? [{ projectId: project.id, adapterId: "codex", reason: "contract", retryable: false, message: "Integration version is incompatible" }] : []
      })
    }))
    await record(true)
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit(`project:${project.instanceOrigin}:${project.id}`)
    const detail = await client.wait(screen => screen.title === "broken")
    expect(detail.options?.[0]).toEqual({ value: "tool", label: "Check for tool updates" })
    expect(detail.options?.some(option => option.value === "web")).toBe(false)
    expect(detail.details.join(" ")).toContain("ATape couldn't read Codex conversations")
    expect(detail.details.join(" ")).not.toContain("Integration version is incompatible")
    client.presenter.submit("diagnostics")
    expect(client.presenter.getSnapshot().details).toContain("Integration version is incompatible")
    expect(client.presenter.getSnapshot().details.join(" ")).toContain("Try updating ATape's reader")
    const revision = client.presenter.getSnapshot().revision
    await record(false)
    client.presenter.submit("refresh")
    await client.wait(screen => screen.diagnostics === true && !screen.refreshing)
    expect(client.presenter.getSnapshot()).toMatchObject({ title: "Sync details", revision, notice: "Status updated. Sync timing is unchanged." })
    expect(client.presenter.getSnapshot().details.join(" ")).not.toContain("Integration version is incompatible")
    expect((await client.runtime.runPromise(inspectCLIExperience())).collector.running).toBe(false)
  })

  it("offers one direct sign-in action when another Project blocks global sync", async () => {
    const client = await fixture()
    const first = await client.seed("first", true)
    const second = await client.seed("second", true)
    await client.runtime.runPromise(Effect.gen(function*() {
      yield* (yield* CollectorRunStatusStore).recordCycle({
        startedAt: "2026-09-08T00:00:00Z", completedAt: "2026-09-08T00:00:01Z", jobs: [],
        failures: [{ projectId: second.id, adapterId: "codex", reason: "unauthenticated", retryable: false, message: "Credential expired" }]
      })
    }))
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit(`project:${first.instanceOrigin}:${first.id}`)
    const blocked = await client.wait(screen => screen.title === "first")
    expect(blocked.options?.[0]).toEqual({ value: "unblock", label: "Sign in for second and resume" })
    expect(blocked.details).toContain("second needs sign-in before background sync can continue.")
    client.presenter.back()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit(`project:${second.instanceOrigin}:${second.id}`)
    const expired = await client.wait(screen => screen.title === "second")
    expect(expired.options?.[0]).toEqual({ value: "login", label: "Sign in again and resume" })
  })

})
