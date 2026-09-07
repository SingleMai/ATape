import type { CanonicalEvent, Conversation } from "@atape/domain"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { LoadableView } from "../presenters/memoryPresenter.ts"
import { SessionReaderView } from "./SessionReaderView.tsx"

const event = (
  id: string,
  kind: CanonicalEvent["kind"],
  author: string,
  text: string,
  toolLabel?: string
): CanonicalEvent => ({
  id,
  kind,
  author,
  text,
  occurredAt: `2026-09-07T00:00:${id.padStart(2, "0")}Z`,
  ...(toolLabel === undefined ? {} : { toolLabel })
})

const value: Conversation = {
  session: {
    id: "session-1",
    projectId: "project-1",
    title: "Reader hierarchy",
    actor: { name: "User", harness: "Codex" },
    branch: "main",
    status: "active",
    captureStatus: "healthy",
    updatedAt: "2026-09-07T00:01:00Z"
  },
  thread: { id: "thread-1", label: "Root", captureStatus: "healthy" },
  threadPath: [{ id: "thread-1", label: "Root" }],
  events: [
    event("01", "message", "User", "Please diagnose this"),
    event("02", "thought", "Codex", "Planning diagnosis"),
    event("03", "message", "Codex", "I am checking the logs"),
    event("04", "tool_call", "Codex", "exec · completed", "exec"),
    event("05", "message", "Codex", "The issue is fixed")
  ]
}

const renderReader = (highlightedEventId?: string) => renderToStaticMarkup(
  <SessionReaderView
    state={{ _tag: "Ready", value, refreshing: false } satisfies LoadableView<Conversation>}
    projectName="ATape"
    onBack={() => undefined}
    onOpenThread={() => undefined}
    onRetry={() => undefined}
    onOpenRaw={() => undefined}
    {...(highlightedEventId === undefined ? {} : { highlightedEventId })}
  />
)

describe("SessionReaderView", () => {
  it("renders the user prompt and final agent response as the turn's primary content", () => {
    const html = renderReader()

    expect(html).toContain("turn-message-user")
    expect(html).toContain("Please diagnose this")
    expect(html).toContain("turn-message-agent")
    expect(html).toContain("The issue is fixed")
    expect(html.indexOf("Please diagnose this")).toBeLessThan(html.indexOf("The issue is fixed"))
  })

  it("keeps thoughts, intermediate messages, and tools inside collapsed process details", () => {
    const html = renderReader()
    const process = html.match(/<details class="turn-process"[^>]*>/)?.[0]

    expect(process).toBe('<details class="turn-process">')
    expect(html).toContain("1 update · 1 thought · 1 tool event")
    expect(html).toContain("Planning diagnosis")
    expect(html).toContain('<details class="process-tool">')
    expect(html).not.toContain("event event-thought")
  })

  it("opens the process and nested tool when a search result targets that event", () => {
    const html = renderReader("04")

    expect(html).toContain('<details class="turn-process" open="">')
    expect(html).toContain('<details class="process-tool" open="">')
    expect(html).toContain('id="event-04"')
    expect(html).toContain("event-highlighted")
  })
})
