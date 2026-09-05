import {
  AdapterPackages,
  AdapterRuntimes,
  ClientConfigStore,
  CollectorStateStore,
  CollectorTransport,
  ProjectLocator,
  SecretRedactor,
  installAdapter,
  runCollectionCycle,
  setupProject
} from "@atape/application"
import { AdapterProtocolVersion, RawTransportChunkBytes, type CollectorCheckpoint } from "@atape/domain"
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
    configFile: join(root, "config", "config.json"),
    collectorStateFile: join(root, "state", "collector.json"),
    collectorProcessFile: join(root, "state", "collector-process.json"),
    collectorStatusFile: join(root, "state", "collector-status.json"),
    collectorLogFile: join(root, "state", "collector.log"),
    adapterDirectory: join(root, "data", "adapters")
  }
  const layer = makeNodeClientLayer(paths, {
    ...process.env,
    ATAPE_REDACT_VALUES: JSON.stringify(["ultrasecretvalue"])
  })
  const run = <A, E>(effect: Effect.Effect<A, E,
    ClientConfigStore | ProjectLocator | AdapterPackages | CollectorStateStore |
    AdapterRuntimes | CollectorTransport | SecretRedactor>) =>
    effect.pipe(Effect.provide(layer), Effect.runPromise)
  return { root, paths, run }
}

const listen = async () => {
  const canonical: Array<Record<string, unknown>> = []
  const raw: Array<Record<string, unknown>> = []
  const server = createServer(async (request, response) => {
    const chunks: Array<Buffer> = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
    response.setHeader("Content-Type", "application/json")
    if (request.url === "/api/v1/ingestion/canonical/batches") {
      canonical.push(body)
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
        objectId: body.objectId,
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
  return { url: `http://127.0.0.1:${address.port}`, canonical, raw }
}

const writeAdapter = async (root: string, rawContent?: string) => {
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
  return {
    async collect(request) {
      await appendFile(context.project.path + "/adapter-calls.jsonl", JSON.stringify({
        user: context.user,
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
      adapterId: "collector-fixture",
      displayName: "Collector Fixture",
      entry: "./index.js",
      harnesses: ["fixture"]
    }
  }))
  return realpath(adapter)
}

describe("Node Collector Layers", () => {
  it("loads only the enabled package, posts separate redacted payloads, and resumes from its cursor", async () => {
    const client = await fixture()
    const remote = await listen()
    const project = join(client.root, "payments")
    await mkdir(project)
    const adapter = await writeAdapter(client.root)
    await client.run(installAdapter(adapter))
    await client.run(setupProject({
      path: project,
      userId: "liying",
      teamId: "acme",
      teamName: "Acme",
      type: "directory",
      serverUrl: remote.url,
      adapterIds: ["collector-fixture"]
    }))

    const first = await client.run(runCollectionCycle())
    const second = await client.run(runCollectionCycle())
    const state = JSON.parse(await readFile(client.paths.collectorStateFile, "utf8")) as {
      installationId: string
      checkpoints: Array<CollectorCheckpoint>
    }
    const adapterCalls = (await readFile(join(project, "adapter-calls.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(first.failures).toEqual([])
    expect(first.jobs[0]).toMatchObject({ observations: 1, canonicalBatches: 1, rawChunks: 1 })
    expect(second.jobs[0]).toMatchObject({ observations: 0, canonicalBatches: 0, rawChunks: 0 })
    expect(remote.canonical).toHaveLength(1)
    expect(remote.raw).toHaveLength(1)
    expect(JSON.stringify(remote.canonical)).not.toContain("ultrasecretvalue")
    expect(Buffer.from(String(remote.raw[0]?.contentBase64), "base64").toString("utf8"))
      .toBe("{\"value\":\"[REDACTED]\"}\n")
    expect(remote.canonical[0]?.project).not.toHaveProperty("path")
    expect((remote.canonical[0]?.threads as Array<Record<string, unknown>>)[1]).toMatchObject({
      sourceThreadId: "child", parentSourceThreadId: "root"
    })
    expect((remote.canonical[0]?.events as Array<Record<string, unknown>>)[0]).toMatchObject({
      childSourceThreadId: "child"
    })
    expect(String((remote.canonical[0]?.events as Array<Record<string, unknown>>)[0]?.rawRef))
      .toBe(`${String(remote.raw[0]?.objectId)}#line:1`)
    expect(state.installationId).toMatch(/^i_/)
    expect(state.checkpoints).toEqual([expect.objectContaining({ revision: 2, cursor: "cursor-1" })])
    expect(adapterCalls[0]).toMatchObject({ user: { id: "liying" }, cursor: null, rawProgress: [] })
    expect(adapterCalls[1]).toMatchObject({
      user: { id: "liying" },
      cursor: "cursor-1",
      rawProgress: [expect.objectContaining({ sourceObjectId: "transcript", finalized: false })]
    })
    expect((await stat(client.paths.collectorStateFile)).mode & 0o777).toBe(0o600)
    expect(await readFile(join(project, "adapter-closed"), "utf8")).toBe("yes")
  })

  it("rejects a stale compare-and-set checkpoint", async () => {
    const client = await fixture()
    const first = await client.run(CollectorStateStore.use((store) => store.snapshot("payments", "fixture")))
    const checkpoint: CollectorCheckpoint = {
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
      projectId: "payments", adapterId: "fixture", expectedRevision: 0, checkpoint
    })))

    await expect(client.run(CollectorStateStore.use((store) => store.commit({
      projectId: "payments", adapterId: "fixture", expectedRevision: 0, checkpoint
    })))).rejects.toMatchObject({ reason: "conflict" })
    expect(first.installationId).toMatch(/^i_/)
  })

  it("sends a large Adapter Raw segment as bounded HTTP chunks", async () => {
    const client = await fixture()
    const remote = await listen()
    const project = join(client.root, "large-raw")
    await mkdir(project)
    const content = `${JSON.stringify({ text: "界".repeat(100_000) })}\n`
    const adapter = await writeAdapter(client.root, content)
    await client.run(installAdapter(adapter))
    await client.run(setupProject({
      path: project,
      userId: "liying",
      teamId: "acme",
      teamName: "Acme",
      projectId: "large-raw",
      type: "directory",
      serverUrl: remote.url,
      adapterIds: ["collector-fixture"]
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
