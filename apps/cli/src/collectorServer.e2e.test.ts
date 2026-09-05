import { execFile, spawn, type ChildProcess } from "node:child_process"
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { expect, it } from "vitest"

const repositoryRoot = resolve(import.meta.dirname, "../../..")
const cliEntry = join(repositoryRoot, "apps/cli/src/main.ts")
const codexAdapter = join(repositoryRoot, "adapters/codex")
const rawTransportChunkBytes = 256 * 1024

it("collects Codex into the real Go APIs and retains finalized history", async () => {
  const fixture = await createFixture()
  let server: ChildProcess | undefined
  let serverUrl: string | undefined
  try {
    const port = await availablePort()
    serverUrl = `http://127.0.0.1:${port}`
    await configureClient(fixture, serverUrl)
    server = startServer(port)
    await waitUntilHealthy(serverUrl, server)

    const started = await startCollector(fixture, serverUrl)
    expect(started).toMatchObject({ created: true, intervalMs: 10_000, concurrency: 2 })
    expect(await startCollector(fixture, serverUrl)).toMatchObject({ created: false, pid: started.pid })
    const first = await waitForCollectorSuccess(fixture, serverUrl)
    expect(first).toMatchObject({ observations: 1, rawChunks: 3 })
    expect((await collectorStatus(fixture, serverUrl)).running).toBe(true)
    expect(await stopCollector(fixture, serverUrl)).toEqual({ stopped: true })
    expect((await collectorStatus(fixture, serverUrl)).running).toBe(false)

    const workspace = await getJSON<Workspace>(serverUrl, "/api/v1/workspace")
    const project = workspace.teams.find((team) => team.id === "acme-engineering")
      ?.projects.find((candidate) => candidate.id === "support-notes")
    expect(project).toMatchObject({ sessionCount: 1, activeSessionCount: 1 })

    const memory = await getJSON<ProjectMemory>(serverUrl, "/api/v1/projects/support-notes/memory")
    expect(memory.trail).toHaveLength(1)
    expect(memory.active).toHaveLength(1)
    expect(memory.trail[0]).toMatchObject({
      title: "Find e2e-search-needle",
      childThreadCount: 1,
      status: "active"
    })
    const sessionId = required(memory.trail[0], "captured Session").id

    const rootBefore = await getJSON<Conversation>(
      serverUrl,
      `/api/v1/sessions/${encodeURIComponent(sessionId)}?thread=root`
    )
    expect(rootBefore.events).toHaveLength(3)
    expect(JSON.stringify(rootBefore)).not.toContain("Copied parent history")
    const childRef = required(
      rootBefore.events.find((event) => event.childThread !== undefined)?.childThread,
      "child Thread reference"
    )
    const child = await getJSON<Conversation>(
      serverUrl,
      `/api/v1/sessions/${encodeURIComponent(sessionId)}?thread=${encodeURIComponent(childRef.id)}`
    )
    expect(child.events.map((event) => event.text)).toEqual(["child-e2e-result"])

    const search = await waitForSearch(serverUrl)
    expect(search.results.map((result) => result.text)).toEqual(expect.arrayContaining([
      "Find e2e-search-needle",
      "Use one idempotency key for e2e-search-needle"
    ]))

    const archive = await getJSON<RawArchive>(
      serverUrl,
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/raw`
    )
    expect(archive.objects).toHaveLength(2)
    const raw = await readRaw(serverUrl, archive)
    expect(raw.chunkCount).toBe(3)
    expect(raw.largestChunk).toBeLessThanOrEqual(rawTransportChunkBytes)
    expect(raw.largestObject).toBeGreaterThan(rawTransportChunkBytes)
    expect(raw.text).not.toContain(fixture.secret)
    expect(raw.text).toContain("[REDACTED]")

    expect(onlyJob(await collect(fixture, serverUrl))).toMatchObject({ observations: 0, rawChunks: 0 })

    await appendFile(fixture.rootFile, jsonLines([
      completedItem("agent-2", fixture.rootSessionId, "A newly appended answer", "AgentMessage")
    ]))
    const changedAt = new Date(Date.now() + 1_000)
    await utimes(fixture.rootFile, changedAt, changedAt)
    expect(onlyJob(await collect(fixture, serverUrl))).toMatchObject({ observations: 1, rawChunks: 1 })

    const rootAfter = await getJSON<Conversation>(
      serverUrl,
      `/api/v1/sessions/${encodeURIComponent(sessionId)}?thread=root`
    )
    const previousEventIds = new Set(rootBefore.events.map((event) => event.id))
    expect(rootAfter.events.filter((event) => !previousEventIds.has(event.id)).map((event) => event.text))
      .toEqual(["A newly appended answer"])

    await Promise.all([
      rename(fixture.rootFile, join(fixture.archivedDirectory, "root.jsonl")),
      rename(fixture.childFile, join(fixture.archivedDirectory, "child.jsonl"))
    ])
    expect(onlyJob(await collect(fixture, serverUrl))).toMatchObject({ observations: 1, rawChunks: 2 })

    const ended = await getJSON<ProjectMemory>(serverUrl, "/api/v1/projects/support-notes/memory")
    expect(ended.active).toHaveLength(0)
    expect(ended.trail[0]?.status).toBe("ended")
    const finalized = await getJSON<RawArchive>(
      serverUrl,
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/raw`
    )
    expect(finalized.objects.every((object) => object.currentFinalized)).toBe(true)

    await rm(fixture.archivedDirectory, { recursive: true, force: true })
    await mkdir(fixture.archivedDirectory, { recursive: true })
    expect(onlyJob(await collect(fixture, serverUrl))).toMatchObject({ observations: 0, rawChunks: 0 })
    const retained = await getJSON<Conversation>(
      serverUrl,
      `/api/v1/sessions/${encodeURIComponent(sessionId)}?thread=root`
    )
    expect(retained.session.status).toBe("ended")
    expect(retained.events).toHaveLength(4)
  } finally {
    if (serverUrl !== undefined) await stopCollector(fixture, serverUrl).catch(() => undefined)
    await stopServer(server)
    await rm(fixture.root, { recursive: true, force: true })
  }
}, 180_000)

