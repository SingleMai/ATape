import { emptyClientConfig, type ClientConfig } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { ClientConfigStore, ClientConfigStoreError } from "./clientManagement.ts"
import { CollectorDaemonProcess, CollectorDaemonProcessError } from "./collectorDaemonProcess.ts"
import { inspectLoginStartup, LoginStartupError, LoginStartupPlatform, reconcileLoginStartup, runLoginStartup, setLoginStartup,
  type LoginStartupRegistration } from "./loginStartup.ts"

const configuredClient = (): ClientConfig => ({
  ...emptyClientConfig(), toolsConfigured: true, enabledAdapterIds: ["codex"],
  projects: [{ id: "project-1", instanceOrigin: "https://atape.net", userId: "user-1", teamId: "team-1",
    teamSlug: "team", teamName: "Team", name: "Project", type: "directory", path: "/work/project", createdAt: "2026-10-09T00:00:00Z" }],
  adapters: [{ adapterId: "codex", packageName: "@atape/adapter-codex", upgradeSpec: "@atape/adapter-codex",
    displayName: "Codex", version: "0.5.3", installedAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z" }]
})

const fixture = (initial: ClientConfig = configuredClient()) => {
  let config = structuredClone(initial), wanted = true, running = false, resumes = 0
  let failState = false, failInspect = false, failReconcile = false, failResume = false
  let registration: LoginStartupRegistration = { state: "registered" }
  const reconciliations: Array<{ enabled: boolean; savedPreference: boolean | undefined }> = []
  const layer = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, ClientConfigStore.of({ transact: change => failState
      ? Effect.fail(new ClientConfigStoreError({ reason: "io", message: "State is unavailable" }))
      : change(structuredClone(config)).pipe(
        Effect.tap(result => Effect.sync(() => { if (result.config) config = structuredClone(result.config) })),
        Effect.map(result => result.value)) })),
    Layer.succeed(LoginStartupPlatform, LoginStartupPlatform.of({
      inspect: () => Effect.suspend(() => failInspect
        ? Effect.fail(new LoginStartupError({ reason: "manager", message: "User manager is unavailable" }))
        : Effect.succeed(registration)),
      reconcile: enabled => Effect.suspend(() => {
        reconciliations.push({ enabled, savedPreference: config.autoStartEnabled })
        if (failReconcile) return Effect.fail(new LoginStartupError({ reason: "registration", message: "Registration could not be changed" }))
        registration = { state: enabled ? "registered" : "missing" }
        return Effect.succeed(registration)
      })
    })),
    Layer.succeed(CollectorDaemonProcess, CollectorDaemonProcess.of({
      observe: () => Effect.die("Unexpected pure process observation"),
      start: () => Effect.die("A login trigger must not issue Start"),
      pause: () => Effect.die("A login trigger must not pause maintenance"),
      refresh: () => Effect.die("A login trigger resumes intent, not stale process metadata"),
      inspect: () => Effect.die("Process admission belongs to Resume"),
      stop: () => Effect.sync(() => { const stopped = running; wanted = false; running = false; return stopped }),
      resume: () => Effect.suspend(() => {
        resumes++
        if (failResume) return Effect.fail(new CollectorDaemonProcessError({ reason: "start", message: "Maintenance is pending" }))
        if (!wanted) return Effect.succeed(undefined)
        running = true
        return Effect.succeed({ intervalMs: 45000, concurrency: 2, pid: 10, startedAt: "2026-10-09T00:00:00Z",
          logFile: "/state/collector.log", created: true })
      })
    }))
  )
  return {
    run: <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(effect.pipe(Effect.provide(layer))),
    config: () => structuredClone(config), running: () => running, resumes: () => resumes,
    reconciliations,
    registration: (value: LoginStartupRegistration) => { registration = value },
    failState: () => { failState = true }, failInspect: () => { failInspect = true },
    failReconcile: () => { failReconcile = true }, failResume: () => { failResume = true }
  }
}

