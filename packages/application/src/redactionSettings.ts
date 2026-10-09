import { Context, Effect, Schema } from "effect"
import { compileRedactionPolicy, validateRedactionConfiguration, type RedactionConfiguration } from "./redaction.ts"

export type RedactionSettingsSnapshot = {
  readonly revision: string
  readonly configuration: RedactionConfiguration
  readonly configFile: string
  readonly origin: "default" | "environment"
  readonly exists: boolean
  readonly literalCount: number
  readonly validation: "valid" | "invalid"
}

export class RedactionSettingsError extends Schema.TaggedError<RedactionSettingsError>()("RedactionSettingsError", {
  reason: Schema.Literals(["configuration", "environment", "io", "conflict"]), message: Schema.String
}) {}

export type RedactionConfigurationSource = {
  readonly revision: string
  readonly content: string | undefined
  readonly configFile: string
  readonly origin: "default" | "environment"
  readonly exists: boolean
  readonly secretValues: ReadonlyArray<string>
}

/** The filesystem is the real Seam. Validation, repair eligibility and optimistic
 * concurrency remain behind the Settings Interface rather than in presentation. */
export class RedactionConfigurationStore extends Context.Service<RedactionConfigurationStore, {
  readonly read: () => Effect.Effect<RedactionConfigurationSource, RedactionSettingsError>
  readonly replace: (expectedRevision: string, configuration: RedactionConfiguration) => Effect.Effect<RedactionConfigurationSource, RedactionSettingsError>
}>()("@atape/RedactionConfigurationStore") {}

const configurationFailure = () => new RedactionSettingsError({ reason: "configuration", message: "The redaction configuration is invalid or exceeds its admitted limits." })
const environmentFailure = () => new RedactionSettingsError({ reason: "environment", message: "The effective redaction environment values are invalid or exceed their admitted limits." })
const validationKey = () => Effect.sync(() => globalThis.crypto.getRandomValues(new Uint8Array(32)))
const decode = (configuration: unknown) => validateRedactionConfiguration(configuration).pipe(
  Effect.flatMap(normalized => validateRedactionConfiguration(`${JSON.stringify(normalized)}\n`)),
  Effect.mapError(configurationFailure))

const validateEnvironment = (source: RedactionConfigurationSource, installationKey: Uint8Array) =>
  compileRedactionPolicy({ secretValues: source.secretValues, installationKey }).pipe(Effect.mapError(environmentFailure))

const compile = (configuration: RedactionConfiguration, source: RedactionConfigurationSource, installationKey: Uint8Array) =>
  compileRedactionPolicy({ configuration, secretValues: source.secretValues, installationKey }).pipe(Effect.mapError(configurationFailure))

const snapshot = (source: RedactionConfigurationSource, configuration: RedactionConfiguration, validation: "valid" | "invalid"): RedactionSettingsSnapshot => ({
  revision: source.revision, configuration, configFile: source.configFile, origin: source.origin,
  exists: source.exists, literalCount: new Set(source.secretValues).size, validation
})

/** A schema-valid file with invalid expressions stays editable. Malformed JSON or
 * schema is a typed failure and cannot become an implicitly repaired overwrite. */
export const inspectRedactionSettings = (): Effect.Effect<RedactionSettingsSnapshot, RedactionSettingsError, RedactionConfigurationStore> => Effect.gen(function*() {
  const store = yield* RedactionConfigurationStore
  const source = yield* store.read()
  const configuration = yield* decode(source.content ?? {})
  const key = yield* validationKey()
  yield* validateEnvironment(source, key)
  const validation = yield* compile(configuration, source, key).pipe(
    Effect.as("valid" as const), Effect.catch(() => Effect.succeed("invalid" as const)))
  return snapshot(source, configuration, validation)
})

/** Uses a temporary identity, never the Collector key or its progress. */
export const validateRedactionSettings = (configuration: unknown): Effect.Effect<RedactionConfiguration, RedactionSettingsError, RedactionConfigurationStore> => Effect.gen(function*() {
  const store = yield* RedactionConfigurationStore
  const source = yield* store.read()
  const normalized = yield* decode(configuration)
  const key = yield* validationKey()
  yield* validateEnvironment(source, key)
  yield* compile(normalized, source, key)
  return normalized
})

/** The Adapter repeats the revision comparison under its file lock immediately
 * before replacement. External editors must cooperate to share that exclusion. */
export const saveRedactionSettings = (input: { readonly expectedRevision: string; readonly configuration: unknown }): Effect.Effect<RedactionSettingsSnapshot, RedactionSettingsError, RedactionConfigurationStore> => Effect.gen(function*() {
  const store = yield* RedactionConfigurationStore
  const current = yield* store.read()
  if (current.revision !== input.expectedRevision) return yield* Effect.fail(new RedactionSettingsError({
    reason: "conflict", message: "The redaction configuration changed. Reload it before saving again." }))
  yield* decode(current.content ?? {})
  const configuration = yield* decode(input.configuration)
  const key = yield* validationKey()
  yield* validateEnvironment(current, key)
  yield* compile(configuration, current, key)
  const saved = yield* store.replace(input.expectedRevision, configuration)
  return snapshot(saved, configuration, "valid")
})
