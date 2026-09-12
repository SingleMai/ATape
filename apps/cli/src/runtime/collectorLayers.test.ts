import {
  CollectorDaemonProcess,
  AdapterPackages,
  AdapterRuntimes,
  CLICredentialStore,
  ClientConfigStore,
  CollectorStateStore,
  CollectorTransport,
  ProjectLocator,
  SecretRedactor,
  SourceCaptureCollector,
  installAdapter,
  pruneAdapterPackages,
  runCollectionCycle,
  setupProject
} from "@atape/application"
import { AdapterCollectionLimits, AdapterProtocolVersion, RawTransportChunkBytes, type CollectorCheckpoint } from "@atape/domain"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createServer, type Server } from "node:http"
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeNodeClientLayer, type NodeClientPaths } from "./clientLayers.ts"

const temporaryDirectories: Array<string> = []
const servers: Array<Server> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "atape-collector-test-"))
  temporaryDirectories.push(root)
  const paths: NodeClientPaths = {
    atapeHome: root,
    credentialDirectory: join(root, "credentials"),
    configFile: join(root, "config", "config.json"),
    collectorStateFile: join(root, "state", "collector.json"),
    collectorProcessFile: join(root, "state", "collector-process.json"),
    collectorStatusFile: join(root, "state", "collector-status.json"),
    collectorLogFile: join(root, "state", "collector.log"),
    adapterDirectory: join(root, "data", "adapters")
  }
  const layer = makeNodeClientLayer(paths, {
    ...process.env,
    ATAPE_DEVELOPMENT_ALLOW_HTTP: "true",
    ATAPE_REDACT_VALUES: JSON.stringify(["ultrasecretvalue"])
  })
  const run = <A, E>(effect: Effect.Effect<A, E,
    CollectorDaemonProcess | ClientConfigStore | ProjectLocator | AdapterPackages | CollectorStateStore |
    AdapterRuntimes | CollectorTransport | SecretRedactor | SourceCaptureCollector | CLICredentialStore>) =>
    effect.pipe(Effect.provide(layer), Effect.runPromise)
  return { root, paths, run }
}

const listen = async (afterRequest?: (phase: "policy" | "canonical") => Promise<void>) => {
  const canonical: Array<Record<string, unknown>> = []
  const raw: Array<Record<string, unknown>> = []
  const authorizations: Array<string | undefined> = []
  let origin = ""
  let policy: unknown = {teamPolicy: "force", userPreference: "disable", enabled: true}
  let policyStatus = 200
  let matchStatus = 200
  let canonicalProblem: unknown = undefined
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/v1/instance") {
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({
        protocol: "atape.instance.v1",
        instance_origin: origin,
        web_origin: origin,
        api_origin: origin,
        protocols: ["atape.canonical.v1", "atape.raw.v1", "atape.cli-authorization.v1"],
        release_version: "0.2.0",
        auth_epoch: "auth-v1",
        minimum_cli_version: "0.2.0"
      }))
      return
    }
    if (request.url?.endsWith("/raw-capture")) {
      await afterRequest?.("policy")
      response.setHeader("Content-Type", "application/json")
      response.statusCode = policyStatus
      response.end(JSON.stringify(policy))
      return
    }
    const chunks: Array<Buffer> = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
    authorizations.push(request.headers.authorization)
    response.setHeader("Content-Type", "application/json")
    if (request.url === "/api/v1/project-matches") {
      response.statusCode = matchStatus
      response.end(JSON.stringify(matchStatus === 200 ? { status: "exact", project: {
        id: "payments", teamId: "team-1", type: "git", name: "Payments", state: "active",
        repositoryIdentity: "github.com/acme/payments", repositoryLinkState: "linked",
        createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z"
      } } : { code: "unauthenticated" }))
      return
    }
    if (request.url === "/api/v1/ingestion/canonical/batches") {
      canonical.push(body)
      await afterRequest?.("canonical")
      if (canonicalProblem !== undefined) { response.statusCode = 409; response.end(JSON.stringify(canonicalProblem)); return }
      response.statusCode = 201
      response.end(JSON.stringify({
        sessionId: "s_checkout",
        sessionCreated: true,
        insertedEvents: 2,
        updatedEvents: 0,
        unchangedEvents: 0,
        staleEvents: 0,
        replayed: false
      }))
      return
    }
    if (request.url === "/api/v1/ingestion/raw/chunks") {
      const bytes = Buffer.from(String(body.contentBase64), "base64")
      if (bytes.byteLength > RawTransportChunkBytes) {
        response.statusCode = 413
        response.end(JSON.stringify({ code: "request_too_large" }))
        return
      }
      raw.push(body)
      response.statusCode = 201
      response.end(JSON.stringify({
        objectId: `r_server_${String(body.sourceObjectId)}`,
        generation: body.generation,
        sizeBytes: Number(body.offset) + bytes.byteLength,
        finalized: body.final,
        replayed: false
      }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ message: "not found" }))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("test server did not bind TCP")
  origin = `http://127.0.0.1:${address.port}`
  return { setPolicy: (value: unknown, status = 200) => { policy = value; policyStatus = status }, url: origin, canonical, raw, authorizations, setCanonicalProblem: (problem: unknown) => { canonicalProblem = problem }, setMatchStatus: (status: number) => { matchStatus = status } }
}

