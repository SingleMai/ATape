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

    expect(first.hasMore).toBe(true)
    expect(first.observations).toHaveLength(1)
    const observation = first.observations[0]
    expect(observation?.session).toMatchObject({
      sourceSessionId: "session-root",
      title: "Why were there two charges?",
      actor: { name: "User", harness: "Codex" },
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
    expect(observation?.rawSegments).toEqual([])
    const rawObservation = requiredObservation(await collect(runtime, first.nextCursor))
    expect(rawObservation.events).toEqual([])
    expect(rawObservation.rawSegments).toHaveLength(2)
    expect(rawObservation.rawSegments.every((segment) => segment.mediaType === "application/x-ndjson")).toBe(true)
    expect(rawObservation.rawSegments.map((segment) => segment.content).join(""))
      .toContain("provider-only-private-field")
    expect(JSON.stringify(observation?.events)).not.toContain("provider-only-private-field")
  })

  it("projects legacy event messages plus post-turn response summaries and tools", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "legacy-events.jsonl")
    await writeJsonl(file, [
      sessionMeta({ id: "legacy-event-session", cwd: root.project }),
      responseItem("2026-08-16T00:00:00.100Z", {
        type: "message",
        role: "user",
        id: "restored-context",
        content: [{ type: "input_text", text: "Restored context must not become a new event" }]
      }),
      turnContext("2026-08-16T00:00:01.000Z"),
      legacyMessage("2026-08-16T00:00:02.000Z", "user_message", "Inspect the legacy event stream", "user-1"),
      responseItem("2026-08-16T00:00:03.000Z", {
        type: "reasoning",
        id: "legacy-summary",
        summary: [{ type: "summary_text", text: "Use the live event boundary" }],
        encrypted_content: "provider-only-reasoning"
      }),
      legacyMessage("2026-08-16T00:00:04.000Z", "agent_message", "The event boundary is sound"),
      responseItem("2026-08-16T00:00:05.000Z", {
        type: "custom_tool_call",
        id: "legacy-live-tool",
        call_id: "call-1",
        name: "exec",
        status: "completed",
        input: "provider-only-tool-input"
      }),
      responseItem("2026-08-16T00:00:06.000Z", {
        type: "custom_tool_call_output",
        id: "legacy-live-output",
        call_id: "call-1",
        output: "provider-only-tool-output"
      }),
      taskStarted("2026-08-16T00:00:07.000Z"),
      responseItem("2026-08-16T00:00:07.100Z", {
        type: "function_call",
        id: "restored-tool",
        call_id: "call-restored",
        name: "apply_patch",
        arguments: "restored context"
      }),
      turnContext("2026-08-16T00:00:08.000Z"),
      legacyMessage("2026-08-16T00:00:09.000Z", "user_message", "Continue", "user-2"),
      responseItem("2026-08-16T00:00:10.000Z", {
        type: "function_call",
        id: "legacy-live-function",
        call_id: "call-2",
        name: "apply_patch",
        arguments: "provider-only-function-input"
      }),
      legacyMessage("2026-08-16T00:00:11.000Z", "agent_message", "Done")
    ])

    const runtime = await openAdapter(root.project, "directory")
    const page = await collect(runtime)
    const observation = requiredObservation(page)
    const projected = observation.events.map((event) => event.update)

    expect(observation.session.title).toBe("Inspect the legacy event stream")
    expect(projected.map((update) => update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_thought_chunk",
      "agent_message_chunk",
      "tool_call",
      "user_message_chunk",
      "tool_call",
      "agent_message_chunk"
    ])
    expect(observation.events.map((event) => event.sourceEventId)).toContain("legacy-summary")
    expect(observation.events.map((event) => event.sourceEventId)).toContain("legacy-live-tool")
    expect(observation.events.map((event) => event.sourceEventId)).toContain("legacy-live-function")
    expect(observation.events.map((event) => event.sourceEventId)).not.toContain("restored-context")
    expect(observation.events.map((event) => event.sourceEventId)).not.toContain("restored-tool")
    expect(JSON.stringify(observation.events)).not.toContain("provider-only")
  })

  it("falls back to response_item when legacy event messages are unavailable", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "legacy.jsonl")
    await writeJsonl(file, [
      sessionMeta({ id: "legacy-session", cwd: root.project }),
      responseItem("2026-08-16T00:00:01.000Z", {
        type: "message",
        role: "developer",
        id: "developer-1",
        content: [{ type: "input_text", text: "Provider-only instruction" }]
      }),
      responseItem("2026-08-16T00:00:02.000Z", {
        type: "message",
        role: "user",
        id: "legacy-user",
        content: [
          { type: "input_text", text: "Inspect the legacy archive" },
          { type: "input_image", image_url: "data:image/png;base64,private" }
        ]
      }),
      responseItem("2026-08-16T00:00:03.000Z", {
        type: "message",
        role: "assistant",
        id: "legacy-agent",
        content: [{ type: "output_text", text: "I will inspect it." }]
      }),
      responseItem("2026-08-16T00:00:04.000Z", {
        type: "reasoning",
        id: "legacy-thought",
        summary: [{ type: "summary_text", text: "Compare both projections" }],
        encrypted_content: "provider-only-reasoning"
      }),
      responseItem("2026-08-16T00:00:05.000Z", {
        type: "custom_tool_call",
        id: "legacy-tool",
        call_id: "call-1",
        name: "exec",
        status: "completed",
        input: "provider-only-tool-input"
      }),
      responseItem("2026-08-16T00:00:06.000Z", {
        type: "custom_tool_call_output",
        id: "legacy-tool-output",
        call_id: "call-1",
        output: "provider-only-tool-output"
      }),
      responseItem("2026-08-16T00:00:07.000Z", {
        type: "function_call",
        id: "legacy-function",
        call_id: "call-2",
        name: "apply_patch",
        arguments: "provider-only-function-input"
      }),
      responseItem("2026-08-16T00:00:08.000Z", {
        type: "function_call_output",
        id: "legacy-function-output",
        call_id: "call-2",
        output: "provider-only-function-output"
      }),
      responseItem("2026-08-16T00:00:09.000Z", {
        type: "agent_message",
        id: "legacy-agent-direct",
        author: "agent",
        content: [{ type: "input_text", text: "A delegated result" }]
      })
    ])

    const runtime = await openAdapter(root.project, "directory")
    const page = await collect(runtime)
    const observation = requiredObservation(page)

    expect(observation.session.title).toBe("Inspect the legacy archive")
    expect(observation.events.map((event) => event.sourceEventId)).toEqual([
      "legacy-user",
      "legacy-agent",
      "legacy-thought",
      "legacy-tool",
      "legacy-function",
      "legacy-agent-direct"
    ])
    expect(observation.events.find((event) => event.sourceEventId === "legacy-tool")?.update)
      .toMatchObject({ sessionUpdate: "tool_call", title: "exec", kind: "execute", status: "completed" })
    expect(observation.events.find((event) => event.sourceEventId === "legacy-function")?.update)
      .toMatchObject({ sessionUpdate: "tool_call", title: "apply_patch", kind: "edit", status: "completed" })
    expect(JSON.stringify(observation.events)).not.toContain("provider-only")
    const rawObservation = requiredObservation(await collect(runtime, page.nextCursor))
    expect(rawObservation.rawSegments.map((segment) => segment.content).join(""))
      .toContain("provider-only-tool-output")
  })

  it("prefers supported item_completed records when both Codex projections coexist", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "mixed.jsonl")
    await writeJsonl(file, [
      sessionMeta({ id: "mixed-session", cwd: root.project }),
      responseItem("2026-08-27T00:00:01.000Z", {
        type: "message",
        role: "user",
        id: "response-user",
        content: [{ type: "input_text", text: "Use the normalized projection" }]
      }),
      itemCompleted("2026-08-27T00:00:01.001Z", "mixed-session", {
        type: "UserMessage",
        id: "completed-user",
        content: [{ type: "input_text", text: "Use the normalized projection" }]
      }),
      itemCompleted("2026-08-27T00:00:02.000Z", "mixed-session", {
        type: "Reasoning",
        id: "completed-thought",
        summary_text: ["Keep one representation"]
      }),
      responseItem("2026-08-27T00:00:02.001Z", {
        type: "reasoning",
        id: "completed-thought",
        summary: [{ type: "summary_text", text: "Keep one representation" }]
      }),
      itemCompleted("2026-08-27T00:00:03.000Z", "mixed-session", {
        type: "AgentMessage",
        id: "completed-agent",
        content: [{ type: "output_text", text: "Only once" }]
      }),
      responseItem("2026-08-27T00:00:03.001Z", {
        type: "message",
        role: "assistant",
        id: "completed-agent",
        content: [{ type: "output_text", text: "Only once" }]
      }),
      responseItem("2026-08-27T00:00:04.000Z", {
        type: "custom_tool_call",
        id: "response-tool",
        call_id: "call-1",
        name: "exec",
        status: "completed"
      }),
      itemCompleted("2026-08-27T00:00:04.001Z", "mixed-session", {
        type: "CommandExecution",
        id: "completed-tool",
        command: ["pnpm", "test"],
        status: "completed",
        exit_code: 0
      }),
      responseItem("2026-08-27T00:00:04.002Z", {
        type: "custom_tool_call_output",
        id: "response-tool-output",
        call_id: "call-1",
        output: "hidden"
      })
    ])

    const observation = requiredObservation(await collect(await openAdapter(root.project, "directory")))

    expect(observation.session.title).toBe("Use the normalized projection")
    expect(observation.events.map((event) => event.sourceEventId)).toEqual([
      "completed-user",
      "completed-thought",
      "completed-agent",
      "completed-tool"
    ])
  })

  it("uses legacy event messages when item_completed contains only unsupported Codex items", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "transition.jsonl")
    await writeJsonl(file, [
      sessionMeta({ id: "transition-session", cwd: root.project }),
      responseItem("2026-08-20T00:00:01.000Z", {
        type: "message",
        role: "user",
        id: "transition-user",
        content: [{ type: "input_text", text: "Restored transition context" }]
      }),
      turnContext("2026-08-20T00:00:01.500Z"),
      legacyMessage(
        "2026-08-20T00:00:01.600Z",
        "user_message",
        "Do not mistake Plan for the new projection",
        "transition-live-user"
      ),
      itemCompleted("2026-08-20T00:00:02.000Z", "transition-session", {
        type: "Plan",
        id: "unsupported-plan",
        text: "Provider-only plan"
      }),
      legacyMessage("2026-08-20T00:00:03.000Z", "agent_message", "The fallback remains active")
    ])

    const observation = requiredObservation(await collect(await openAdapter(root.project, "directory")))

    expect(observation.events.map((event) => event.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk"
    ])
    expect(observation.events.map((event) => event.sourceEventId)).not.toContain("transition-user")
    expect(observation.events.map((event) => event.sourceEventId)).not.toContain("unsupported-plan")
  })

  it("assigns copied legacy response items to one owning Thread", async () => {
    const root = await makeEmptyFixture()
    const rootFile = join(root.sessionsDirectory, "legacy-root.jsonl")
    const childFile = join(root.sessionsDirectory, "legacy-child.jsonl")
    const copiedUser = responseItem("2026-08-19T00:00:01.000Z", {
      type: "message",
      role: "user",
      id: "copied-user",
      content: [{ type: "input_text", text: "Review the parent history" }]
    })
    const copiedAgent = responseItem("2026-08-19T00:00:02.000Z", {
      type: "message",
      role: "assistant",
      id: "copied-agent",
      content: [{ type: "output_text", text: "Parent answer" }]
    })
    await writeJsonl(rootFile, [
      sessionMeta({ id: "legacy-root", cwd: root.project, timestamp: "2026-08-19T00:00:00.000Z" }),
      copiedUser,
      copiedAgent
    ])
    await writeJsonl(childFile, [
      sessionMeta({
        id: "legacy-child",
        sessionId: "legacy-root",
        parentThreadId: "legacy-root",
        nickname: "reviewer",
        cwd: root.project,
        timestamp: "2026-08-19T00:00:03.000Z"
      }),
      copiedUser,
      copiedAgent,
      responseItem("2026-08-19T00:00:04.000Z", {
        type: "message",
        role: "assistant",
        id: "child-only-agent",
        content: [{ type: "output_text", text: "Child answer" }]
      })
    ])

    const observation = requiredObservation(await collect(await openAdapter(root.project, "directory")))

    expect(observation.events.map((event) => event.sourceEventId)).toEqual([
      "spawn-legacy-child",
      "copied-user",
      "copied-agent",
      "child-only-agent"
    ])
    expect(observation.events.find((event) => event.sourceEventId === "copied-agent")?.sourceThreadId)
      .toBe("legacy-root")
    expect(observation.events.find((event) => event.sourceEventId === "child-only-agent")?.sourceThreadId)
      .toBe("legacy-child")
  })

  it("migrates legacy cursors by replaying Canonical data and advertises following Sessions", async () => {
    const root = await makeEmptyFixture()
    const firstFile = join(root.sessionsDirectory, "first.jsonl")
    const secondFile = join(root.sessionsDirectory, "second.jsonl")
    await writeJsonl(firstFile, [
      sessionMeta({ id: "first-session", cwd: root.project }),
      responseItem("2026-08-16T00:00:01.000Z", {
        type: "message",
        role: "assistant",
        id: "first-agent",
        content: [{ type: "output_text", text: "First" }]
      })
    ])
    await writeJsonl(secondFile, [
      sessionMeta({ id: "second-session", cwd: root.project }),
      responseItem("2026-08-17T00:00:01.000Z", {
        type: "message",
        role: "assistant",
        id: "second-agent",
        content: [{ type: "output_text", text: "Second" }]
      })
    ])
    const firstModified = new Date("2026-08-16T01:00:00.000Z")
    const secondModified = new Date("2026-08-17T01:00:00.000Z")
    await utimes(firstFile, firstModified, firstModified)
    await utimes(secondFile, secondModified, secondModified)
    const runtime = await openAdapter(root.project, "directory")

    const first = await collect(runtime)
    const firstObservation = requiredObservation(first)
    expect(firstObservation.session.sourceSessionId).toBe("first-session")
    expect(firstObservation.rawSegments).toEqual([])
    expect(firstObservation.session.revision).toBe(firstModified.getTime() * 1_000 * 2 + 6)
    expect(first.hasMore).toBe(true)
    const second = await collect(runtime, first.nextCursor)
    const secondObservation = requiredObservation(second)
    expect(secondObservation.session.sourceSessionId).toBe("second-session")
    expect(secondObservation.rawSegments).toEqual([])
    expect(second.hasMore).toBe(true)

    const rawAfterCanonical = requiredObservation(await collect(runtime, second.nextCursor))
    expect(rawAfterCanonical.session.sourceSessionId).toBe("first-session")
    expect(rawAfterCanonical.events).toEqual([])
    expect(rawAfterCanonical.rawSegments).not.toEqual([])

    for (const version of [1, 2, 3]) {
      const replay = await collect(runtime, Buffer.from(JSON.stringify({
        v: version,
        watermarkModifiedMs: secondModified.getTime() + 1,
        watermarkSessionId: "after-everything",
        commitSequence: 2
      })).toString("base64url"))
      expect(requiredObservation(replay).session.sourceSessionId).toBe("first-session")
      expect(replay.hasMore).toBe(true)
      if (replay.nextCursor === null) throw new Error("Expected migrated Cursor")
      expect(JSON.parse(Buffer.from(replay.nextCursor, "base64url").toString("utf8"))).toMatchObject({ v: 5 })
    }

    const stalled = await collect(runtime, null, [], {
      ...AdapterCollectionLimits,
      eventsPerObservation: 0
    })
    if (stalled.nextCursor === null) throw new Error("Expected active Cursor")
    const old = JSON.parse(Buffer.from(stalled.nextCursor, "base64url").toString("utf8")) as {
      readonly active: { readonly phase?: string }
    }
    const { phase: _phase, ...oldActive } = old.active
    const migrated = await collect(runtime, Buffer.from(JSON.stringify({
      ...old,
      v: 4,
      active: oldActive
    })).toString("base64url"))
    expect(requiredObservation(migrated).events).not.toEqual([])
    if (migrated.nextCursor === null) throw new Error("Expected migrated Cursor")
    expect(JSON.parse(Buffer.from(migrated.nextCursor, "base64url").toString("utf8"))).toMatchObject({ v: 5 })
  })

  it("prefers the latest valid Codex title index record", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "titled.jsonl")
    await writeJsonl(file, [
      sessionMeta({ id: "titled-session", cwd: root.project }),
      itemCompleted("2026-09-05T00:00:01.000Z", "titled-session", {
        type: "UserMessage",
        id: "title-user",
        content: [{ type: "input_text", text: "This first prompt is only the fallback" }]
      })
    ])
    const rolloutModified = new Date("2026-09-05T00:03:00.000Z")
    await utimes(file, rolloutModified, rolloutModified)
    await writeFile(join(root.codexHome, "session_index.jsonl"), [
      JSON.stringify(sessionTitle("titled-session", "Old generated title", "2026-09-05T00:01:00.000Z")),
      "not-json",
      JSON.stringify(sessionTitle("titled-session", "  Checkout   accessibility review  ", "2026-09-05T00:02:00.000Z")),
      JSON.stringify(sessionTitle("titled-session", "   ", "2026-09-05T00:03:00.000Z")),
      "{\"id\":\"incomplete"
    ].join("\n"))

    const observation = requiredObservation(await collect(await openAdapter(root.project, "directory")))

    expect(observation.session.title).toBe("Checkout accessibility review")
    expect(observation.session.updatedAt).toBe("2026-09-05T00:03:00.000Z")
    expect(observation.session.revision).toBe(rolloutModified.getTime() * 1_000 * 2 + 6)
  })

  it("collects a title-only rename without new rollout or Raw bytes", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "rename.jsonl")
    const index = join(root.codexHome, "session_index.jsonl")
    await writeJsonl(file, [
      sessionMeta({ id: "renamed-session", cwd: root.project }),
      itemCompleted("2026-09-05T00:00:01.000Z", "renamed-session", {
        type: "UserMessage",
        id: "rename-user",
        content: [{ type: "input_text", text: "Fallback prompt" }]
      })
    ])
    const rolloutModified = new Date("2026-09-04T23:59:00.000Z")
    await utimes(file, rolloutModified, rolloutModified)
    await writeJsonl(index, [
      sessionTitle("renamed-session", "Initial Codex title", "2026-09-05T00:01:00.000Z")
    ])
    const runtime = await openAdapter(root.project, "directory")
    const first = await collect(runtime)
    const initial = requiredObservation(first)
    const progress = rawProgress(initial.session.sourceSessionId, initial.rawSegments)

    await appendFile(index, `${JSON.stringify(
      sessionTitle("renamed-session", "Renamed in Codex", "2026-09-05T00:02:00.000Z")
    )}\n`)
    const renamed = await collect(runtime, first.nextCursor, progress)
    const observation = requiredObservation(renamed)

    expect(observation.session.title).toBe("Renamed in Codex")
    expect(observation.session.revision).toBeGreaterThan(initial.session.revision)
    expect(observation.rawSegments).toEqual([])
    const raw = await collect(runtime, renamed.nextCursor, progress)
    const rawObservation = requiredObservation(raw)
    const completedProgress = mergeProgress(progress, rawObservation.session.sourceSessionId, rawObservation.rawSegments)
    expect((await collect(runtime, raw.nextCursor, completedProgress)).observations).toEqual([])
  })

  it("resumes Raw bytes, replays Canonical events idempotently, and never mirrors provider deletion", async () => {
    const fixture = await makeFixture()
    const runtime = await openAdapter(fixture.project, "directory")
    const first = await collect(runtime)
    const firstObservation = requiredObservation(first)
    expect(firstObservation.rawSegments).toEqual([])
    const firstRaw = await collect(runtime, first.nextCursor)
    const firstRawObservation = requiredObservation(firstRaw)
    let progress = rawProgress(firstRawObservation.session.sourceSessionId, firstRawObservation.rawSegments)

    const unchanged = await collect(runtime, firstRaw.nextCursor, progress)
    expect(unchanged.observations).toEqual([])

    const appended = itemCompleted("2026-09-05T00:01:00.000Z", "session-root", {
      type: "AgentMessage",
      id: "agent-2",
      content: [{ type: "output_text", text: "A newly appended answer" }]
    })
    await appendFile(fixture.rootFile, `${JSON.stringify(appended)}\n`)
    const changedAt = new Date("2026-09-05T00:02:00.000Z")
    await utimes(fixture.rootFile, changedAt, changedAt)

    const changed = await collect(runtime, unchanged.nextCursor, progress)
    const changedObservation = requiredObservation(changed)
    expect(changedObservation.events.map((event) => event.sourceEventId)).toContain("agent-2")
    expect(changedObservation.events.map((event) => event.sourceEventId)).toContain("user-1")
    expect(changedObservation.rawSegments).toEqual([])
    const changedRaw = await collect(runtime, changed.nextCursor, progress)
    const changedRawObservation = requiredObservation(changedRaw)
    expect(changedRawObservation.rawSegments).toHaveLength(1)
    expect(changedRawObservation.rawSegments[0]).toMatchObject({
      sourceOffset: progress.find((item) => item.sourceObjectId === changedRawObservation.rawSegments[0]?.sourceObjectId)
        ?.sourceOffset,
      final: false
    })
    expect(changedRawObservation.rawSegments[0]?.content).toBe(`${JSON.stringify(appended)}\n`)
    progress = mergeProgress(progress, changedRawObservation.session.sourceSessionId, changedRawObservation.rawSegments)

    await rename(fixture.rootFile, join(fixture.archivedDirectory, "root.jsonl"))
    await rename(fixture.childFile, join(fixture.archivedDirectory, "child.jsonl"))
    const archived = await collect(runtime, changedRaw.nextCursor, progress)
    const archivedObservation = requiredObservation(archived)
    expect(archived.nextCursor).not.toBe(changedRaw.nextCursor)
    expect(archivedObservation.session.status).toBe("ended")
    expect(archivedObservation.rawSegments).toHaveLength(2)
    expect(archivedObservation.rawSegments.every((segment) => segment.content === "" && segment.final)).toBe(true)
    progress = mergeProgress(progress, archivedObservation.session.sourceSessionId, archivedObservation.rawSegments)

    await rm(fixture.archivedDirectory, { recursive: true, force: true })
    await mkdir(fixture.archivedDirectory, { recursive: true })
    const deleted = await collect(runtime, archived.nextCursor, progress)
    expect(deleted.observations).toEqual([])
  })

  it("passes recorded Git metadata to the Host and obeys its attribution decision", async () => {
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

    const sources: Array<unknown> = []
    const runtime = await openAdapter(root.project, "git", {
      version: "atape.git-attribution.v1",
      resolve: async source => { sources.push(source); return "included" }
    })
    const page = await collect(runtime)

    expect(requiredObservation(page).session.sourceSessionId).toBe("remote-session")
    expect(sources[0]).toMatchObject({ sourceId: "remote-session", cwd: outside, repositoryRemote: "ssh://git@github.com/Example/ATape.git" })
    const denied = await openAdapter(root.project, "git", { version: "atape.git-attribution.v1", resolve: async () => "excluded" })
    expect((await collect(denied)).observations).toEqual([])
    const unknown = await openAdapter("/deleted/project", "git", { version: "atape.git-attribution.v1", resolve: async () => "unknown" })
    const unknownPage = await collect(unknown)
    expect(unknownPage).toMatchObject({ observations: [], sourceFailures: [{ reason: "attribution" }] })
    const recovered = await collect(runtime, unknownPage.nextCursor)
    expect(requiredObservation(recovered).events.length).toBeGreaterThan(0)
    expect(requiredObservation(await collect(runtime, recovered.nextCursor)).rawSegments.length).toBeGreaterThan(0)
    await expect(openAdapter(root.project, "git")).rejects.toThrow("Upgrade")
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
    expect(firstObservation.rawSegments).toEqual([])
    const raw = await collect(runtime, first.nextCursor)
    const rawObservation = requiredObservation(raw)
    expect(rawObservation.rawSegments.map((segment) => segment.content).join(""))
      .not.toContain("partial-answer")
    const unchanged = await collect(
      runtime,
      raw.nextCursor,
      rawProgress(rawObservation.session.sourceSessionId, rawObservation.rawSegments)
    )
    expect(unchanged.observations).toEqual([])
  })

  it("keeps oversized compaction records in Raw while omitting them from Canonical events", async () => {
    const root = await makeEmptyFixture()
    const file = join(root.sessionsDirectory, "large-compaction.jsonl")
    const compacted = {
      timestamp: "2026-08-16T00:00:02.000Z",
      type: "compacted",
      payload: {
        message: "",
        replacement_history: [{ type: "provider_private", value: "x".repeat(5 * 1024 * 1024) }],
        window_number: 2
      }
    }
    await writeJsonl(file, [
      sessionMeta({ id: "large-compaction", cwd: root.project }),
      turnContext("2026-08-16T00:00:00.500Z"),
      legacyMessage("2026-08-16T00:00:01.000Z", "user_message", "Keep the Raw compaction", "user-1"),
      compacted,
      legacyMessage("2026-08-16T00:00:03.000Z", "agent_message", "Canonical remains small")
    ])

    const runtime = await openAdapter(root.project, "directory")
    const page = await collect(runtime)
    const observation = requiredObservation(page)

    expect(observation.events.map((event) => event.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk"
    ])
    const rawObservation = requiredObservation(await collect(runtime, page.nextCursor))
    expect(rawObservation.rawSegments).toHaveLength(1)
    expect(Buffer.byteLength(rawObservation.rawSegments[0]?.content ?? "")).toBeGreaterThan(4 * 1024 * 1024)
    expect(rawObservation.rawSegments[0]?.content).toContain('"type":"compacted"')
    expect(Buffer.byteLength(JSON.stringify(observation.events))).toBeLessThan(10_000)
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
      for (const observation of page.observations) {
        expect(Buffer.byteLength(JSON.stringify({
          session: observation.session,
          threads: observation.threads,
          events: observation.events
        }))).toBeLessThanOrEqual(limits.canonicalBytesPerObservation)
        expect(observation.rawSegments.reduce((bytes, segment) =>
          bytes + Buffer.byteLength(segment.content), 0)).toBeLessThanOrEqual(limits.rawBytesPerObservation)
        eventIds.push(...observation.events.map((event) => event.sourceEventId))
        progress = mergeProgress(progress, observation.session.sourceSessionId, observation.rawSegments)
      }
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

const openAdapter = (project: string, type: "git" | "directory", gitAttribution?: import("@atape/domain").AdapterOpenContext["gitAttribution"]) => createAtapeAdapter({
  ...(gitAttribution === undefined ? {} : { gitAttribution }),
  protocolVersion: AdapterProtocolVersion,
  adapter: { id: "codex", version: "0.1.0" },
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

const responseItem = (timestamp: string, item: Record<string, unknown>) => ({
  timestamp,
  type: "response_item",
  payload: item
})

const turnContext = (timestamp: string) => ({
  timestamp,
  type: "turn_context",
  payload: { turn_id: "turn-1" }
})

const taskStarted = (timestamp: string) => ({
  timestamp,
  type: "event_msg",
  payload: { type: "task_started", turn_id: "turn-2" }
})

const legacyMessage = (
  timestamp: string,
  type: "user_message" | "agent_message",
  message: string,
  clientId?: string
) => ({
  timestamp,
  type: "event_msg",
  payload: {
    type,
    message,
    ...(clientId === undefined ? {} : { client_id: clientId })
  }
})

const sessionTitle = (id: string, threadName: string, updatedAt: string) => ({
  id,
  thread_name: threadName,
  updated_at: updatedAt
})

const writeJsonl = (path: string, records: ReadonlyArray<unknown>) =>
  writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`)

const runGit = async (cwd: string, args: ReadonlyArray<string>) => {
  const { execFile } = await import("node:child_process")
  await new Promise<void>((resolve, reject) => execFile("git", args, { cwd }, (error) => error ? reject(error) : resolve()))
}
