import { AdapterPackages, AdapterReleases, ToolUpdateError, ClientConfigStore, CLIUpgradeError, CLIUpgradePlatform, CollectorDaemonProcess, CollectorDaemonProcessError, CollectorRunStatusStore, inspectCLIExperience, inspectClient, setupProject } from "@atape/application"
import { Effect, Layer, ManagedRuntime } from "effect"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
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

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose() })
const fixture = async (setup = false, update?: Promise<string>, failInstall = false, failFirstResume = false, toolUpdate = false) => {
  const root = await mkdtemp(join(tmpdir(), "atape-presenter-"))
  const environment = {
    ATAPE_HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
    ATAPE_CODEX_HOME: join(root, "no-codex"), ATAPE_CLAUDE_HOME: join(root, "no-claude"), ATAPE_CODEBUDDY_HOME: join(root, "no-codebuddy"), OPENCODE_DB: join(root, "no-opencode.db")
  }
  let installs = 0, restarted = false
  let syncRunning = failFirstResume
  const starts: Array<{ intervalMs: number; concurrency: number }> = []
  const toolInstalls: string[] = []
  const base = Layer.mergeAll(makeNodeClientLayer(defaultNodeClientPaths(environment), environment),
    Layer.succeed(AdapterReleases, AdapterReleases.of({ latest: () => toolUpdate ? Effect.succeed("0.4.4") : Effect.fail(new ToolUpdateError({ message: "offline" })) })),
    ...(toolUpdate ? [Layer.succeed(AdapterPackages, AdapterPackages.of({ prune: () => Effect.die("Unexpected package maintenance"), install: spec => Effect.sync(() => {
      toolInstalls.push(spec)
      return { packageName: "@atape/adapter-codex", upgradeSpec: "@atape/adapter-codex", version: "0.4.4",
        manifest: { protocolVersion: "atape.adapter.v1alpha1", adapterId: "codex", displayName: "Codex", entry: "./index.js", harnesses: ["codex"] } }
    }) }))] : []))
  const runtime = ManagedRuntime.make(update ? Layer.mergeAll(base, Layer.succeed(CLIUpgradePlatform, CLIUpgradePlatform.of({
    latest: () => Effect.tryPromise({ try: () => update.then(version => { if (version === "offline") throw new Error("offline"); return version }), catch: () => new CLIUpgradeError({ reason: "check", message: "offline" }) }),
    install: () => Effect.sync(() => { installs++ }).pipe(Effect.andThen(failInstall
      ? Effect.fail(new CLIUpgradeError({ reason: "install", message: "Installation failed" })) : Effect.void))
  })), ...(failFirstResume ? [Layer.succeed(CollectorDaemonProcess, CollectorDaemonProcess.of({
    inspect: () => Effect.sync(() => syncRunning ? { pid: 1, startedAt: "now", logFile: "log", intervalMs: 45_000, concurrency: 2 } : undefined),
    stop: () => Effect.sync(() => { syncRunning = false; return true }),
    start: options => Effect.suspend(() => {
      starts.push(options)
      if (starts.length === 1) return Effect.fail(new CollectorDaemonProcessError({ reason: "start", message: "temporary failure" }))
      syncRunning = true
      return Effect.succeed({ ...options, pid: 2, startedAt: "later", logFile: "log", created: true })
    })
  }))] : [])) : base)
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
    path: root, setup, noBrowser: true, environment, version: update ? "0.4.1" : "development"
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
  return { root, presenter, runtime, wait, seed, toolsReady, holdNext, starts, toolInstalls, syncRunning: () => syncRunning, exited: () => exited, installs: () => installs, restarted: () => restarted }
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
    expect(tools.details.join("\n")).toContain("Codex sync: 0.3.1 → 0.4.4 (latest) · enabled · file/URL install")
    expect(tools.options?.[0]?.label).toBe("Use published Codex integration 0.4.4")
    const ui = terminal(client.presenter, 24)
    await expect.poll(() => ui.frame()).toContain("Use published Codex integration 0.4.4")
    await ui.send("\r")
    const updated = await client.wait(screen => Boolean(screen.notice?.includes("integration updated")))
    expect(updated.details.join("\n")).toContain("Codex sync: 0.4.4 · latest 0.4.4 · enabled")
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
    expect(tools.details.join("\n")).toContain("latest unavailable")
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
    expect(failed.details).toContain("Installation failed")
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
    await client.wait(screen => screen.title === "Which conversations should ATape sync?")
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

  it("types a fuzzy project name, browses the selected result, and clears search without leaving setup", async () => {
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
    expect(tools.options).toEqual([{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude Code" }, { value: "codebuddy", label: "CodeBuddy Code CLI" }, { value: "opencode", label: "OpenCode" }])
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

  it("explicit setup skips the welcome while bare atape separates Projects from global actions", async () => {
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
