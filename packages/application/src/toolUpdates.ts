import type { AdapterInstallation } from "@atape/domain"
import { Effect, Schema } from "effect"
import { inspectClient, installAdapter } from "./clientManagement.ts"
import { officialSources } from "@atape/adapter-catalog"
import { CLIUpgradePlatform } from "./cliUpgrade.ts"
import { newer, stableVersion } from "./releaseVersion.ts"
import { CLISetupPlatform } from "./cliSetupPlatform.ts"

export class ToolUpdateError extends Schema.TaggedError<ToolUpdateError>()("ToolUpdateError", {
  message: Schema.String
}) {}

export type ToolRelease = {
  readonly id: string
  readonly label: string
  readonly version: string
  readonly enabled: boolean
  readonly source: "npm" | "local" | "custom" | "development"
  readonly status: "available" | "current" | "ahead" | "unavailable" | "manual" | "development"
  readonly latest?: string
  readonly commandEntryVersion?: string
  readonly installation?: AdapterInstallation
}

const releaseStatus = (current: string, latest: string) =>
  !stableVersion(current) ? "development" as const : newer(latest, current) ? "available" as const :
    newer(current, latest) ? "ahead" as const : "current" as const

export const inspectToolUpdates = Effect.fn("ToolUpdates.inspect")(function*(current: string, refresh = false) {
  const config = yield* inspectClient()
  const cli = yield* CLIUpgradePlatform
  const runtimeVersion = (yield* CLISetupPlatform).runtimeReleaseVersion
  const cliRow: ToolRelease = { id: "cli", label: "ATape", version: current, enabled: true,
    source: stableVersion(current) ? "npm" : "development", status: "development" }
  const cliCheck = stableVersion(current) ? cli.latest(!refresh).pipe(
    Effect.flatMap(bundle => {
      if (!stableVersion(bundle.version)) return Effect.fail(new ToolUpdateError({ message: "Invalid release metadata." }))
      const row = { ...cliRow, latest: bundle.version, status: releaseStatus(current, bundle.version) }
      return row.status === "current" ? cli.installedVersion().pipe(Effect.map(entry => stableVersion(entry) && newer(bundle.version, entry)
        ? { ...row, status: "available" as const, commandEntryVersion: entry } : row),
        Effect.mapError(() => new ToolUpdateError({ message: "Command entry metadata is unavailable." }))) : Effect.succeed(row)
    }),
    Effect.catch(() => Effect.succeed({ ...cliRow, status: "unavailable" as const }))
  ) : Effect.succeed(cliRow)
  const adapters = config.adapters.map(installation => {
    const official = officialSources.find(source => source.id === installation.adapterId && source.packageName === installation.packageName)
    const source = installation.upgradeSpec === installation.packageName ? "npm" as const : "local" as const
    const row: ToolRelease = { id: installation.adapterId, label: official?.label ?? installation.displayName,
      version: installation.version, enabled: config.enabledAdapterIds.includes(installation.adapterId),
      source: official ? source : "custom", status: "manual", installation }
    if (!official) return row
    return stableVersion(runtimeVersion) ? { ...row, latest: runtimeVersion, status: releaseStatus(row.version, runtimeVersion) }
      : { ...row, status: "development" as const }
  })
  const release = yield* cliCheck
  return [release, ...adapters]
})

// The displayed release is pinned. A stale screen cannot overwrite a newer
// installation; package maintenance never changes selection or starts sync.
export const updateToolRelease = Effect.fn("ToolUpdates.update")(function*(release: ToolRelease) {
  const runtimeVersion = (yield* CLISetupPlatform).runtimeReleaseVersion
  const installation = release.installation
  const official = officialSources.find(source => source.id === release.id && source.packageName === installation?.packageName)
  if (!installation || !official || !release.latest || release.latest !== runtimeVersion || !stableVersion(runtimeVersion) || !stableVersion(installation.version) ||
    newer(installation.version, release.latest) || release.status !== "available" && release.source !== "local") {
    return yield* new ToolUpdateError({ message: "Check for updates and select an available published release." })
  }
  return yield* installAdapter(`${official.packageName}@${release.latest}`, { installation, version: release.latest })
})
