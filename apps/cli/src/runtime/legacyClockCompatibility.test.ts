import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { AdapterCollectionLimits, AdapterProtocolVersion, CanonicalProfileVersion5,
  type AdapterInstallation, type AtapeAdapterModule, type CollectorCheckpoint, type LocalProject } from "@atape/domain"
import { expect, it } from "vitest"
import { legacyClockHostV059 } from "./fixtures/legacy-clock-host-v059.ts"

const repository = fileURLToPath(new URL("../../../..", import.meta.url))
const timestamp = "2026-10-11T00:00:00Z"
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

it("the genuine 0.5.9 Node Host refuses the current Codex clock profile before source access or checkpoint changes", async () => {
  const historical = await legacyClockHostV059()
  const home = await realpath(await mkdtemp(join(tmpdir(), "atape-old-host-codex-clock-")))
  const previousHome = process.env.ATAPE_CODEX_HOME
  try {
    expect(historical.proof).toMatchObject({ revision: "f05b3db36a6220f02c84d2a62a061cf882edca40", tag: "v0.5.9",
      dependencyMode: "historical-frozen-lock", runtime: { version: "0.5.9" },
      lockSha256: "c12a7cf11c5273d89e8dc172f299af2528d6f3e2140546d85d55303371aba68c" })
    expect(historical.proof.inputs).toEqual(expect.arrayContaining([
      { path: "apps/cli/src/runtime/adapterHost.ts", bytes: 17746,
        sha256: "e37baac2991f8ff50ada9735051827357eaefe8bbe23f18e5c7d75f4212d6c55" },
      { path: "apps/cli/src/runtime/collectorState.ts", bytes: 9189,
        sha256: "ae1823779a643965c5c9351c1f4e9033aa6bdf3ab7b9fb28565978813ce74cf9" },
      { path: "packages/domain/src/collector.ts", bytes: 21812,
        sha256: "0d33980139c92d774610d2d45e4f60c23724552cf7222511017a8c1bdd0daffd" },
      expect.objectContaining({ path: "pnpm-lock.yaml", sha256: historical.proof.lockSha256 })
    ]))

    const manifestBytes = await readFile(join(repository, "adapters/codex/package.json"))
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
      name: string; version: string; atapeAdapter: { entry: string; legacyCanonicalProfile: string }
    }
    expect(manifest.atapeAdapter.legacyCanonicalProfile).toBe(CanonicalProfileVersion5)
    const adapterDirectory = join(home, "adapters"), packageRoot = join(adapterDirectory, "node_modules", "@atape", "adapter-codex")
    const entry = resolve(packageRoot, manifest.atapeAdapter.entry)
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(join(packageRoot, "package.json"), manifestBytes)
    // Build the production entry unchanged. No source reader, factory or Host
    // Implementation is substituted to obtain the compatibility result.
    const require = createRequire(join(repository, "adapters/codex/package.json"))
    const esbuild = require("esbuild") as typeof import("esbuild")
    const built = await esbuild.build({ absWorkingDir: join(repository, "adapters/codex"), entryPoints: ["src/index.ts"],
      outfile: entry, bundle: true, platform: "node", format: "esm", target: "node24", legalComments: "eof",
      logLevel: "silent", metafile: true })
    const sourceProof = await Promise.all(Object.keys(built.metafile.inputs).filter(path => !path.includes("node_modules")).map(async path => {
      const bytes = await readFile(resolve(repository, "adapters/codex", path))
      return { path, bytes: bytes.length, sha256: digest(bytes) }
    }))
    const adapter: AdapterInstallation = { adapterId: "codex", packageName: manifest.name, version: manifest.version,
      upgradeSpec: manifest.name, displayName: "Codex", installedAt: timestamp, updatedAt: timestamp }
    const project: LocalProject = { id: "project", instanceOrigin: "https://atape.test", userId: "user", teamId: "team",
      teamSlug: "team", teamName: "Team", name: "Project", type: "directory", path: home, createdAt: timestamp, adapterIds: ["codex"] }
    const old = historical.Effect, oldLayer = historical.Layer
    const stateFile = join(home, "collector.json"), stateLayer = historical.makeCollectorStateLayer(stateFile)
    const readCheckpoint = () => old.runPromise(historical.CollectorStateStore.use(states =>
      states.snapshot(project.instanceOrigin, project.userId, project.id, adapter.adapterId)).pipe(old.provide(stateLayer)))
    const checkpoint: CollectorCheckpoint = { instanceOrigin: project.instanceOrigin, userId: project.userId, projectId: project.id,
      projectCreatedAt: project.createdAt, adapterId: adapter.adapterId, adapterVersion: "0.5.9", revision: 1,
      cursor: "retained-codex-checkpoint", rawObjects: [], canonicalPublished: true, updatedAt: timestamp }
    await old.runPromise(historical.CollectorStateStore.use(states => states.commit({
      instanceOrigin: project.instanceOrigin, userId: project.userId, projectId: project.id, adapterId: adapter.adapterId,
      expectedRevision: 0, checkpoint })).pipe(old.provide(stateLayer)))
    const before = await readCheckpoint(), frozenState = await readFile(stateFile)
    const runtimeLayer = historical.makeAdapterRuntimeLayer(adapterDirectory, undefined, { home }).pipe(oldLayer.provide(oldLayer.mergeAll(
      historical.makeProjectLocatorLayer(), oldLayer.succeed(historical.GitSourceAttribution, historical.GitSourceAttribution.of({
        forProject: () => () => old.die("A directory Project must not resolve Git attribution.")
      })))))
    process.env.ATAPE_CODEX_HOME = join(home, "absent-native-source")
    const refusal = await old.runPromise(old.scoped(historical.AdapterRuntimes.use(runtimes => runtimes.open(project, adapter))).pipe(
      old.provide(runtimeLayer), old.flip))
    expect(refusal).toMatchObject({ reason: "load", retryable: false,
      message: expect.stringContaining("Upgrade the ATape CLI to collect Codex with explicit source clock quality and stable tool identities.") })
    expect(refusal.message).not.toContain("Could not open the Codex archive")
    expect(await readCheckpoint()).toEqual(before)
    expect(await readFile(stateFile)).toEqual(frozenState)

    // The same untouched bundle reaches the real filesystem only when its
    // public factory receives the new Host fact and the caller starts collect.
    const current = await import(pathToFileURL(entry).href) as AtapeAdapterModule
    const admitted = await current.createAtapeAdapter({ protocolVersion: AdapterProtocolVersion,
      legacyCanonicalProfiles: [CanonicalProfileVersion5], adapter: { id: adapter.adapterId, version: adapter.version },
      project: { id: project.id, type: project.type, path: project.path }, signal: AbortSignal.timeout(5000) })
    try {
      expect("collect" in admitted).toBe(true)
      if (!("collect" in admitted)) throw new Error("Codex must retain the declared legacy runtime Interface.")
      await expect(admitted.collect({ protocolVersion: AdapterProtocolVersion, cursor: checkpoint.cursor, rawProgress: [],
        limits: AdapterCollectionLimits, rawCaptureEnabled: false, signal: AbortSignal.timeout(5000) })).rejects.toMatchObject({
        reason: "configuration", message: expect.stringContaining("Could not open the Codex archive")
      })
    } finally { await admitted.close?.() }
    expect(await readCheckpoint()).toEqual(before)
    expect(await readFile(stateFile)).toEqual(frozenState)
    console.info(JSON.stringify({ test: "genuine-0.5.9-legacy-codex-clock-refusal", revision: historical.proof.revision,
      lockSha256: historical.proof.lockSha256, dependencyMode: historical.proof.dependencyMode,
      runtime: historical.proof.runtime, toolchain: historical.proof.toolchain, bundle: historical.proof.bundle,
      host: historical.proof.inputs.filter(input => ["apps/cli/src/runtime/adapterHost.ts", "packages/domain/src/collector.ts",
        "apps/cli/src/runtime/collectorState.ts"].includes(input.path)),
      adapter: { manifestSha256: digest(manifestBytes), bundleSha256: digest(await readFile(entry)), inputs: sourceProof },
      oldHostRefusedBeforeSourcePathError: true, checkpointBytesPreserved: true,
      sourceIOCount: "not-instrumented", acceptanceScope: "selected-upgrade-preflight" }))
  } finally {
    if (previousHome === undefined) delete process.env.ATAPE_CODEX_HOME
    else process.env.ATAPE_CODEX_HOME = previousHome
    await historical.cleanup()
    await rm(home, { recursive: true, force: true })
  }
}, 180_000)