const authorize = <A extends { readonly run: <T, E>(effect: Effect.Effect<T, E, CLICredentialStore>) => Promise<T> }>(
  client: A,
  instanceOrigin: string,
  userId = "user-1"
) => client.run(CLICredentialStore.use((store) => Effect.gen(function*() {
  const previous = yield* store.read(instanceOrigin)
  return yield* store.replace({
    ...(previous === undefined ? {} : { expectedCredentialId: previous.credentialId }),
    credential: {
      version: 1,
      instanceOrigin,
      apiOrigin: instanceOrigin,
      credential: "atc_v1_collector-fixture",
      credentialId: "credential-collector",
      capabilityVersion: "atape-cli.v1",
      createdAt: "2026-09-06T00:00:00Z",
      user: { id: userId, displayName: "Mai" }
    }
  })
})))

const writeAdapter = async (root: string, rawContent?: string, gitCapability = false) => {
  const adapter = join(root, "adapter")
  await mkdir(adapter)
  const page = {
    protocolVersion: AdapterProtocolVersion,
    nextCursor: "cursor-1",
    hasMore: false,
    observations: [{
      observationId: "checkout-r1",
      observedAt: "2026-09-05T00:30:00+08:00",
      session: {
        sourceSessionId: "checkout",
        revision: 1,
        title: "Checkout ultrasecretvalue",
        summary: "Investigate duplicate charge",
        insight: "Persist one key",
        actor: { name: "Liying", harness: "Fixture" },
        branch: "main",
        status: "active",
        captureStatus: "healthy",
        updatedAt: "2026-09-05T00:30:00+08:00",
        reportedEventCount: 2
      },
      threads: [
        {
          sourceThreadId: "root",
          revision: 1,
          label: "Root",
          summary: "",
          captureStatus: "healthy"
        },
        {
          sourceThreadId: "child",
          parentSourceThreadId: "root",
          revision: 1,
          label: "Review",
          summary: "Checked schema",
          captureStatus: "complete"
        }
      ],
      events: [
        {
          sourceEventId: "e1",
          sourceThreadId: "root",
          revision: 1,
          projectionRevision: 1,
          sourceOrder: 1,
          eventIndex: 0,
          orderFidelity: "native",
          fidelity: "native",
          rawRef: { _tag: "object", sourceObjectId: "transcript", fragment: "#line:1" },
          occurredAt: "2026-09-05T00:29:00+08:00",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "spawn-reviewer",
            title: "Start reviewer",
            kind: "think",
            status: "completed"
          },
          childSourceThreadId: "child"
        },
        {
          sourceEventId: "e2",
          sourceThreadId: "child",
          revision: 1,
          projectionRevision: 1,
          sourceOrder: 2,
          eventIndex: 0,
          orderFidelity: "native",
          fidelity: "native",
          rawRef: { _tag: "object", sourceObjectId: "transcript", fragment: "#line:2" },
          occurredAt: "2026-09-05T00:29:10+08:00",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Found ultrasecretvalue in logs" },
            messageId: "review-result"
          }
        }
      ],
      rawSegments: [{
        sourceObjectId: "transcript",
        sourceGeneration: "inode-1",
        sourceOffset: 0,
        sourceName: "session.jsonl",
        mediaType: "application/x-ndjson",
        content: "{\"value\":\"ultrasecretvalue\"}\n",
        final: false
      }]
    }]
  }
  if (rawContent !== undefined) {
    const segment = page.observations[0]?.rawSegments[0]
    if (segment === undefined) throw new Error("missing fixture Raw segment")
    segment.content = rawContent
    segment.final = true
  }