type Fixture = Awaited<ReturnType<typeof createFixture>>

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "atape-server-e2e-"))
  const projectDirectory = join(root, "project")
  const codexHome = join(root, "codex-home")
  const sessionsDirectory = join(codexHome, "sessions", "2026", "09", "05")
  const archivedDirectory = join(codexHome, "archived_sessions")
  const adapterDirectory = join(root, "adapter-runtime")
  const configFile = join(root, "config.json")
  const collectorStateFile = join(root, "collector.json")
  const collectorProcessFile = join(root, "collector-process.json")
  const collectorStatusFile = join(root, "collector-status.json")
  const collectorLogFile = join(root, "collector.log")
  const rootFile = join(sessionsDirectory, "root.jsonl")
  const childFile = join(sessionsDirectory, "child.jsonl")
  const rootSessionId = "e2e-root-session"
  const childThreadId = "e2e-child"
  const secret = "e2e-private-secret"
  await Promise.all([
    mkdir(projectDirectory, { recursive: true }),
    mkdir(sessionsDirectory, { recursive: true }),
    mkdir(archivedDirectory, { recursive: true })
  ])
  await writeFile(rootFile, jsonLines([
    sessionMetadata(rootSessionId, projectDirectory),
    completedItem("user-1", rootSessionId, "Find e2e-search-needle", "UserMessage"),
    completedItem("agent-1", rootSessionId, "Use one idempotency key for e2e-search-needle", "AgentMessage"),
    { type: "provider_private", payload: { secret, blob: "x".repeat(300 * 1024) } }
  ]))
  await writeFile(childFile, jsonLines([
    sessionMetadata(childThreadId, projectDirectory, {
      sessionId: rootSessionId,
      parentThreadId: rootSessionId,
      nickname: "reviewer"
    }),
    completedItem("copied-parent", rootSessionId, "Copied parent history", "AgentMessage"),
    completedItem("child-1", childThreadId, "child-e2e-result", "AgentMessage")
  ]))
  const initialTime = new Date(Date.now() - 5_000)
  await Promise.all([rootFile, childFile].map((path) => utimes(path, initialTime, initialTime)))
  return {
    root,
    projectDirectory,
    codexHome,
    archivedDirectory,
    adapterDirectory,
    configFile,
    collectorStateFile,
    collectorProcessFile,
    collectorStatusFile,
    collectorLogFile,
    rootFile,
    childFile,
    rootSessionId,
    secret
  }
}

