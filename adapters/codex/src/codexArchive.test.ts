import {
  AdapterCollectionLimits,
  type AdapterCollectionLimitValues,
  AdapterProtocolVersion,
  type AdapterCollectionPage,
  type AdapterSourceProgress,
  type AtapeAdapterRuntime
} from "@atape/domain"
import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createAtapeAdapter } from "./index.ts"

const temporaryDirectories: Array<string> = []
const previousCodexHome = process.env.ATAPE_CODEX_HOME

afterEach(async () => {
  if (previousCodexHome === undefined) delete process.env.ATAPE_CODEX_HOME
  else process.env.ATAPE_CODEX_HOME = previousCodexHome
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("Codex Adapter", () => {
  it("projects a Codex session and its subagent while keeping Raw records separate", async () => {
    const fixture = await makeFixture()
    const runtime = await openAdapter(fixture.project, "directory")

    const first = await collect(runtime)

    expect(first.hasMore).toBe(false)
    expect(first.observations).toHaveLength(1)
    const observation = first.observations[0]
    expect(observation?.session).toMatchObject({
      sourceSessionId: "session-root",
      title: "Why were there two charges?",
      actor: { name: "user-7", harness: "Codex" },
      branch: "main",
      status: "active"
    })
    expect(observation?.threads).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceThreadId: "session-root", label: "Main" }),
      expect.objectContaining({
        sourceThreadId: "child-a",
        parentSourceThreadId: "session-root",
        label: "reviewer"
      })
    ]))
    expect(observation?.events.map((event) => event.sourceEventId)).toEqual([
      "spawn-child-a",
      "user-1",
      "agent-1",
      "thought-1",
      "command-1",
      "child-answer"
    ])
    expect(observation?.events.find((event) => event.sourceEventId === "spawn-child-a")).toMatchObject({
      sourceThreadId: "session-root",
      childSourceThreadId: "child-a",
      fidelity: "derived"
    })
    expect(observation?.events.find((event) => event.sourceEventId === "child-answer")?.sourceThreadId)
      .toBe("child-a")
    expect(observation?.events.some((event) => event.sourceEventId === "copied-parent")).toBe(false)
    expect(observation?.events.find((event) => event.sourceEventId === "thought-1")?.update)
      .toMatchObject({ sessionUpdate: "agent_thought_chunk", content: { text: "Keep one key" } })
    expect(observation?.rawSegments).toHaveLength(2)
    expect(observation?.rawSegments.every((segment) => segment.mediaType === "application/x-ndjson")).toBe(true)
    expect(observation?.rawSegments.map((segment) => segment.content).join(""))
      .toContain("provider-only-private-field")
    expect(JSON.stringify(observation?.events)).not.toContain("provider-only-private-field")
  })

  it("resumes Raw bytes, replays Canonical events idempotently, and never mirrors provider deletion", async () => {
    const fixture = await makeFixture()
    const runtime = await openAdapter(fixture.project, "directory")
    const first = await collect(runtime)
    const firstObservation = requiredObservation(first)
    let progress = rawProgress(firstObservation.session.sourceSessionId, firstObservation.rawSegments)

    const unchanged = await collect(runtime, first.nextCursor, progress)
    expect(unchanged.observations).toEqual([])

    const appended = itemCompleted("2026-09-05T00:01:00.000Z", "session-root", {
      type: "AgentMessage",
      id: "agent-2",
      content: [{ type: "output_text", text: "A newly appended answer" }]
    })
    await appendFile(fixture.rootFile, `${JSON.stringify(appended)}\n`)
    const changedAt = new Date("2026-09-05T00:02:00.000Z")
    await utimes(fixture.rootFile, changedAt, changedAt)

    const changed = await collect(runtime, first.nextCursor, progress)
    const changedObservation = requiredObservation(changed)
    expect(changedObservation.events.map((event) => event.sourceEventId)).toContain("agent-2")
    expect(changedObservation.events.map((event) => event.sourceEventId)).toContain("user-1")
    expect(changedObservation.rawSegments).toHaveLength(1)
    expect(changedObservation.rawSegments[0]).toMatchObject({
      sourceOffset: progress.find((item) => item.sourceObjectId === changedObservation.rawSegments[0]?.sourceObjectId)
        ?.sourceOffset,
      final: false
    })
    expect(changedObservation.rawSegments[0]?.content).toBe(`${JSON.stringify(appended)}\n`)
    progress = mergeProgress(progress, changedObservation.session.sourceSessionId, changedObservation.rawSegments)

    await rename(fixture.rootFile, join(fixture.archivedDirectory, "root.jsonl"))
    await rename(fixture.childFile, join(fixture.archivedDirectory, "child.jsonl"))
    const archived = await collect(runtime, changed.nextCursor, progress)
    const archivedObservation = requiredObservation(archived)
    expect(archived.nextCursor).not.toBe(changed.nextCursor)
    expect(archivedObservation.session.status).toBe("ended")
    expect(archivedObservation.rawSegments).toHaveLength(2)
    expect(archivedObservation.rawSegments.every((segment) => segment.content === "" && segment.final)).toBe(true)
    progress = mergeProgress(progress, archivedObservation.session.sourceSessionId, archivedObservation.rawSegments)

    await rm(fixture.archivedDirectory, { recursive: true, force: true })
    await mkdir(fixture.archivedDirectory, { recursive: true })
    const deleted = await collect(runtime, archived.nextCursor, progress)
    expect(deleted.observations).toEqual([])
  })

  it("matches a Git project by normalized origin when Codex recorded a worktree outside its path", async () => {
    const root = await makeEmptyFixture()
    const outside = join(root.workspace, "worktree")
    await mkdir(outside)
    await writeFile(join(root.project, ".git-placeholder"), "")
    const file = join(root.sessionsDirectory, "remote.jsonl")
    await writeJsonl(file, [
      sessionMeta({
        id: "remote-session",
        cwd: outside,
        repository: "ssh://git@github.com/Example/ATape.git"
      }),
      itemCompleted("2026-09-05T01:00:01.000Z", "remote-session", {
        type: "AgentMessage",
        id: "remote-answer",
        content: [{ type: "output_text", text: "Matched by repository" }]
      })
    ])
    await runGit(root.project, ["init"])
    await runGit(root.project, ["remote", "add", "origin", "git@github.com:example/atape.git"])

    const runtime = await openAdapter(root.project, "git")
    const page = await collect(runtime)

    expect(requiredObservation(page).session.sourceSessionId).toBe("remote-session")
  })

  it("uses a stable untitled label when the root Thread has no user message", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "assistant-only.jsonl")
    await writeJsonl(file, [
      sessionMeta({ id: "assistant-only", cwd: root.project }),
      itemCompleted("2026-09-05T01:10:01.000Z", "assistant-only", {
        type: "AgentMessage",
        id: "assistant-answer",
        content: [{ type: "output_text", text: "No user prompt was recorded" }]
      })
    ])

    const runtime = await openAdapter(root.project, "directory")
    expect(requiredObservation(await collect(runtime)).session.title).toBe("Untitled Codex conversation")
  })

  it("waits for an active file's trailing JSONL record to become complete", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "partial.jsonl")
    const metadata = sessionMeta({ id: "partial-session", cwd: root.project })
    const complete = itemCompleted("2026-09-05T02:00:01.000Z", "partial-session", {
      type: "AgentMessage",
      id: "complete-answer",
      content: [{ type: "output_text", text: "Complete" }]
    })
    const partial = itemCompleted("2026-09-05T02:00:02.000Z", "partial-session", {
      type: "AgentMessage",
      id: "partial-answer",
      content: [{ type: "output_text", text: "Incomplete until newline" }]
    })
    await writeFile(file, `${JSON.stringify(metadata)}\n${JSON.stringify(complete)}\n${JSON.stringify(partial)}`)

    const runtime = await openAdapter(root.project, "directory")
    const first = await collect(runtime)
    const firstObservation = requiredObservation(first)
    expect(firstObservation.events.map((event) => event.sourceEventId)).toEqual(["complete-answer"])
    expect(firstObservation.rawSegments.map((segment) => segment.content).join(""))
      .not.toContain("partial-answer")
    const unchanged = await collect(
      runtime,
      first.nextCursor,
      rawProgress(firstObservation.session.sourceSessionId, firstObservation.rawSegments)
    )
    expect(unchanged.observations).toEqual([])
  })

  it("paginates Canonical and Raw independently by byte limits", async () => {
    const root = await makeEmptyFixture()
    const firstFile = join(root.sessionsDirectory, "large-a.jsonl")
    const secondFile = join(root.sessionsDirectory, "large-b.jsonl")
    const largeText = "x".repeat(700 * 1024)
    await writeJsonl(firstFile, [
      sessionMeta({ id: "large-session", cwd: root.project }),
      itemCompleted("2026-09-05T03:00:01.000Z", "large-session", {
        type: "AgentMessage", id: "large-1", content: [{ type: "output_text", text: largeText }]
      }),
      itemCompleted("2026-09-05T03:00:02.000Z", "large-session", {
        type: "AgentMessage", id: "large-2", content: [{ type: "output_text", text: largeText }]
      })
    ])
    await writeJsonl(secondFile, [
      sessionMeta({
        id: "large-session",
        cwd: root.project,
        timestamp: "2026-09-05T03:00:03.000Z"
      }),
      itemCompleted("2026-09-05T03:00:04.000Z", "large-session", {
        type: "AgentMessage", id: "large-3", content: [{ type: "output_text", text: largeText }]
      }),
      { type: "provider_private", payload: { value: "r".repeat(1536 * 1024) } }
    ])
    const runtime = await openAdapter(root.project, "directory")
    const limits: AdapterCollectionLimitValues = {
      ...AdapterCollectionLimits,
      canonicalBytesPerObservation: 1024 * 1024,
      rawBytesPerObservation: 2 * 1024 * 1024,
      rawSegmentBytes: 2 * 1024 * 1024
    }
    let cursor: string | null = null
    let progress: ReadonlyArray<AdapterSourceProgress> = []
    let pages = 0
    const eventIds: Array<string> = []
    do {
      const page = await collect(runtime, cursor, progress, limits)
      const observation = requiredObservation(page)
      expect(Buffer.byteLength(JSON.stringify({
        session: observation.session,
        threads: observation.threads,
        events: observation.events
      }))).toBeLessThanOrEqual(limits.canonicalBytesPerObservation)
      expect(observation.rawSegments.reduce((bytes, segment) =>
        bytes + Buffer.byteLength(segment.content), 0)).toBeLessThanOrEqual(limits.rawBytesPerObservation)
      eventIds.push(...observation.events.map((event) => event.sourceEventId))
      progress = mergeProgress(progress, observation.session.sourceSessionId, observation.rawSegments)
      cursor = page.nextCursor
      pages++
      if (!page.hasMore) break
    } while (pages < 10)

    expect(pages).toBeGreaterThan(1)
    expect(eventIds).toEqual(["large-1", "large-2", "large-3"])
  })
})