const source = `import { appendFile, writeFile } from "node:fs/promises"
export async function createAtapeAdapter(context) {
  await writeFile(context.project.path + "/adapter-context.json", JSON.stringify(context))
  return {
    async collect(request) {
      if (context.project.type === "git") {
        try {
          await context.gitAttribution.resolve({ sourceId: "checkout", originKey: "original-header", cwd: context.project.path,
            repositoryRemote: "git@github.com:acme/payments.git" }, request.signal)
        } catch { /* Deliberately swallowed to exercise the Host's failure boundary. */ }
      }
      await appendFile(context.project.path + "/adapter-calls.jsonl", JSON.stringify({
        cursor: request.cursor,
        rawProgress: request.rawProgress
      }) + "\\n")
      if (request.cursor !== null) {
        return { protocolVersion: "${AdapterProtocolVersion}", nextCursor: request.cursor, hasMore: false, observations: [] }
      }
      return ${JSON.stringify(page)}
    },
    async close() { await writeFile(context.project.path + "/adapter-closed", "yes") }
  }
}
`
  await writeFile(join(adapter, "index.js"), source)
  await writeFile(join(adapter, "package.json"), JSON.stringify({
    name: "@atape/adapter-collector-fixture",
    version: "1.0.0",
    type: "module",
    atapeAdapter: {
      protocolVersion: AdapterProtocolVersion,
      rawCapturePolicy: "atape.raw-capture.v1",
      ...(gitCapability ? { gitAttribution: "atape.git-attribution.v1" } : {}),
      adapterId: "collector-fixture",
      displayName: "Collector Fixture",
      entry: "./index.js",
      harnesses: ["fixture"]
    }
  }))
  return realpath(adapter)
}

