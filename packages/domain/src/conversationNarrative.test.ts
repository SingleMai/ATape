import type { CanonicalEvent, Conversation } from "./memory.ts"
import { describe, expect, it } from "vitest"
import { projectConversationNarrative } from "./conversationNarrative.ts"

const event = (
  id: string,
  kind: CanonicalEvent["kind"],
  author: string,
  text = id
): CanonicalEvent => ({
  id,
  kind,
  author,
  text,
  occurredAt: `2026-09-07T00:00:${id.padStart(2, "0")}Z`
})

const conversation = (events: ReadonlyArray<CanonicalEvent>): Conversation => ({
  session: {
    id: "session-1",
    projectId: "project-1",
    title: "Test conversation",
    actor: { name: "User", harness: "Codex" },
    branch: "main",
    status: "active",
    captureStatus: "healthy",
    updatedAt: "2026-09-07T00:01:00Z"
  },
  thread: { id: "thread-1", label: "Root", captureStatus: "healthy" },
  threadPath: [{ id: "thread-1", label: "Root" }],
  events: [...events]
})

describe("projectConversationNarrative", () => {
  it("promotes the last agent message and keeps ordinary process events in activity", () => {
    const input = conversation([
      event("01", "message", "User", "Please fix it"),
      event("02", "thought", "Codex", "Planning the change"),
      event("03", "message", "Codex", "I am checking the implementation"),
      event("04", "tool_call", "Codex", "exec · completed"),
      event("05", "tool_result", "Codex", "command output"),
      event("06", "message", "Codex", "The fix is complete")
    ])

    expect(projectConversationNarrative(input)).toEqual([{
      id: "01",
      basis: "user_message",
      prompt: input.events[0],
      primaryResponse: input.events[5],
      activity: input.events.slice(1, 5),
      highlights: []
    }])
  })

  it("uses recognized user messages as derived boundaries without adding them to Canonical", () => {
    const input = conversation([
      event("01", "message", " user ", "First request"),
      event("02", "message", "CODEX", "First answer"),
      event("03", "message", "User", "Second request"),
      event("04", "thought", "Codex", "Working"),
      event("05", "message", "Codex", "Second answer")
    ])

    const narrative = projectConversationNarrative(input)
    expect(narrative).toHaveLength(2)
    expect(narrative.map((exchange) => exchange.prompt?.id)).toEqual(["01", "03"])
    expect(narrative.map((exchange) => exchange.primaryResponse?.id)).toEqual(["02", "05"])
    expect(narrative[1]?.activity.map((item) => item.id)).toEqual(["04"])
    expect(input.events.map((item) => item.id)).toEqual(["01", "02", "03", "04", "05"])
  })

  it("keeps artifacts, notices, child threads, and unclassified messages visible", () => {
    const childEvent: CanonicalEvent = {
      ...event("04", "spawn", "Codex", "Delegated investigation"),
      childThread: {
        id: "thread-child",
        label: "Investigation",
        summary: "Trace the error",
        captureStatus: "healthy",
        eventCount: 3
      }
    }
    const input = conversation([
      event("01", "message", "User", "Investigate"),
      event("02", "artifact", "Codex", "report.md"),
      event("03", "notice", "System", "Capture is partial"),
      childEvent,
      event("05", "message", "Reviewer", "Independent review"),
      event("06", "message", "Codex", "Investigation complete")
    ])

    expect(projectConversationNarrative(input)[0]).toEqual({
      id: "01",
      basis: "user_message",
      prompt: input.events[0],
      primaryResponse: input.events[5],
      activity: [],
      highlights: input.events.slice(1, 5)
    })
  })

  it("preserves thread-start and incomplete data without inventing a prompt or response", () => {
    const input = conversation([
      event("01", "context", "System", "Session context"),
      event("02", "notice", "System", "Capture started"),
      event("03", "message", "User", "Still working?"),
      event("04", "thought", "Codex", "Investigating"),
      event("05", "tool_call", "Codex", "exec · in_progress")
    ])

    expect(projectConversationNarrative(input)).toEqual([
      {
        id: "01",
        basis: "thread_start",
        activity: [input.events[0]],
        highlights: [input.events[1]]
      },
      {
        id: "03",
        basis: "user_message",
        prompt: input.events[2],
        activity: input.events.slice(3),
        highlights: []
      }
    ])
  })

  it("returns no exchanges when the conversation has no events", () => {
    expect(projectConversationNarrative(conversation([]))).toEqual([])
  })
})