const makeFixture = async () => {
  const root = await makeEmptyFixture()
  const outside = join(root.workspace, "outside")
  await mkdir(outside)
  const rootFile = join(root.sessionsDirectory, "root.jsonl")
  const childFile = join(root.sessionsDirectory, "child.jsonl")
  await writeJsonl(rootFile, [
    sessionMeta({ id: "session-root", cwd: root.project, branch: "main" }),
    itemCompleted("2026-09-05T00:00:01.000Z", "session-root", {
      type: "UserMessage",
      id: "user-1",
      content: [{ type: "input_text", text: "Why were there two charges?" }]
    }),
    itemCompleted("2026-09-05T00:00:02.000Z", "session-root", {
      type: "AgentMessage",
      id: "agent-1",
      content: [{ type: "output_text", text: "I will inspect the idempotency path." }],
      provider_only: "provider-only-private-field"
    }),
    itemCompleted("2026-09-05T00:00:03.000Z", "session-root", {
      type: "Reasoning",
      id: "thought-1",
      summary_text: ["Keep one key"],
      raw_content: ["provider-only-private-field"]
    }),
    itemCompleted("2026-09-05T00:00:04.000Z", "session-root", {
      type: "CommandExecution",
      id: "command-1",
      command: ["pnpm", "test"],
      status: "completed",
      exit_code: 0
    })
  ])
  await writeJsonl(childFile, [
    sessionMeta({
      id: "child-a",
      sessionId: "session-root",
      parentThreadId: "session-root",
      nickname: "reviewer",
      cwd: root.project,
      timestamp: "2026-09-05T00:00:05.000Z"
    }),
    itemCompleted("2026-09-05T00:00:02.000Z", "session-root", {
      type: "AgentMessage",
      id: "copied-parent",
      content: [{ type: "output_text", text: "Copied parent history" }]
    }),
    itemCompleted("2026-09-05T00:00:06.000Z", "child-a", {
      type: "AgentMessage",
      id: "child-answer",
      content: [{ type: "output_text", text: "The schema is safe." }]
    })
  ])
  await writeJsonl(join(root.sessionsDirectory, "outside.jsonl"), [
    sessionMeta({ id: "outside-session", cwd: outside }),
    itemCompleted("2026-09-05T00:00:01.000Z", "outside-session", {
      type: "AgentMessage",
      id: "outside-answer",
      content: [{ type: "output_text", text: "Must not be collected" }]
    })
  ])
  await writeFile(join(root.sessionsDirectory, "malformed.jsonl"), "not json\n")
  const timestamp = new Date("2026-09-05T00:01:00.000Z")
  await Promise.all([rootFile, childFile].map((file) => utimes(file, timestamp, timestamp)))
  return { ...root, rootFile, childFile }
}

