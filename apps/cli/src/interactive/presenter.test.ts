import { ClientConfigStore, CollectorRunStatusStore, inspectCLIExperience, inspectClient, setupProject } from "@atape/application"
import { Effect, ManagedRuntime } from "effect"
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
const fixture = async (setup = false) => {
  const root = await mkdtemp(join(tmpdir(), "atape-presenter-"))
  const environment = {
    ATAPE_HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
    ATAPE_CODEX_HOME: join(root, "no-codex"), ATAPE_CLAUDE_HOME: join(root, "no-claude")
  }
  const runtime = ManagedRuntime.make(makeNodeClientLayer(defaultNodeClientPaths(environment), environment))
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
  }, () => { exited = true }, {
    path: root, setup, noBrowser: true, environment
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
        projects: config.projects.map(item => item.id === id ? { ...item, adapterIds: ["codex"] } : item)
      } }))
    }))
    return project.project
  }
  return { root, presenter, runtime, wait, seed, holdNext, exited: () => exited }
}

const terminal = (presenter: ExperiencePresenter, rows = 14) => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const output = Object.assign(new PassThrough(), { columns: 80, rows, isTTY: true })
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
  it("welcomes a new user and retains an edited directory after Back without configuring capture", async () => {
    const client = await fixture()
    const directory = join(client.root, "项目 space")
    await mkdir(directory)
    client.presenter.start()
    await client.wait(screen => screen.layout === "welcome")
    client.presenter.submit("connect")
    await client.wait(screen => screen.suggestions?.some(item => item.path === directory + "/") ?? false)
    client.presenter.pathChanged(directory)
    client.presenter.back()
    expect(client.presenter.getSnapshot().layout).toBe("welcome")
    client.presenter.submit("connect")
    expect(client.presenter.getSnapshot().initial).toBe(directory)
    expect((await client.runtime.runPromise(inspectClient())).projects).toEqual([])
    client.presenter.close()
    expect(client.exited()).toBe(true)
  })

  it("explicit setup skips the welcome while bare atape separates Projects from global actions", async () => {
    const explicit = await fixture(true)
    explicit.presenter.start()
    await explicit.wait(screen => Boolean(screen.pathInput))
    const client = await fixture()
    const first = await client.seed("first")
    const second = await client.seed("second")
    client.presenter.start()
    const list = await client.wait(screen => screen.layout === "projects")
    expect(list.options).toHaveLength(2)
    expect(list.options?.every(option => option.value.startsWith("project:"))).toBe(true)
    expect(list.actions?.map(action => action.value)).toEqual(["add", "start", "refresh", "exit"])
    client.presenter.submit(`project:${second.instanceOrigin}:${second.id}`)
    await client.wait(screen => screen.title === "second")
    client.presenter.back()
    const returned = await client.wait(screen => screen.layout === "projects")
    expect(returned.focusedProject).toBe(`project:${second.instanceOrigin}:${second.id}`)
    expect(returned.projects?.map(project => project.name)).toEqual([first.name, second.name])
  })

  it("prioritizes source setup or global resume and puts account/removal controls in Project settings", async () => {
    const client = await fixture()
    const empty = await client.seed("empty")
    const stopped = await client.seed("stopped", true)
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit(`project:${empty.instanceOrigin}:${empty.id}`)
    const noSources = await client.wait(screen => screen.title === "empty")
    expect(noSources.options?.[0]?.value).toBe("sources")
    client.presenter.back()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit(`project:${stopped.instanceOrigin}:${stopped.id}`)
    const resume = await client.wait(screen => screen.title === "stopped")
    expect(resume.options?.[0]).toEqual({ value: "start", label: "Start sync for all projects" })
    expect(resume.options?.map(option => option.value)).not.toContain("login")
    expect(resume.options?.map(option => option.value)).not.toContain("remove")
    client.presenter.submit("settings")
    expect(client.presenter.getSnapshot().options?.map(option => option.value)).toContain("remove")
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

  it("does not navigate back when a slow refresh completes after opening settings", async () => {
    const client = await fixture()
    const project = await client.seed("project")
    client.presenter.start()
    await client.wait(screen => screen.layout === "projects")
    client.presenter.submit(`project:${project.instanceOrigin}:${project.id}`)
    await client.wait(screen => screen.title === "project")
    const release = client.holdNext()
    client.presenter.submit("refresh")
    expect(client.presenter.getSnapshot().refreshing).toBe(true)
    client.presenter.submit("settings")
    expect(client.presenter.getSnapshot().title).toBe("Project settings")
    release()
    // Allow the real filesystem-backed refresh to finish after navigation.
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(client.presenter.getSnapshot().title).toBe("Project settings")
  })

  it("puts a required fix before Web navigation and keeps diagnostics refresh read-only and in place", async () => {
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
    expect(detail.options?.[0]).toEqual({ value: "diagnostics", label: "Resolve sync issue" })
    expect(detail.details.indexOf("codex: Integration version is incompatible")).toBeLessThan(detail.details.findIndex(line => line.startsWith("Directory:")))
    client.presenter.submit("diagnostics")
    expect(client.presenter.getSnapshot().details).toContain("Check integration compatibility; update the affected adapter if needed.")
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