const configureClient = async (fixture: Fixture, serverUrl: string) => {
  const installedScope = join(fixture.adapterDirectory, "node_modules", "@atape")
  await mkdir(installedScope, { recursive: true })
  await symlink(codexAdapter, join(installedScope, "adapter-codex"), "dir")
  const adapterPackage = JSON.parse(await readFile(join(codexAdapter, "package.json"), "utf8")) as {
    readonly version: string
  }
  const now = new Date().toISOString()
  await writeFile(fixture.configFile, `${JSON.stringify({
    version: 1,
    serverUrl,
    userId: "e2e-user",
    projects: [{
      id: "support-notes",
      teamId: "acme-engineering",
      teamName: "Acme Engineering",
      name: "E2E Project",
      type: "directory",
      path: fixture.projectDirectory,
      adapterIds: ["codex"],
      createdAt: now
    }],
    adapters: [{
      adapterId: "codex",
      packageName: "@atape/adapter-codex",
      upgradeSpec: `file:${codexAdapter}`,
      displayName: "Codex",
      version: adapterPackage.version,
      installedAt: now,
      updatedAt: now
    }]
  }, null, 2)}\n`)
}

const collect = async (fixture: Fixture, serverUrl: string) => {
  const output = await execute(process.execPath, [
    cliEntry,
    "collect",
    "--once",
    "--project",
    "support-notes",
    "--json"
  ], repositoryRoot, clientEnvironment(fixture, serverUrl))
  return JSON.parse(output) as CollectionReport
}

const startCollector = async (fixture: Fixture, serverUrl: string) => JSON.parse(await execute(
  process.execPath,
  [cliEntry, "start", "--interval", "10", "--concurrency", "2", "--json"],
  repositoryRoot,
  clientEnvironment(fixture, serverUrl)
)) as { readonly created: boolean; readonly pid: number; readonly intervalMs: number; readonly concurrency: number }

const stopCollector = async (fixture: Fixture, serverUrl: string) => JSON.parse(await execute(
  process.execPath,
  [cliEntry, "stop", "--json"],
  repositoryRoot,
  clientEnvironment(fixture, serverUrl)
)) as { readonly stopped: boolean }

const collectorStatus = async (fixture: Fixture, serverUrl: string) => JSON.parse(await execute(
  process.execPath,
  [cliEntry, "status", "--json"],
  repositoryRoot,
  clientEnvironment(fixture, serverUrl)
)) as ManagedCollectorStatus

const waitForCollectorSuccess = async (fixture: Fixture, serverUrl: string) => {
  const deadline = Date.now() + 120_000
  let lastStatus: ManagedCollectorStatus | undefined
  while (Date.now() < deadline) {
    const status = await collectorStatus(fixture, serverUrl)
    lastStatus = status
    const job = status.jobs.find((candidate) =>
      candidate.projectId === "support-notes" && candidate.adapterId === "codex")
    if (job?.state === "healthy") return job
    if (!status.running || status.collectorFailure !== undefined || job?.state === "failed") break
    await delay(250)
  }
  const log = await readFile(fixture.collectorLogFile, "utf8")
    .catch((cause) => `Could not read Collector log: ${cause instanceof Error ? cause.message : String(cause)}`)
  throw new Error([
    "Managed Collector did not report success.",
    `Status: ${JSON.stringify(lastStatus)}`,
    `Collector log (${fixture.collectorLogFile}):`,
    log
  ].join("\n"))
}