describe("login startup through the Application Interface", () => {
  it("reports enabled preference separately from native registration and defaults on", async () => {
    const client = fixture()
    client.registration({ state: "missing" })
    expect(await client.run(inspectLoginStartup())).toEqual({ enabled: true, state: "missing" })
    expect(await client.run(reconcileLoginStartup())).toEqual({ state: "registered" })
    expect(client.reconciliations).toEqual([{ enabled: true, savedPreference: undefined }])
    expect(client.resumes()).toBe(0)
  })

  it("keeps a failed manager observable without making preference inspection fail", async () => {
    const client = fixture()
    client.failInspect()
    expect(await client.run(inspectLoginStartup())).toEqual({ enabled: true, state: "unavailable", message: "User manager is unavailable" })
  })

  it("persists off before failed native unregistering so queued login entries remain inert", async () => {
    const client = fixture()
    client.failReconcile()
    await expect(client.run(setLoginStartup(false))).rejects.toMatchObject({ reason: "registration" })
    expect(client.config().autoStartEnabled).toBe(false)
    expect(client.reconciliations).toEqual([{ enabled: false, savedPreference: false }])
    expect(await client.run(runLoginStartup())).toEqual({ resumed: false })
    expect(client.resumes()).toBe(0)
  })

  it("does not change native registration when preference persistence fails", async () => {
    const client = fixture()
    client.failState()
    await expect(client.run(setLoginStartup(false))).rejects.toMatchObject({ _tag: "ClientConfigStoreError" })
    expect(client.reconciliations).toEqual([])
  })

  it("retries native reconciliation even if the saved preference already matches", async () => {
    const client = fixture({ ...configuredClient(), autoStartEnabled: false })
    await client.run(setLoginStartup(false))
    await client.run(setLoginStartup(true))
    expect(client.reconciliations).toEqual([{ enabled: false, savedPreference: false }, { enabled: true, savedPreference: true }])
    expect(client.resumes()).toBe(0)
  })

  it("leaves an on preference inert until tools are configured", async () => {
    const client = fixture(emptyClientConfig())
    expect(await client.run(reconcileLoginStartup())).toEqual({ state: "missing" })
    await client.run(setLoginStartup(true))
    expect(client.config().autoStartEnabled).toBe(true)
    expect(client.reconciliations.every(item => item.enabled === false)).toBe(true)
    expect(await client.run(runLoginStartup())).toEqual({ resumed: false })
    expect(client.resumes()).toBe(0)
  })

  it("resumes configured user intent without a remote authentication or workspace dependency", async () => {
    const client = fixture()
    expect(await client.run(runLoginStartup())).toEqual({ resumed: true })
    expect(client.running()).toBe(true)
    expect(client.resumes()).toBe(1)
  })

  it("does not revive user Stop when a registered login entry runs", async () => {
    const client = fixture()
    await client.run(CollectorDaemonProcess.use(process => process.stop()))
    expect(await client.run(runLoginStartup())).toEqual({ resumed: false })
    expect(client.resumes()).toBe(1)
    expect(client.running()).toBe(false)
  })

  it.each([{ projects: [] }, { enabledAdapterIds: [] }])("does not resume an empty collection scope: %j", async patch => {
    const client = fixture({ ...configuredClient(), ...patch })
    expect(await client.run(runLoginStartup())).toEqual({ resumed: false })
    expect(client.resumes()).toBe(0)
  })

  it("does not bypass local Adapter validation to run a broken collection scope", async () => {
    const client = fixture({ ...configuredClient(), adapters: [] })
    await expect(client.run(runLoginStartup())).rejects.toMatchObject({ reason: "project" })
    expect(client.resumes()).toBe(0)
  })

  it("reports a failed Collector admission without bypassing its maintenance guard", async () => {
    const client = fixture()
    client.failResume()
    await expect(client.run(runLoginStartup())).rejects.toMatchObject({ reason: "start" })
    expect(client.running()).toBe(false)
  })
})
