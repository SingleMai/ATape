import type { AdapterInstallation } from "@atape/domain"
import { Context, Effect, Schema } from "effect"

export class CLIExperienceError extends Schema.TaggedError<CLIExperienceError>()("CLIExperienceError", {
  reason: Schema.Literals(["io", "changed", "selection", "upgrade", "unauthenticated"]),
  message: Schema.String,
  instanceOrigin: Schema.optionalKey(Schema.String),
  adapterId: Schema.optionalKey(Schema.String)
}) {}

export type DirectorySuggestion = {
  readonly path: string
  // A local .git entry is a browsing hint, not repository identity or authorization.
  readonly git: boolean
  readonly parent?: true
}

// Local filesystem/package inspection is a real Adapter Seam. It never reads
// conversation bodies. Creation keys survive interruption before local commit.
export class CLISetupPlatform extends Context.Service<CLISetupPlatform, {
  detectSources(): Effect.Effect<ReadonlyArray<string>, CLIExperienceError>
  suggestDirectories(input: string, query?: string): Effect.Effect<ReadonlyArray<DirectorySuggestion>, CLIExperienceError>
  supportsGit(adapter: AdapterInstallation): Effect.Effect<boolean, CLIExperienceError>
  creationKey(scope: { readonly instanceOrigin: string; readonly userId: string; readonly teamId: string; readonly path: string; readonly name: string }): Effect.Effect<string, CLIExperienceError>
}>()("atape/application/CLISetupPlatform") {}