const clientEnvironment = (fixture: Fixture, serverUrl: string): NodeJS.ProcessEnv => ({
  ...process.env,
  ATAPE_CONFIG_FILE: fixture.configFile,
  ATAPE_COLLECTOR_STATE_FILE: fixture.collectorStateFile,
  ATAPE_COLLECTOR_PROCESS_FILE: fixture.collectorProcessFile,
  ATAPE_COLLECTOR_STATUS_FILE: fixture.collectorStatusFile,
  ATAPE_COLLECTOR_LOG_FILE: fixture.collectorLogFile,
  ATAPE_ADAPTER_DIRECTORY: fixture.adapterDirectory,
  ATAPE_CODEX_HOME: fixture.codexHome,
  ATAPE_REDACT_VALUES: JSON.stringify([fixture.secret]),
  ATAPE_SERVER_URL: serverUrl
})

const onlyJob = (report: CollectionReport) => {
  expect(report.failures).toEqual([])
  expect(report.jobs).toHaveLength(1)
  return required(report.jobs[0], "collection job")
}

const execute = (
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
  environment: NodeJS.ProcessEnv
) => new Promise<string>((resolveOutput, reject) => {
  execFile(executable, [...args], {
    cwd,
    env: environment,
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024
  }, (error, stdout, stderr) => {
    if (error) {
      reject(new Error(`${error.message}\n${stderr}\n${stdout}`))
      return
    }
    resolveOutput(stdout)
  })
})

const availablePort = () => new Promise<number>((resolvePort, reject) => {
  const listener = createServer()
  listener.once("error", reject)
  listener.listen(0, "127.0.0.1", () => {
    const address = listener.address()
    if (typeof address !== "object" || address === null) {
      listener.close()
      reject(new Error("Could not allocate an E2E server port."))
      return
    }
    listener.close((error) => error ? reject(error) : resolvePort(address.port))
  })
})

const startServer = (port: number) => {
  const child = spawn("go", ["run", "./cmd/atape-server"], {
    cwd: join(repositoryRoot, "server"),
    detached: true,
    env: {
      ...process.env,
      ATAPE_SERVER_ADDRESS: `127.0.0.1:${port}`,
      ATAPE_DATABASE_URL: "",
      ATAPE_RAW_DIRECTORY: "",
      ATAPE_DEMO_MODE: "true"
    },
    stdio: ["ignore", "ignore", "pipe"]
  })
  let stderr = ""
  child.stderr?.on("data", (chunk) => { stderr += String(chunk) })
  Object.assign(child, { e2eStderr: () => stderr })
  return child
}

const stopServer = async (server: ChildProcess | undefined) => {
  if (server?.pid === undefined) return
  try { process.kill(-server.pid, "SIGTERM") } catch { return }
  await delay(300)
  try { process.kill(-server.pid, "SIGKILL") } catch { /* already stopped */ }
}

const waitUntilHealthy = async (serverUrl: string, server: ChildProcess) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (server.exitCode !== null) break
    try {
      const health = await getJSON<{ readonly status: string }>(serverUrl, "/healthz")
      if (health.status === "ok") return
    } catch {
      // The process may still be compiling or binding its listener.
    }
    await delay(100)
  }
  const stderr = "e2eStderr" in server
    ? (server as ChildProcess & { readonly e2eStderr: () => string }).e2eStderr()
    : ""
  throw new Error(`The E2E Go server did not become healthy.\n${stderr}`)
}