const makeEmptyFixture = async () => {
  const workspace = await mkdtemp(join(tmpdir(), "atape-codex-adapter-"))
  temporaryDirectories.push(workspace)
  const codexHome = join(workspace, "codex-home")
  const project = join(workspace, "project")
  const sessionsDirectory = join(codexHome, "sessions", "2026", "09", "05")
  const archivedDirectory = join(codexHome, "archived_sessions")
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(sessionsDirectory, { recursive: true }),
    mkdir(archivedDirectory, { recursive: true })
  ])
  process.env.ATAPE_CODEX_HOME = codexHome
  return { workspace, codexHome, project, sessionsDirectory, archivedDirectory }
}

const openAdapter = (project: string, type: "git" | "directory") => createAtapeAdapter({
  protocolVersion: AdapterProtocolVersion,
  adapter: { id: "codex", version: "0.1.0" },
  user: { id: "user-7" },
  project: { id: "project-1", type, path: project },
  signal: AbortSignal.timeout(5_000)
})

const collect = async (
  runtime: AtapeAdapterRuntime,
  cursor: string | null = null,
  rawProgressValue: ReadonlyArray<AdapterSourceProgress> = [],
  limits: AdapterCollectionLimitValues = AdapterCollectionLimits
) => await runtime.collect({
  protocolVersion: AdapterProtocolVersion,
  cursor,
  limits,
  rawProgress: rawProgressValue,
  signal: AbortSignal.timeout(5_000)
}) as AdapterCollectionPage

