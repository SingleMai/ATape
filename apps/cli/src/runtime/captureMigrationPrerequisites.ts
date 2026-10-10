import { PublicationCapabilities, PublicationTargetProfile2, SourceCaptureVersion2,
  ClientConfig as ClientConfigSchema, AdapterManifest as AdapterManifestSchema, type ClientConfig } from "@atape/domain"
import { createHash } from "node:crypto"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { adapterPackageRoot } from "./adapterInstallation.ts"
import { AuthenticatedHTTPClient, makeAuthenticatedHTTPClientLayer, type AuthenticatedHTTPError } from "./authenticatedHTTPClient.ts"
import { inspectExistingCredentialIdentity, makeCredentialStoreLayer, makeHTTPAuthenticationGatewayLayer } from "./authenticationLayers.ts"
import type { NodeClientPaths } from "./clientPaths.ts"
import { readBoundedJSON } from "./runtimeFiles.ts"

export type CaptureMigrationScope = { readonly candidateConfig: ClientConfig; readonly wanted: boolean }
export type CaptureMigrationPrerequisiteReceipt = { readonly prerequisiteScopeFingerprint: string }
export class CaptureMigrationPrerequisiteError extends Schema.TaggedError<CaptureMigrationPrerequisiteError>()(
  "CaptureMigrationPrerequisiteError", {
    reason: Schema.Literals(["metadata", "binding", "authentication", "capability", "network", "changed", "deadline"]),
    message: Schema.String
  }
) {}

const failure = (reason: CaptureMigrationPrerequisiteError["reason"], message: string) =>
  new CaptureMigrationPrerequisiteError({ reason, message })
const localFailure = (cause: unknown) => cause instanceof CaptureMigrationPrerequisiteError ? cause :
  failure("metadata", "Could not verify existing capture migration prerequisites. Collection remains unchanged.")
const ordered = <A>(values: ReadonlyArray<A>) => [...values].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

const inspectScope = async (paths: NodeClientPaths, scope: CaptureMigrationScope) => {
  try {
    const config = Schema.decodeUnknownSync(ClientConfigSchema)(scope.candidateConfig)
    if (typeof scope.wanted !== "boolean" || new Set(config.enabledAdapterIds).size !== config.enabledAdapterIds.length ||
      new Set(config.adapters.map(adapter => adapter.adapterId)).size !== config.adapters.length ||
      new Set(config.projects.map(project => project.id)).size !== config.projects.length) throw new Error("Ambiguous capture scope.")
    const adapters = []
    const active = scope.wanted && config.toolsConfigured && config.projects.length > 0
    if (active) for (const id of [...config.enabledAdapterIds].sort()) {
      const adapter = config.adapters.find(item => item.adapterId === id)
      if (!adapter || !/^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/.test(adapter.packageName)) {
        throw new Error("Enabled candidate Adapter is missing or invalid.")
      }
      const root = await realpath(adapterPackageRoot(paths.adapterDirectory, adapter))
      const metadata = await readBoundedJSON(join(root, "package.json")) as { name?: unknown; version?: unknown; atapeAdapter?: unknown }
      const manifest = Schema.decodeUnknownSync(AdapterManifestSchema)(metadata.atapeAdapter)
      if (metadata.name !== adapter.packageName || metadata.version !== adapter.version || manifest.adapterId !== id ||
        !adapter.version.trim() || !manifest.displayName.trim() || manifest.harnesses.length === 0 || manifest.harnesses.some(harness => !harness.trim()) ||
        !manifest.entry.startsWith("./")) throw new Error("Candidate Adapter identity differs from its manifest.")
      const entry = await realpath(resolve(root, manifest.entry)), within = relative(root, entry)
      if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within) || !(await stat(entry)).isFile()) {
        throw new Error("Candidate Adapter entry leaves its installation.")
      }
      adapters.push({ id, root, manifest })
    }
    const required = new Map<string, { readonly instanceOrigin: string; readonly userId: string }>()
    if (adapters.some(adapter => adapter.manifest.sourceCapture === SourceCaptureVersion2)) {
      // activeInstanceOrigin is a console preference; every configured Project
      // participates in collection with the global enabled Adapter selection.
      for (const project of config.projects) required.set(JSON.stringify([project.instanceOrigin, project.userId]),
        { instanceOrigin: project.instanceOrigin, userId: project.userId })
    }
    const bindings = ordered([...required.values()])
    const credentials = []
    for (const binding of bindings) {
      const credential = await inspectExistingCredentialIdentity(paths.atapeHome, paths.credentialDirectory, binding.instanceOrigin)
      if (credential === undefined) throw failure("authentication", "An active capture account has no existing CLI credential. Migration is deferred.")
      if (credential.userId !== binding.userId) throw failure("binding", "An active capture Project belongs to another CLI account. Migration is deferred.")
      credentials.push(credential)
    }
    const identity = { protocol: "atape.capture-migration-prerequisites.v1", wanted: scope.wanted,
      toolsConfigured: config.toolsConfigured, enabledAdapterIds: [...config.enabledAdapterIds].sort(),
      // Include package/source identity and Project scope, but no locale, console
      // account preference, bearer bytes or authentication audit timestamps.
      candidates: ordered(config.adapters), projects: ordered(config.projects), adapters, credentials: ordered(credentials) }
    return { prerequisiteScopeFingerprint: createHash("sha256").update(JSON.stringify(identity)).digest("hex"), bindings }
  } catch (cause) { throw localFailure(cause) }
}

