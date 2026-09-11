import type { AdapterInstallation } from "@atape/domain"
import { Context, Effect, Schema } from "effect"
import { inspectClient, installAdapter } from "./clientManagement.ts"
import { officialSources } from "@atape/adapter-catalog"
import { CLIUpgradePlatform } from "./cliUpgrade.ts"
import { newer, stableVersion } from "./releaseVersion.ts"

export class ToolUpdateError extends Schema.TaggedError<ToolUpdateError>()("ToolUpdateError", {
  message: Schema.String
}) {}

// Official npm release metadata is the external Seam; local/custom packages
// are displayed but never guessed at or redirected to a different publisher.
export class AdapterReleases extends Context.Service<AdapterReleases, {
  latest(packageName: string, cached: boolean): Effect.Effect<string, ToolUpdateError>
}>()("atape/application/AdapterReleases") {}

export type ToolRelease = {
  readonly id: string
  readonly label: string
  readonly version: string
  readonly enabled: boolean
  readonly source: "npm" | "local" | "custom" | "development"
  readonly status: "available" | "current" | "ahead" | "unavailable" | "manual" | "development"
  readonly latest?: string
  readonly installation?: AdapterInstallation
}

const releaseStatus = (current: string, latest: string) =>
  !stableVersion(current) ? "development" as const : newer(latest, current) ? "available" as const :
    newer(current, latest) ? "ahead" as const : "current" as const

export const inspectToolUpdates = Effect.fn("ToolUpdates.inspect")(function*(current: string, refresh = false) {
  const config = yield* inspectClient()
  const cli = yield* CLIUpgradePlatform
  const registry = yield* AdapterReleases
  const cliRow: ToolRelease = { id: "cli", label: "ATape", version: current, enabled: true,
    source: stableVersion(current) ? "npm" : "development", status: "development" }
  const cliCheck = stableVersion(current) ? cli.latest(!refresh).pipe(
    Effect.flatMap(latest => stableVersion(latest)
      ? Effect.succeed({ ...cliRow, latest, status: releaseStatus(current, latest) })
      : Effect.fail(new ToolUpdateError({ message: "Invalid release metadata." }))),
    Effect.catch(() => Effect.succeed({ ...cliRow, status: "unavailable" as const }))
  ) : Effect.succeed(cliRow)
  const adapterChecks = Effect.forEach(config.adapters, installation => Effect.gen(function*() {
    const official = officialSources.find(source => source.id === installation.adapterId && source.packageName === installation.packageName)
    const source = installation.upgradeSpec === installation.packageName ? "npm" as const : "local" as const
    const row: ToolRelease = { id: installation.adapterId, label: official?.label ?? installation.displayName,
      version: installation.version, enabled: config.enabledAdapterIds.includes(installation.adapterId),
      source: official ? source : "custom", status: "manual", installation }
    if (!official) return row
    return yield* registry.latest(official.packageName, !refresh).pipe(
      Effect.flatMap(latest => stableVersion(latest)
        ? Effect.succeed({ ...row, latest, status: releaseStatus(row.version, latest) })
        : Effect.fail(new ToolUpdateError({ message: "Invalid release metadata." }))),
      Effect.catch(() => Effect.succeed({ ...row, status: "unavailable" as const }))
    )
  }), { concurrency: 2 })
  const [release, adapters] = yield* Effect.all([cliCheck, adapterChecks], { concurrency: 2 })
  return [release, ...adapters]
})

// The displayed release is pinned. A stale screen cannot overwrite a newer
// installation; package maintenance never changes selection or starts sync.
export const updateToolRelease = Effect.fn("ToolUpdates.update")(function*(release: ToolRelease) {
  const installation = release.installation
  const official = officialSources.find(source => source.id === release.id && source.packageName === installation?.packageName)
  if (!installation || !official || !release.latest || !stableVersion(release.latest) || !stableVersion(installation.version) ||
    newer(installation.version, release.latest) || release.status !== "available" && release.source !== "local") {
    return yield* new ToolUpdateError({ message: "Check for updates and select an available published release." })
  }
  return yield* installAdapter(`${official.packageName}@${release.latest}`, { installation, version: release.latest })
})