describe("Node Collector Layers", () => {
  it("protects delayed imports during upgrade and cleanup, then reclaims released versions", async () => {
    const client = await fixture(), source = join(client.root, "source"), path = join(client.root, "project")
    await Promise.all([mkdir(source), mkdir(path)])
    const writeVersion = async (version: string) => {
      await writeFile(join(source, "package.json"), JSON.stringify({ name: "atape-slot-fixture", version, type: "module",
        atapeAdapter: { protocolVersion: AdapterProtocolVersion, adapterId: "slot-fixture", displayName: "Slots", entry: "./index.js", harnesses: ["fixture"] } }))
      await writeFile(join(source, "index.js"), `export const createAtapeAdapter = () => ({ collect: async () => ({
        protocolVersion: ${JSON.stringify(AdapterProtocolVersion)}, nextCursor: (await import('./version.js')).version,
        observations: [], hasMore: false }) });\n`)
      await writeFile(join(source, "version.js"), `export const version = ${JSON.stringify(version)};\n`)
    }
    await writeVersion("1.0.0")
    const first = (await client.run(installAdapter(source))).adapter
    const { project } = await client.run(setupProject({ ...accountProject(path, "https://fixture.example"), type: "directory" }))
    const cursors = await client.run(Effect.scoped(Effect.gen(function*() {
      const runtimes = yield* AdapterRuntimes
      const old = yield* runtimes.open(project, first)
      yield* Effect.promise(() => writeVersion("2.0.0"))
      const second = yield* installAdapter(source, { installation: first })
      yield* Effect.promise(() => writeVersion("3.0.0"))
      const third = yield* installAdapter(source, { installation: second.adapter })
      const current = yield* runtimes.open(project, third.adapter)
      const preview = yield* pruneAdapterPackages()
      expect(preview.slots).toEqual(expect.arrayContaining([
        expect.objectContaining({ slot: first.packageSlot, state: "in_use" }),
        expect.objectContaining({ slot: second.adapter.packageSlot, state: "retained" }),
        expect.objectContaining({ slot: third.adapter.packageSlot, state: "current" })
      ]))
      const applied = yield* pruneAdapterPackages({ apply: true, keep: 0 })
      expect(applied.slots).toEqual(expect.arrayContaining([
        expect.objectContaining({ slot: first.packageSlot, state: "in_use" }),
        expect.objectContaining({ slot: second.adapter.packageSlot, state: "removed" }),
        expect.objectContaining({ slot: third.adapter.packageSlot, state: "current" })
      ]))
      if (!("collect" in old) || !("collect" in current)) throw new Error("Expected paged runtimes")
      const request = { protocolVersion: AdapterProtocolVersion, cursor: null, limits: AdapterCollectionLimits, rawProgress: [] }
      return [(yield* old.collect(request)).nextCursor, (yield* current.collect(request)).nextCursor]
    })))
    expect(cursors).toEqual(["1.0.0", "3.0.0"])
    const eligible = await client.run(pruneAdapterPackages({ keep: 0 }))
    expect(eligible.slots).toContainEqual(expect.objectContaining({ slot: first.packageSlot, state: "eligible" }))
    const oldRoot = join(client.paths.adapterDirectory, "slots", first.packageSlot!)
    expect((await stat(oldRoot)).isDirectory()).toBe(true)
    await expect(stat(join(client.paths.adapterDirectory, "retired-slots", first.packageSlot!))).rejects.toMatchObject({ code: "ENOENT" })
    // An interrupted sweep closed admission while the package files still exist.
    await mkdir(join(client.paths.adapterDirectory, "retired-slots", first.packageSlot!), { recursive: true })
    await expect(client.run(Effect.scoped(AdapterRuntimes.use(runtimes => runtimes.open(project, first)))))
      .rejects.toMatchObject({ reason: "load", retryable: true, message: expect.stringContaining("retired") })
    expect((await client.run(pruneAdapterPackages({ apply: true, keep: 0 }))).removed).toBe(1)
    await expect(stat(oldRoot)).rejects.toMatchObject({ code: "ENOENT" })
    expect((await client.run(pruneAdapterPackages({ apply: true, keep: 0 }))).removed).toBe(0)
  }, 20_000)
  it.each(["policy", "canonical"] as const)("stops before sending history under an account changed after %s", async phase => {
    const client = await fixture()
    let switched = false
    const remote = await listen(async completed => {
      if (!switched && completed === phase) { switched = true; await authorize(client, remote.url, "other-user") }
    })
    await authorize(client, remote.url)
    const project = join(client.root, "project")
    await mkdir(project)
    await client.run(installAdapter(await writeAdapter(client.root)))
    await client.run(ClientConfigStore.use(store => store.transact(config => Effect.succeed({ value: undefined,
      config: { ...config, toolsConfigured: true, enabledAdapterIds: ["collector-fixture"] } }))))
    await client.run(setupProject({ ...accountProject(project, remote.url), type: "directory" }))
    const rejected = await client.run(runCollectionCycle())
    expect(rejected.failures).toMatchObject([{ reason: "unauthenticated", retryable: false }])
    expect(remote.canonical).toHaveLength(phase === "policy" ? 0 : 1)
    expect(remote.raw).toEqual([])
    expect((await client.run(CollectorStateStore.use(store => store.snapshot(remote.url, "user-1", "payments", "collector-fixture")))).checkpoint).toBeUndefined()
    await authorize(client, remote.url)
    expect((await client.run(runCollectionCycle())).failures).toEqual([])
    expect(remote.raw).toHaveLength(1)
  }, 20_000)

  it("retains confirmed history across a fresh runtime and an idle Raw-off cycle", async () => {
    const client = await fixture(), remote = await listen()
    await authorize(client, remote.url)
    remote.setPolicy({ teamPolicy: "close", userPreference: "disable", enabled: false })
    const project = join(client.root, "project")
    await mkdir(project)
    await client.run(installAdapter(await writeAdapter(client.root)))
    await client.run(ClientConfigStore.use(store => store.transact(config => Effect.succeed({ value: undefined,
      config: { ...config, toolsConfigured: true, enabledAdapterIds: ["collector-fixture"] } }))))
    await client.run(setupProject({ ...accountProject(project, remote.url), type: "directory" }))
    expect((await client.run(runCollectionCycle())).jobs[0]?.canonicalBatches).toBe(1)
    expect((await client.run(runCollectionCycle())).jobs[0]?.canonicalBatches).toBe(0)
    expect(remote.raw).toEqual([])
    const captured = await client.run(CollectorStateStore.use(store => store.capturedScopes()))
    expect(captured).toEqual([{ instanceOrigin: remote.url, userId: "user-1", projectId: "payments",
      projectCreatedAt: "2026-09-06T00:00:00Z", adapterId: "collector-fixture" }])
  }, 20_000)
  // Real npm installation plus two HTTP collection cycles can exceed Vitest's
  // default five seconds when the full workspace runs concurrently on CI.
  it("loads only the enabled package, posts separate redacted payloads, and resumes from its cursor", async () => {
    const client = await fixture()
    const remote = await listen()
    await authorize(client, remote.url)
    const project = join(client.root, "payments")
    await mkdir(project)
    const adapter = await writeAdapter(client.root)
    await client.run(installAdapter(adapter))
    await client.run(Effect.flatMap(ClientConfigStore, store => store.transact(config => Effect.succeed({ value: undefined,
      config: { ...config, toolsConfigured: true, enabledAdapterIds: ["collector-fixture"] } }))))
    await client.run(setupProject({
      path: project,
      instanceOrigin: remote.url,
      userId: "user-1",
      teamId: "team-1",
      teamSlug: "acme",
      teamName: "Acme",
      projectId: "payments",
      name: "Payments",
      createdAt: "2026-09-06T00:00:00Z",
      type: "directory",
    }))

    remote.setCanonicalProblem({ code: "idempotency_conflict", requestId: "request-123", detail: "private source text" })
    const conflict = await client.run(runCollectionCycle())
    expect(conflict.failures[0]?.message).toBe("ATape canonical endpoint returned 409. idempotency_conflict request request-123")
    remote.setCanonicalProblem({ code: "private source text", requestId: "private\nsource" })
    expect((await client.run(runCollectionCycle())).failures[0]?.message).toBe("ATape canonical endpoint returned 409.")
    remote.setCanonicalProblem(undefined)
    remote.canonical.splice(0)
    remote.authorizations.splice(0)
    await writeFile(join(project, "adapter-calls.jsonl"), "")
    const first = await client.run(runCollectionCycle())
    const second = await client.run(runCollectionCycle())
    const state = JSON.parse(await readFile(client.paths.collectorStateFile, "utf8")) as {
      installationId: string
      checkpoints: Array<CollectorCheckpoint>
    }
    const adapterCalls = (await readFile(join(project, "adapter-calls.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    const adapterContext = JSON.parse(await readFile(join(project, "adapter-context.json"), "utf8")) as
      Record<string, unknown>
    const canonicalProject = await realpath(project)

    expect(first.failures).toEqual([])
    expect(first.jobs[0]).toMatchObject({ observations: 1, canonicalBatches: 1, rawChunks: 1 })
    expect(second.jobs[0]).toMatchObject({ observations: 0, canonicalBatches: 0, rawChunks: 0 })
    expect(remote.canonical).toHaveLength(1)
    expect(remote.raw).toHaveLength(1)
    expect(JSON.stringify(remote.canonical)).not.toContain("ultrasecretvalue")
    expect(Buffer.from(String(remote.raw[0]?.contentBase64), "base64").toString("utf8"))
      .toBe("{\"value\":\"[REDACTED]\"}\n")
    expect(remote.canonical[0]).toMatchObject({ projectId: "payments" })
    expect(remote.canonical[0]).not.toHaveProperty("project")
    expect(remote.canonical[0]?.source).not.toHaveProperty("userId")
    expect(remote.canonical[0]).not.toHaveProperty("teamId")
    expect(remote.raw[0]).toMatchObject({
      sourceChunkId: "g1-o0",
      sourceObjectId: "transcript",
      installationId: state.installationId
    })
    expect(remote.raw[0]).not.toHaveProperty("userId")
    expect(remote.raw[0]).not.toHaveProperty("teamId")
    expect(remote.raw[0]).not.toHaveProperty("projectId")
    expect(remote.raw[0]).not.toHaveProperty("objectId")
    expect(remote.raw[0]).not.toHaveProperty("chunkId")
    expect((remote.canonical[0]?.threads as Array<Record<string, unknown>>)[1]).toMatchObject({
      sourceThreadId: "child", parentSourceThreadId: "root"
    })
    expect((remote.canonical[0]?.events as Array<Record<string, unknown>>)[0]).toMatchObject({
      childSourceThreadId: "child"
    })
    expect((remote.canonical[0]?.events as Array<Record<string, unknown>>)[0]?.rawRef)
      .toEqual({ type: "object", sourceObjectId: "transcript", fragment: "#line:1" })
    expect(state.installationId).toMatch(/^i_/)
    expect(state.checkpoints).toEqual([expect.objectContaining({ revision: 2, cursor: "cursor-1" })])
    expect(adapterCalls[0]).toMatchObject({ cursor: null, rawProgress: [] })
    expect(adapterCalls[0]).not.toHaveProperty("user")
    expect(adapterContext).toMatchObject({
      protocolVersion: AdapterProtocolVersion,
      adapter: { id: "collector-fixture", version: "1.0.0" },
      project: { id: "payments", type: "directory", path: canonicalProject }
    })
    expect(JSON.stringify(adapterContext)).not.toMatch(/credential|token|userId|teamId|instanceOrigin|apiOrigin/i)
    expect(adapterCalls[1]).toMatchObject({
      cursor: "cursor-1",
      rawProgress: [expect.objectContaining({ sourceObjectId: "transcript", finalized: false })]
    })
    expect(remote.authorizations).toEqual([
      "Bearer atc_v1_collector-fixture",
      "Bearer atc_v1_collector-fixture"
    ])
    expect((await stat(client.paths.collectorStateFile)).mode & 0o777).toBe(0o600)
    expect(await readFile(join(project, "adapter-closed"), "utf8")).toBe("yes")
  }, 20_000)

  it("requires declared Git capability and preserves authentication failures across the foreign callback", async () => {
    const client = await fixture(), remote = await listen()
    await authorize(client, remote.url)
    const project = join(client.root, "payments")
    await mkdir(project)
    const git = promisify(execFile)
    await git("git", ["init", "-q", project])
    await git("git", ["-C", project, "remote", "add", "origin", "git@github.com:acme/payments.git"])
    const adapter = await writeAdapter(client.root)
    await client.run(installAdapter(adapter))
    await client.run(Effect.flatMap(ClientConfigStore, store => store.transact(config => Effect.succeed({ value: undefined,
      config: { ...config, toolsConfigured: true, enabledAdapterIds: ["collector-fixture"] } }))))
    await client.run(setupProject({
      path: project, type: "git", repositoryIdentity: "github.com/acme/payments",
      instanceOrigin: remote.url, userId: "user-1", teamId: "team-1", teamSlug: "acme", teamName: "Acme",
      projectId: "payments", name: "Payments", createdAt: "2026-09-06T00:00:00Z"
    }))
    const unsupported = await client.run(runCollectionCycle())
    expect(unsupported.failures[0]?.message).toContain("Upgrade")
    await expect(stat(join(project, "adapter-context.json"))).rejects.toMatchObject({ code: "ENOENT" })

    const manifestPath = join(adapter, "package.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    manifest.atapeAdapter.gitAttribution = "atape.git-attribution.v1"
    await writeFile(manifestPath, JSON.stringify(manifest))
    await client.run(installAdapter(adapter))
    await client.run(Effect.flatMap(ClientConfigStore, store => store.transact(config => Effect.succeed({ value: undefined,
      config: { ...config, toolsConfigured: true, enabledAdapterIds: ["collector-fixture"] } }))))
    const first = await client.run(runCollectionCycle())
    expect(first.failures).toEqual([])
    expect(remote.canonical).toHaveLength(1)
    const before = JSON.parse(await readFile(client.paths.collectorStateFile, "utf8"))
    remote.setMatchStatus(401)
    const failed = await client.run(runCollectionCycle())
    expect(failed.failures[0]).toMatchObject({ reason: "unauthenticated", retryable: false })
    expect(JSON.parse(await readFile(client.paths.collectorStateFile, "utf8"))).toEqual(before)
    expect(remote.canonical).toHaveLength(1)
    remote.setMatchStatus(503)
    const unavailable = await client.run(runCollectionCycle())
    expect(unavailable.failures[0]).toMatchObject({ reason: "transport", retryable: true })
    expect(JSON.parse(await readFile(client.paths.collectorStateFile, "utf8"))).toEqual(before)
    expect(remote.canonical).toHaveLength(1)
    remote.setMatchStatus(200)
    expect((await client.run(runCollectionCycle())).failures).toEqual([])
  })

  it("rejects a stale compare-and-set checkpoint", async () => {
    const client = await fixture()
    const first = await client.run(CollectorStateStore.use((store) => store.snapshot(
      "https://atape.net", "user-1", "payments", "fixture"
    )))
    const checkpoint: CollectorCheckpoint = {
      instanceOrigin: "https://atape.net",
      userId: "user-1",
      projectId: "payments",
      projectCreatedAt: "2026-09-05T00:30:00+08:00",
      adapterId: "fixture",
      adapterVersion: "1.0.0",
      revision: 1,
      cursor: "cursor-1",
      rawObjects: [],
      updatedAt: "2026-09-05T00:30:00+08:00"
    }
    await client.run(CollectorStateStore.use((store) => store.commit({
      instanceOrigin: "https://atape.net", userId: "user-1",
      projectId: "payments", adapterId: "fixture", expectedRevision: 0, checkpoint
    })))

    await expect(client.run(CollectorStateStore.use((store) => store.commit({
      instanceOrigin: "https://atape.net", userId: "user-1",
      projectId: "payments", adapterId: "fixture", expectedRevision: 0, checkpoint
    })))).rejects.toMatchObject({ reason: "conflict" })
    expect(first.installationId).toMatch(/^i_/)
  })

  it("sends a large Adapter Raw segment as bounded HTTP chunks", async () => {
    const client = await fixture()
    const remote = await listen()
    await authorize(client, remote.url)
    const project = join(client.root, "large-raw")
    await mkdir(project)
    const content = `${JSON.stringify({ text: "x".repeat(RawTransportChunkBytes + 1024) })}\n`
    const adapter = await writeAdapter(client.root, content)
    await client.run(installAdapter(adapter))
    await client.run(Effect.flatMap(ClientConfigStore, store => store.transact(config => Effect.succeed({ value: undefined,
      config: { ...config, toolsConfigured: true, enabledAdapterIds: ["collector-fixture"] } }))))
    await client.run(setupProject({
      path: project,
      instanceOrigin: remote.url,
      userId: "user-1",
      teamId: "team-1",
      teamSlug: "acme",
      teamName: "Acme",
      projectId: "large-raw",
      name: "Large Raw",
      createdAt: "2026-09-06T00:00:00Z",
      type: "directory",
    }))

    const report = await client.run(runCollectionCycle())
    const state = JSON.parse(await readFile(client.paths.collectorStateFile, "utf8")) as {
      checkpoints: Array<CollectorCheckpoint>
    }
    const uploaded = remote.raw.map((chunk) => Buffer.from(String(chunk.contentBase64), "base64"))

    expect(report.failures).toEqual([])
    expect(report.jobs[0]).toMatchObject({ rawChunks: 2 })
    expect(uploaded).toHaveLength(2)
    expect(uploaded.every((chunk) => chunk.byteLength <= RawTransportChunkBytes)).toBe(true)
    expect(Buffer.concat(uploaded).toString("utf8")).toBe(content)
    expect(remote.raw.map((chunk) => chunk.final)).toEqual([false, true])
    expect(state.checkpoints[0]?.rawObjects[0]).toMatchObject({
      sourceOffset: Buffer.byteLength(content),
      serverOffset: Buffer.byteLength(content),
      finalized: true
    })
  })
})

const accountProject = (path: string, instanceOrigin: string) => ({ path, instanceOrigin, userId: "user-1",
  teamId: "team-1", teamSlug: "acme", teamName: "Acme", projectId: "payments", name: "Payments", createdAt: "2026-09-06T00:00:00Z" })

it("loads authoritative Raw policy and rejects absent or malformed policies", async () => {
  const client = await fixture(), server = await listen()
  await authorize(client, server.url)
  const load = () => client.run(CollectorTransport.use(t => t.rawCaptureEnabled({
    instanceOrigin: server.url, userId: "user-1", id: "payments"
  })))
  server.setPolicy({ teamPolicy: "personal", userPreference: "disable", enabled: false })
  expect(await load()).toBe(false)
  server.setPolicy({ teamPolicy: "close", userPreference: "enable", enabled: false })
  expect(await load()).toBe(false)
  server.setPolicy({ teamPolicy: "force", userPreference: "disable", enabled: true })
  expect(await load()).toBe(true)
  server.setPolicy({ enabled: true })
  await expect(load()).rejects.toThrow()
  server.setPolicy({ code: "not_found" }, 404)
  await expect(load()).rejects.toThrow()
})
