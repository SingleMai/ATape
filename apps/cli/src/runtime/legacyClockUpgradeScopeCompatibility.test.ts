import { CLICredentialStore } from "@atape/application"
import { CanonicalCapabilitiesProtocol, CanonicalProfileVersion3, emptyClientConfig, type ClientConfig, type StoredCLICredential } from "@atape/domain"
import { Effect, Layer } from "effect"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { expect, it } from "vitest"
import { makeCredentialStoreLayer } from "./authenticationLayers.ts"
import { AuthenticatedHTTPClient } from "./authenticatedHTTPClient.ts"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import { inspectCaptureMigrationPrerequisitesScope, preflightCaptureMigrationPrerequisites } from "./captureMigrationPrerequisites.ts"
import { legacyClockHostV059 } from "./fixtures/legacy-clock-host-v059.ts"

it("preserves strict old-parent scope binding: active Codex v3 differs, stopped scope matches", async () => {
  const historical = await legacyClockHostV059()
  const home = await realpath(await mkdtemp(join(tmpdir(), "atape-old-codex-upgrade-scope-")))
  const paths = defaultNodeClientPaths({ ATAPE_HOME: home })
  try {
    expect(historical.proof.runtime).toEqual({ version: "0.5.9", captureStateContract: "atape.client.v3-capture.v2" })
    const old = historical.Effect
    const manifestBytes = await readFile(new URL("../../../../adapters/codex/package.json", import.meta.url))
    const manifest = JSON.parse(manifestBytes.toString("utf8"))
    expect(manifest.atapeAdapter.legacyCanonicalProfile).toBe(CanonicalProfileVersion3)
    const root = join(paths.adapterDirectory, "node_modules", "@atape", "adapter-codex")
    const entry = resolve(root, manifest.atapeAdapter.entry)
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(join(root, "package.json"), manifestBytes)
    await writeFile(entry, 'throw Error("Scope checks must not import the Codex factory")')
    const timestamp = "2026-10-11T00:00:00Z"
    const config: ClientConfig = { ...emptyClientConfig(), toolsConfigured: true, enabledAdapterIds: ["codex"],
      adapters: [{ adapterId: "codex", packageName: manifest.name, version: manifest.version, upgradeSpec: manifest.name,
        displayName: "Codex", installedAt: timestamp, updatedAt: timestamp }],
      projects: [{ id: "project", instanceOrigin: "https://atape.test", userId: "user", teamId: "team", teamSlug: "team",
        teamName: "Team", name: "Project", type: "directory", path: "/absent/provider-source-must-not-be-read", createdAt: timestamp }] }
    const credential: StoredCLICredential = { version: 1, instanceOrigin: "https://atape.test", apiOrigin: "https://api.atape.test",
      credential: "atc_v1_upgrade-scope-fixture", credentialId: "fixture-credential", capabilityVersion: "atape-cli.v1", createdAt: timestamp,
      user: { id: "user", displayName: "User" } }
    await Effect.runPromise(CLICredentialStore.use(store => store.replace({ credential })).pipe(
      Effect.provide(makeCredentialStoreLayer(home, paths.credentialDirectory))))
    const stateLayer = historical.makeCollectorStateLayer(paths.collectorStateFile)
    const project = config.projects[0]!, adapter = config.adapters[0]!
    await old.runPromise(historical.CollectorStateStore.use(store => store.commit({
      instanceOrigin: project.instanceOrigin, userId: project.userId, projectId: project.id, adapterId: adapter.adapterId,
      expectedRevision: 0, checkpoint: { instanceOrigin: project.instanceOrigin, userId: project.userId, projectId: project.id,
        projectCreatedAt: project.createdAt, adapterId: adapter.adapterId, adapterVersion: "0.5.9", revision: 1,
        cursor: "retained-source-cursor", canonicalPublished: true, rawObjects: [{ sourceSessionId: "session", sourceObjectId: "transcript",
          sourceName: "session.jsonl", mediaType: "application/x-ndjson", sourceGeneration: "retained-generation", sourceOffset: 100,
          serverGeneration: 1, serverOffset: 80, finalized: false }], updatedAt: timestamp }
    })).pipe(old.provide(stateLayer)))
    const stateBytes = await readFile(paths.collectorStateFile)
    const currentRequests: string[] = [], oldRequests: string[] = []
    const currentHTTP = Layer.succeed(AuthenticatedHTTPClient, { request: input => Effect.sync(() => {
      currentRequests.push(input.path)
      if (input.path !== "/api/v1/ingestion/canonical/capabilities") throw Error("Unexpected capability request")
      return { status: 200, body: { protocol: CanonicalCapabilitiesProtocol, canonicalProfiles: [CanonicalProfileVersion3] } }
    }) })
    const oldHTTP = historical.Layer.succeed(historical.AuthenticatedHTTPClient, { request: input => old.sync(() => {
      oldRequests.push(input.path)
      throw Error("The genuine old legacy scope must not require publication")
    }) })
    const active = { candidateConfig: config, wanted: true }
    const oldActive = await historical.inspectCaptureMigrationPrerequisitesScope(paths, active)
    const currentActive = await inspectCaptureMigrationPrerequisitesScope(paths, active)
    expect(currentActive).not.toEqual(oldActive)
    expect(await old.runPromise(historical.preflightCaptureMigrationPrerequisites(paths, active).pipe(old.provide(oldHTTP))))
      .toEqual(oldActive)
    expect(await Effect.runPromise(preflightCaptureMigrationPrerequisites(paths, active).pipe(Effect.provide(currentHTTP))))
      .toEqual(currentActive)
    expect(oldRequests).toEqual([])
    expect(currentRequests).toEqual(["/api/v1/ingestion/canonical/capabilities"])

    currentRequests.length = 0
    const stopped = { candidateConfig: config, wanted: false }
    const oldStopped = await historical.inspectCaptureMigrationPrerequisitesScope(paths, stopped)
    const currentStopped = await inspectCaptureMigrationPrerequisitesScope(paths, stopped)
    expect(currentStopped).toEqual(oldStopped)
    expect(await old.runPromise(historical.preflightCaptureMigrationPrerequisites(paths, stopped).pipe(old.provide(oldHTTP))))
      .toEqual(oldStopped)
    expect(await Effect.runPromise(preflightCaptureMigrationPrerequisites(paths, stopped).pipe(Effect.provide(currentHTTP))))
      .toEqual(currentStopped)
    expect(oldRequests).toEqual([]); expect(currentRequests).toEqual([])
    expect(await readFile(join(root, "package.json"))).toEqual(manifestBytes)
    expect(await readFile(paths.collectorStateFile)).toEqual(stateBytes)
    console.info(JSON.stringify({ test: "genuine-0.5.9-parent-codex-clock-scope", provenance: {
      revision: historical.proof.revision, lockSha256: historical.proof.lockSha256, toolchain: historical.proof.toolchain,
      prerequisite: historical.proof.inputs.find(input => input.path === "apps/cli/src/runtime/captureMigrationPrerequisites.ts"),
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex") },
      oldActive: oldActive.prerequisiteScopeFingerprint, currentActive: currentActive.prerequisiteScopeFingerprint,
      oldStopped: oldStopped.prerequisiteScopeFingerprint, currentStopped: currentStopped.prerequisiteScopeFingerprint,
      currentDirectProfileAffirmed: true, checkpointBytesPreserved: true,
      acceptanceScope: "public-prerequisite-Interfaces", fullManagedUpgradeExecuted: false }))
  } finally { await historical.cleanup(); await rm(home, { recursive: true, force: true }) }
}, 180_000)
