import {
  ClientConfigStore,
  ClientMigration,
  adoptClientCheckpoint,
  inspectClient
} from "@atape/application"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeConfigStoreLayer } from "./clientLayers.ts"
import { makeCollectorStateLayer } from "./collectorLayers.ts"
import {
  makeClientMigrationLayer,
  type ClientMigrationPaths
} from "./clientMigrationLayers.ts"

const temporaryDirectories: Array<string> = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const fixture = async () => {
  const parent = await mkdtemp(join(tmpdir(), "atape-migration-test-"))
  temporaryDirectories.push(parent)
  const legacyRoot = join(parent, "legacy")
  const atapeHome = join(parent, ".atape")
  const paths: ClientMigrationPaths = {
    atapeHome,
    configFile: join(atapeHome, "config", "client.json"),
    legacy: {
      configFile: join(legacyRoot, "config", "config.json"),
      collectorStateFile: join(legacyRoot, "state", "collector.json"),
      collectorProcessFile: join(legacyRoot, "state", "collector-process.json"),
      collectorStatusFile: join(legacyRoot, "state", "collector-status.json"),
      collectorLogFile: join(legacyRoot, "state", "collector.log"),
      adapterDirectory: join(legacyRoot, "data", "adapters")
    }
  }
  await Promise.all([
    mkdir(join(legacyRoot, "config"), { recursive: true }),
    mkdir(join(legacyRoot, "state"), { recursive: true }),
    mkdir(paths.legacy.adapterDirectory, { recursive: true })
  ])
  await writeFile(paths.legacy.configFile, JSON.stringify({
    version: 1,
    serverUrl: "https://old.example",
    userId: "untrusted-old-user",
    projects: [],
    adapters: []
  }))
  await writeFile(paths.legacy.collectorStateFile, JSON.stringify({
    version: 1, installationId: "old-installation", checkpoints: []
  }))
  await writeFile(join(paths.legacy.adapterDirectory, "package.json"), "{}")
  const layer = makeClientMigrationLayer(paths)
  const run = <A, E>(effect: Effect.Effect<A, E, ClientMigration>) =>
    effect.pipe(Effect.provide(layer), Effect.runPromise)
  return { parent, paths, run }
}

describe("v0.1 local migration Adapter", () => {
  it("plans authority disposal and archives without changing the originals", async () => {
    const client = await fixture()
    const plan = await client.run(ClientMigration.use((migration) => migration.plan()))
    expect(plan).toMatchObject({
      version: "atape.local-migration.v1",
      destinationRoot: client.paths.atapeHome,
      canApply: true
    })
    expect(plan.sources.map((source) => source.kind)).toEqual(["config", "collector_state", "adapters"])
    expect(plan.discardedAuthority.join(" ")).toContain("serverUrl")

    const result = await client.run(ClientMigration.use((migration) => migration.apply()))
    expect(JSON.parse(await readFile(client.paths.configFile, "utf8"))).toEqual({
      version: 2, projects: [], adapters: []
    })
    expect((await lstat(client.paths.configFile)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(client.paths.legacy.configFile, "utf8")))
      .toMatchObject({ version: 1, userId: "untrusted-old-user" })
    expect(await readdir(join(result.importDirectory, "config"))).toEqual(["config.json"])
    expect(await readdir(join(result.importDirectory, "data", "adapters"))).toEqual(["package.json"])
  })

  it("blocks normal configuration reads until legacy data is explicitly migrated", async () => {
    const client = await fixture()
    const layer = makeConfigStoreLayer(client.paths.configFile, client.paths.legacy)
    await expect(inspectClient().pipe(Effect.provide(layer), Effect.runPromise))
      .rejects.toMatchObject({ reason: "migration_required" })
    await expect(lstat(client.paths.configFile)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses migration while the legacy Collector process is live", async () => {
    const client = await fixture()
    await writeFile(client.paths.legacy.collectorProcessFile, JSON.stringify({ pid: process.pid }))
    const plan = await client.run(ClientMigration.use((migration) => migration.plan()))
    expect(plan.canApply).toBe(false)
    expect(plan.blockers.join(" ")).toContain("Collector")
    await expect(client.run(ClientMigration.use((migration) => migration.apply())))
      .rejects.toMatchObject({ reason: "collector_running" })
  })

  it("will not overwrite a v0.2 configuration", async () => {
    const client = await fixture()
    await mkdir(join(client.paths.atapeHome, "config"), { recursive: true, mode: 0o700 })
    await writeFile(client.paths.configFile, JSON.stringify({ version: 2, projects: [], adapters: [] }))
    await expect(client.run(ClientMigration.use((migration) => migration.apply())))
      .rejects.toMatchObject({ reason: "conflict" })
  })

  it("adopts an archived cursor only after binding an explicit Instance/User/Project/Adapter tuple", async () => {
    const client = await fixture()
    await writeFile(client.paths.legacy.collectorStateFile, JSON.stringify({
      version: 1,
      installationId: "old-installation",
      checkpoints: [{
        projectId: "legacy-project",
        projectCreatedAt: "2025-01-01T00:00:00Z",
        adapterId: "legacy-adapter",
        adapterVersion: "0.1.0",
        revision: 7,
        cursor: "legacy-cursor",
        rawObjects: [],
        updatedAt: "2025-01-02T00:00:00Z"
      }]
    }))
    const migrated = await client.run(ClientMigration.use((migration) => migration.apply()))
    await writeFile(client.paths.configFile, JSON.stringify({
      version: 2,
      activeInstanceOrigin: "https://atape.net",
      projects: [{
        id: "project-1",
        instanceOrigin: "https://atape.net",
        userId: "user-1",
        teamId: "team-1",
        teamSlug: "acme",
        teamName: "Acme",
        name: "Payments",
        type: "git",
        path: "/work/payments",
        adapterIds: ["codex"],
        createdAt: "2026-09-06T00:00:00Z"
      }],
      adapters: [{
        adapterId: "codex",
        packageName: "@atape/adapter-codex",
        upgradeSpec: "@atape/adapter-codex",
        displayName: "Codex",
        version: "1.0.0",
        installedAt: "2026-09-06T00:00:00Z",
        updatedAt: "2026-09-06T00:00:00Z"
      }]
    }))
    const stateFile = join(client.paths.atapeHome, "state", "collector.json")
    const layer = Layer.mergeAll(
      makeClientMigrationLayer(client.paths),
      makeConfigStoreLayer(client.paths.configFile, client.paths.legacy),
      makeCollectorStateLayer(stateFile)
    )
    const adopted = await adoptClientCheckpoint({
      importId: basename(migrated.importDirectory),
      projectId: "project-1",
      adapterId: "codex",
      sourceProjectId: "legacy-project",
      sourceAdapterId: "legacy-adapter"
    }).pipe(Effect.provide(layer), Effect.runPromise)

    expect(adopted).toMatchObject({
      sourceRevision: 7,
      revision: 1,
      target: {
        instanceOrigin: "https://atape.net",
        userId: "user-1",
        projectId: "project-1",
        adapterId: "codex"
      }
    })
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({
      version: 2,
      checkpoints: [{
        instanceOrigin: "https://atape.net",
        userId: "user-1",
        projectId: "project-1",
        adapterId: "codex",
        revision: 1,
        cursor: "legacy-cursor"
      }]
    })
  })
})
