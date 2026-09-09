import { CollectorDeviceGateway, scopeCollectorReport } from "@atape/application"
import { emptyCollectorRunState, type CollectorRunState, type ClientConfig, type CLIDeviceMetadata } from "@atape/domain"
import { hostname, platform, arch } from "node:os"
import { Effect, Layer, Semaphore } from "effect"
import { cliVersion } from "../version.ts"
import { AuthenticatedHTTPClient } from "./authenticatedHTTPClient.ts"
import { latestPublishedVersion } from "./publishedVersions.ts"

export const makeDeviceMonitoringLayer = (home: string, config: Effect.Effect<ClientConfig, unknown>,
  fetchReleases: typeof globalThis.fetch = globalThis.fetch,
  readStatus: Effect.Effect<CollectorRunState, unknown> = Effect.succeed(emptyCollectorRunState())) => Layer.effect(CollectorDeviceGateway, Effect.gen(function*() {
  const http = yield* AuthenticatedHTTPClient
  const lock = yield* Semaphore.make(1)
  let versions: Record<string, string> = {}
  let checkedAt: string | undefined
  let nextCheck = 0
  return CollectorDeviceGateway.of({ publish: (snapshot) => lock.withPermit(Effect.gen(function*() {
    const local = yield* config
    const persisted = yield* readStatus.pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (Date.now() >= nextCheck) {
      nextCheck = Date.now() + 60 * 60 * 1_000
      versions = yield* Effect.tryPromise({ try: async (signal) => {
        const packages = ["@atape/cli", ...local.adapters.map(a => a.packageName)
          .filter(name => name === "@atape/adapter-codex" || name === "@atape/adapter-claude")]
        const entries = await Promise.all([...new Set(packages)].map(async name => {
          try { return [name, await latestPublishedVersion(home, name, true, signal, fetchReleases)] as const }
          catch { return [name, undefined] as const }
        }))
        return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined))
      }, catch: () => new Error("Version check unavailable") })
      checkedAt = new Date().toISOString()
    }
    const device: CLIDeviceMetadata = { name: Array.from(hostname()).slice(0, 50).join(""), platform: `${platform()} ${arch()}`, version: cliVersion,
      ...(versions["@atape/cli"] ? { latestVersion: versions["@atape/cli"] } : {}),
      ...(checkedAt ? { versionCheckedAt: checkedAt } : {}),
      adaptersTruncated: local.adapters.length > 32,
      adapters: local.adapters.slice(0, 32).map(adapter => ({ id: adapter.adapterId, packageName: adapter.packageName, version: adapter.version,
        enabled: local.enabledAdapterIds.includes(adapter.adapterId),
        ...(versions[adapter.packageName] ? { latestVersion: versions[adapter.packageName] } : {}) })) }
    const accounts = [...new Map(local.projects.map(project => [`${project.instanceOrigin}\0${project.userId}`, project])).values()]
    yield* Effect.forEach(accounts, account => Effect.gen(function*() {
      const sync = scopeCollectorReport(snapshot, local, account, persisted)
      // Keep the complete envelope beneath the transport header ceiling.
      let report = { ...device, sync }
      while (Buffer.byteLength(JSON.stringify(report)) > 5_900 && report.sync.jobs.length > 0) {
        report = { ...report, sync: { ...report.sync, jobs: report.sync.jobs.slice(0, -1), jobsTruncated: true } }
      }
      while (Buffer.byteLength(JSON.stringify(report)) > 5_900 && (report.adapters?.length ?? 0) > 0) {
        report = { ...report, adapters: report.adapters!.slice(0, -1), adaptersTruncated: true }
      }
      const response = yield* http.request({ instanceOrigin: account.instanceOrigin, expectedUserId: account.userId,
        path: "/api/v1/users/me", method: "GET", deviceReport: report })
      if (response.status !== 200) yield* Effect.logWarning("Device status report rejected", { status: response.status })
    }).pipe(Effect.catch(() => Effect.logWarning("Device status report unavailable; collection continues"))), { concurrency: 2 })
  }).pipe(Effect.catch(() => Effect.logWarning("Could not prepare device status report; collection continues")))) })
}))