// This Node Interface also runs under the parent's short process/config/state
// ownership. It performs no network, locking, directory creation or source I/O.
export const inspectCaptureMigrationPrerequisitesScope = async (paths: NodeClientPaths,
  scope: CaptureMigrationScope): Promise<CaptureMigrationPrerequisiteReceipt> => {
  const snapshot = await inspectScope(paths, scope)
  return { prerequisiteScopeFingerprint: snapshot.prerequisiteScopeFingerprint }
}

const httpFailure = (error: AuthenticatedHTTPError) => failure(error.reason === "network" ? "network" :
  error.reason === "unauthenticated" ? "authentication" :
  error.reason === "identity_changed" || error.reason === "metadata_drift" ? "binding" : "capability",
  "Could not verify Server capture prerequisites. Migration is deferred before pausing collection.")

export const preflightCaptureMigrationPrerequisites = (paths: NodeClientPaths, scope: CaptureMigrationScope):
  Effect.Effect<CaptureMigrationPrerequisiteReceipt, CaptureMigrationPrerequisiteError, AuthenticatedHTTPClient> => Effect.gen(function*() {
    const before = yield* Effect.tryPromise({ try: () => inspectScope(paths, scope), catch: localFailure })
    if (before.bindings.length === 0) return { prerequisiteScopeFingerprint: before.prerequisiteScopeFingerprint }
    const http = yield* AuthenticatedHTTPClient
    yield* Effect.forEach(before.bindings, binding => http.request({ instanceOrigin: binding.instanceOrigin,
      expectedUserId: binding.userId, method: "GET", path: "/api/v1/publications/capabilities" }).pipe(
      Effect.mapError(httpFailure), Effect.flatMap(response => {
        if (response.status !== 200) return Effect.fail(failure(response.status === 401 || response.status === 403 ? "authentication" :
          response.status === 429 || response.status >= 500 ? "network" : "capability",
        "The Server did not accept its read-only capture prerequisite check. Migration is deferred."))
        return Schema.decodeUnknownEffect(PublicationCapabilities)(response.body).pipe(
          Effect.mapError(() => failure("capability", "The Server returned invalid capture capabilities. Migration is deferred.")),
          Effect.flatMap(capabilities => capabilities.targetProfiles?.includes(PublicationTargetProfile2) && capabilities.legacyAdoption === true
            ? Effect.void : Effect.fail(failure("capability", "SourceCapture v2 requires Server publication v2 targets and legacy adoption. Migration is deferred."))))
      })), { concurrency: 2, discard: true })
    const after = yield* Effect.tryPromise({ try: () => inspectScope(paths, scope), catch: localFailure })
    if (before.prerequisiteScopeFingerprint !== after.prerequisiteScopeFingerprint) return yield* failure("changed",
      "The capture account or candidate source scope changed during preflight. Retry before pausing collection.")
    return { prerequisiteScopeFingerprint: after.prerequisiteScopeFingerprint }
  }).pipe(Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail(failure("deadline",
    "The read-only capture prerequisite check exceeded its deadline. Migration is deferred before pausing collection.")) }))

// This graph deliberately excludes ClientConfigStore, capture state/journals,
// provider runtimes, policy keys, browser interaction and device monitoring.
export const makeCaptureMigrationPrerequisitesLayer = (paths: NodeClientPaths,
  environment: NodeJS.ProcessEnv = process.env, fetchImplementation: typeof fetch = globalThis.fetch) => {
  const credentials = makeCredentialStoreLayer(paths.atapeHome, paths.credentialDirectory, { readExisting: true })
  const authentication = makeHTTPAuthenticationGatewayLayer(fetchImplementation)
  const http = makeAuthenticatedHTTPClientLayer(fetchImplementation, environment.ATAPE_DEVELOPMENT_ALLOW_HTTP === "true",
    undefined, { omitDeviceReport: true }).pipe(Layer.provide(Layer.merge(credentials, authentication)))
  return Layer.merge(credentials, http)
}