const getJSON = async <A>(serverUrl: string, path: string): Promise<A> => {
  const response = await fetch(`${serverUrl}${path}`, { signal: AbortSignal.timeout(10_000) })
  const body = await response.text()
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${body}`)
  return JSON.parse(body) as A
}

const waitForSearch = async (serverUrl: string) => {
  let last: SearchPage | undefined
  for (let attempt = 0; attempt < 100; attempt++) {
    const page = await getJSON<SearchPage>(
      serverUrl,
      "/api/v1/projects/support-notes/search?q=e2e-search-needle"
    )
    last = page
    const texts = new Set(page.results.map((result) => result.text))
    if (texts.has("Find e2e-search-needle") &&
      texts.has("Use one idempotency key for e2e-search-needle")) return page
    await delay(100)
  }
  throw new Error(`Search did not project the two E2E Events in time: ${JSON.stringify(last)}`)
}

const readRaw = async (serverUrl: string, archive: RawArchive) => {
  let chunkCount = 0
  let largestChunk = 0
  let largestObject = 0
  let text = ""
  for (const object of archive.objects) {
    largestObject = Math.max(largestObject, object.currentSizeBytes)
    const page = await getJSON<RawContentPage>(
      serverUrl,
      `/api/v1/raw-objects/${encodeURIComponent(object.objectId)}/content?generation=${object.currentGeneration}&limit=8`
    )
    expect(page.nextCursor).toBeUndefined()
    chunkCount += page.chunks.length
    for (const chunk of page.chunks) {
      largestChunk = Math.max(largestChunk, chunk.sizeBytes)
      text += Buffer.from(chunk.contentBase64, "base64").toString("utf8")
    }
  }
  return { chunkCount, largestChunk, largestObject, text }
}

const sessionMetadata = (
  id: string,
  cwd: string,
  options: { readonly sessionId?: string; readonly parentThreadId?: string; readonly nickname?: string } = {}
) => {
  const timestamp = new Date().toISOString()
  return {
    timestamp,
    type: "session_meta",
    payload: {
      id,
      session_id: options.sessionId ?? id,
      timestamp,
      cwd,
      thread_source: options.parentThreadId === undefined ? "user" : "subagent",
      source: options.parentThreadId === undefined
        ? {}
        : { subagent: { thread_spawn: {
            parent_thread_id: options.parentThreadId,
            agent_nickname: options.nickname
          } } },
      git: {}
    }
  }
}

const completedItem = (
  id: string,
  threadId: string,
  text: string,
  type: "UserMessage" | "AgentMessage"
) => ({
  timestamp: new Date().toISOString(),
  type: "event_msg",
  payload: {
    type: "item_completed",
    thread_id: threadId,
    item: {
      type,
      id,
      content: [{ type: type === "UserMessage" ? "input_text" : "output_text", text }]
    }
  }
})

const jsonLines = (records: ReadonlyArray<unknown>) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`

const required = <A>(value: A | undefined, label: string): A => {
  if (value === undefined) throw new Error(`Missing ${label}.`)
  return value
}

type CollectionReport = {
  readonly jobs: ReadonlyArray<{ readonly observations: number; readonly rawChunks: number }>
  readonly failures: ReadonlyArray<unknown>
}

type ManagedCollectorStatus = {
  readonly running: boolean
  readonly collectorFailure?: { readonly message: string }
  readonly jobs: ReadonlyArray<{
    readonly projectId: string
    readonly adapterId: string
    readonly state: string
    readonly observations?: number
    readonly rawChunks?: number
  }>
}

type Workspace = {
  readonly teams: ReadonlyArray<{
    readonly id: string
    readonly projects: ReadonlyArray<{
      readonly id: string
      readonly sessionCount: number
      readonly activeSessionCount: number
    }>
  }>
}

type ProjectMemory = {
  readonly active: ReadonlyArray<SessionSummary>
  readonly trail: ReadonlyArray<SessionSummary>
}

type SessionSummary = {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly childThreadCount: number
}

type Conversation = {
  readonly session: { readonly status: string }
  readonly events: ReadonlyArray<{
    readonly id: string
    readonly text: string
    readonly childThread?: { readonly id: string }
  }>
}

type SearchPage = { readonly results: ReadonlyArray<{ readonly text: string }> }

type RawArchive = {
  readonly objects: ReadonlyArray<{
    readonly objectId: string
    readonly currentGeneration: number
    readonly currentSizeBytes: number
    readonly currentFinalized: boolean
  }>
}

type RawContentPage = {
  readonly chunks: ReadonlyArray<{
    readonly sizeBytes: number
    readonly contentBase64: string
  }>
  readonly nextCursor?: string
}
