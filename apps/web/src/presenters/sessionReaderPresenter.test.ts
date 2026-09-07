import type { CanonicalEvent, Conversation } from "@atape/domain"
import { describe, expect, it } from "vitest"
import { presentConversationTurns } from "./sessionReaderPresenter.ts"

const event = (
  id: string,
  kind: CanonicalEvent["kind"],
  author: string,
  text = id
): CanonicalEvent => ({ id, kind, author, text, occurredAt: `2026-09-07T00:00:${id.padStart(2, "0")}Z` })

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
  events
})

describe("presentConversationTurns", () => {
  it("shows only the last Codex message as the response and folds every process event", () => {
    const input = conversation([
      event("01", "message", "User", "Please fix it"),
      event("02", "thought", "Codex", "Planning the change"),
      event("03", "message", "Codex", "I am checking the implementation"),
      { ...event("04", "tool_call", "Codex", "exec · completed"), toolLabel: "exec" },
      event("05", "tool_result", "Codex", "exec · completed"),
      event("06", "artifact", "Codex"),
      event("07", "spawn", "Codex"),
      event("08", "lifecycle", "Codex"),
      event("09", "context", "Codex"),
      event("10", "notice", "Codex"),
      event("11", "message", "Codex", "The fix is complete")
    ])

    expect(presentConversationTurns(input)).toEqual([{
      id: "01",
      userMessage: input.events[0],
      agentResponse: input.events[10],
      processEvents: input.events.slice(1, 10)
    }])
  })

  it("uses each user message as a turn boundary", () => {
    const input = conversation([
      event("01", "message", "user", "First request"),
      event("02", "message", "CODEX", "First answer"),
      event("03", "message", "User", "Second request"),
      event("04", "thought", "Codex", "Working"),
      event("05", "message", "Codex", "Second answer")
    ])

    const turns = presentConversationTurns(input)
    expect(turns).toHaveLength(2)
    expect(turns.map((turn) => turn.userMessage?.id)).toEqual(["01", "03"])
    expect(turns.map((turn) => turn.agentResponse?.id)).toEqual(["02", "05"])
    expect(turns[1]?.processEvents.map((item) => item.id)).toEqual(["04"])
  })

  it("retains activity before the first prompt and incomplete turns without inventing a reply", () => {
    const input = conversation([
      event("01", "context", "System", "Session context"),
      event("02", "notice", "System", "Capture started"),
      event("03", "message", "User", "Still working?"),
      event("04", "thought", "Codex", "Investigating"),
      event("05", "tool_call", "Codex", "exec · in_progress")
    ])

    expect(presentConversationTurns(input)).toEqual([
      { id: "01", processEvents: input.events.slice(0, 2) },
      { id: "03", userMessage: input.events[2], processEvents: input.events.slice(3) }
    ])
  })

  it("returns no turns when the conversation has no events", () => {
    expect(presentConversationTurns(conversation([]))).toEqual([])
  })
})
