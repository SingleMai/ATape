import { CollectorDeviceGateway } from "@atape/application"
import { emptyClientConfig, type ClientConfig } from "@atape/domain"
import { Effect, Layer } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { AuthenticatedHTTPClient, type AuthenticatedHTTPRequest } from "./authenticatedHTTPClient.ts"
import { makeDeviceMonitoringLayer } from "./deviceMonitoring.ts"

it.each(["codex", "opencode"])("scopes %s device jobs to account and instance, retains successes, and caches version lookups", async adapterId => {
  const home = await mkdtemp(join(tmpdir(), "atape-device-"))
  const requests: AuthenticatedHTTPRequest[] = []
  let checks = 0
  const project = { id: "one", instanceOrigin: "https://one.example", userId: "user-one", teamId: "t", teamSlug: "t", teamName: "Team",
    name: "Project one", type: "directory" as const, path: "/private/local-path", createdAt: "2026-09-09T00:00:00Z" }
  const config: ClientConfig = { ...emptyClientConfig(), projects: [project, { ...project, id: "two", instanceOrigin: "https://two.example", userId: "user-two", name: "Private other project" }],
    enabledAdapterIds: [adapterId], adapters: [{ adapterId: adapterId, packageName: `@atape/adapter-${adapterId}`, displayName: "Codex", upgradeSpec: `@atape/adapter-${adapterId}`, version: "0.4.4", installedAt: project.createdAt, updatedAt: project.createdAt }] }
  const layer = makeDeviceMonitoringLayer(home, Effect.succeed(config), (async input => {
    checks++
    const name = decodeURIComponent(new URL(String(input)).pathname.slice(1).replace(/\/latest$/, ""))
    return Response.json({ name, version: "0.4.5" })
  }) as typeof fetch, Effect.succeed({ version: 1, jobs: [{ projectId: "one", adapterId: adapterId, lastAttemptAt: project.createdAt, lastSuccessAt: project.createdAt }] })).pipe(
    Layer.provide(Layer.succeed(AuthenticatedHTTPClient, { request: request => Effect.sync(() => { requests.push(request); return { status: 200 } }) }))
  )
  try {
    await Effect.gen(function*() {
      const gateway = yield* CollectorDeviceGateway
      yield* gateway.publish({ phase: "waiting", jobsTruncated: false, jobs: [{ projectId: "one", projectName: "Project one", adapterId: adapterId, state: "failed", reason: "transport", hasMore: false }] })
      yield* gateway.publish({ phase: "waiting", jobsTruncated: false, jobs: [] })
    }).pipe(Effect.provide(layer), Effect.runPromise)
    expect(checks).toBe(2)
    expect(requests).toHaveLength(4)
    const first = requests.find(request => request.expectedUserId === "user-one")!
    expect(first.deviceReport?.sync.jobs).toEqual([expect.objectContaining({ projectId: "one", state: "failed", lastSuccessAt: project.createdAt })])
    expect(first.deviceReport?.adapters?.[0]?.packageName).toBe(`@atape/adapter-${adapterId}`)
    expect(first.deviceReport?.latestVersion).toBe("0.4.5")
    expect(first.deviceReport?.adapters?.[0]?.latestVersion).toBe("0.4.5")
    expect(JSON.stringify(first.deviceReport)).not.toContain("Private other project")
    expect(JSON.stringify(requests)).not.toContain("/private/local-path")
    expect(requests.every(request => Buffer.from(JSON.stringify(request.deviceReport)).toString("base64url").length <= 8192)).toBe(true)
  } finally { await rm(home, { recursive: true, force: true }) }
})

it("keeps reporting status when version discovery and the report transport fail", async () => {
  const home = await mkdtemp(join(tmpdir(), "atape-device-failure-"))
  const config = { ...emptyClientConfig(), projects: [{ id: "p", instanceOrigin: "https://one.example", userId: "u", teamId: "t", teamSlug: "t", teamName: "t", name: "p", type: "directory" as const, path: "/p", createdAt: "2026-09-09T00:00:00Z" }] }
  let attempts = 0
  const layer = makeDeviceMonitoringLayer(home, Effect.succeed(config), (async () => { throw new Error("offline") }) as typeof fetch).pipe(
    Layer.provide(Layer.succeed(AuthenticatedHTTPClient, { request: request => Effect.sync(() => {
      attempts++
      expect(request.deviceReport).not.toHaveProperty("latestVersion")
      return { status: 503 }
    }) }))
  )
  try {
    await CollectorDeviceGateway.use(gateway => gateway.publish({ phase: "waiting", jobs: [], jobsTruncated: false })).pipe(Effect.provide(layer), Effect.runPromise)
    expect(attempts).toBe(1)
  } finally { await rm(home, { recursive: true, force: true }) }
})