const requiredObservation = (page: AdapterCollectionPage) => {
  const observation = page.observations[0]
  if (observation === undefined) throw new Error("Expected one Codex observation")
  return observation
}

const rawProgress = (
  sourceSessionId: string,
  segments: AdapterCollectionPage["observations"][number]["rawSegments"]
): ReadonlyArray<AdapterSourceProgress> => segments.map((segment) => ({
  sourceSessionId,
  sourceObjectId: segment.sourceObjectId,
  sourceGeneration: segment.sourceGeneration,
  sourceOffset: segment.sourceOffset + Buffer.byteLength(segment.content),
  finalized: segment.final
}))

const mergeProgress = (
  current: ReadonlyArray<AdapterSourceProgress>,
  sourceSessionId: string,
  segments: AdapterCollectionPage["observations"][number]["rawSegments"]
) => {
  const next = new Map(current.map((item) => [item.sourceObjectId, item]))
  for (const item of rawProgress(sourceSessionId, segments)) next.set(item.sourceObjectId, item)
  return [...next.values()]
}

const sessionMeta = (input: {
  readonly id: string
  readonly cwd: string
  readonly sessionId?: string
  readonly parentThreadId?: string
  readonly nickname?: string
  readonly timestamp?: string
  readonly repository?: string
  readonly branch?: string
}) => ({
  timestamp: input.timestamp ?? "2026-09-05T00:00:00.000Z",
  type: "session_meta",
  payload: {
    id: input.id,
    session_id: input.sessionId ?? input.id,
    timestamp: input.timestamp ?? "2026-09-05T00:00:00.000Z",
    cwd: input.cwd,
    thread_source: input.parentThreadId === undefined ? "user" : "subagent",
    source: input.parentThreadId === undefined
      ? {}
      : { subagent: { thread_spawn: {
          parent_thread_id: input.parentThreadId,
          agent_nickname: input.nickname
        } } },
    git: {
      repository_url: input.repository,
      branch: input.branch
    }
  }
})

const itemCompleted = (timestamp: string, threadId: string, item: Record<string, unknown>) => ({
  timestamp,
  type: "event_msg",
  payload: { type: "item_completed", thread_id: threadId, item }
})

const writeJsonl = (path: string, records: ReadonlyArray<unknown>) =>
  writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

const runGit = async (cwd: string, args: ReadonlyArray<string>) => {
  const { execFile } = await import("node:child_process")
  await new Promise<void>((resolve, reject) => execFile("git", args, { cwd }, (error) => error ? reject(error) : resolve()))
}
