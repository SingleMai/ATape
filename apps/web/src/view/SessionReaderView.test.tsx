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

const conversation = (events: ReadonlyArray<CanonicalEvent>): Conversation => ({
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
  events: [...events]
})

const value = conversation([
  event("01", "message", "User", "Please diagnose this"),
  event("02", "thought", "Codex", "Planning diagnosis"),
  event("03", "message", "Codex", "I am checking the logs"),
  event("04", "tool_call", "Codex", "exec · completed", "exec"),
  event("05", "message", "Codex", "**The issue is fixed.**")
])

const renderReader = (options: {
  readonly value?: Conversation
  readonly highlightedEventId?: string
} = {}) => renderToStaticMarkup(
  <SessionReaderView
    state={{
      _tag: "Ready",
      value: options.value ?? value,
      refreshing: false
    } satisfies LoadableView<Conversation>}
    refresh={{ cadence: "manual", setCadence: () => undefined }}
    projectName="ATape"
    onBack={() => undefined}
    onOpenThread={() => undefined}
    onRetry={() => undefined}
    onOpenRaw={() => undefined}
    {...(options.highlightedEventId === undefined ? {} : { highlightedEventId: options.highlightedEventId })}
  />
)

describe("SessionReaderView", () => {
  it("shows a Canonical prompt index only for two or more user messages", () => {
    expect(renderReader()).not.toContain('aria-label="User messages"')
    const html = renderReader({ value: conversation([
      ...value.events,
      event("06", "message", "User", "**继续**\n[检查](https://example.com)")
    ]) })
    expect(html).toContain('aria-label="User messages"')
    expect(html).toContain('id="event-06"')
    expect(html).toContain('class="message-index-summary">继续 检查</span>')
    expect(html).toContain('<strong>继续</strong>')
    expect(html).toContain('href="https://example.com"')
    expect(html.match(/class="message-index-number"/g)).toHaveLength(2)
  })

  it.each([
    ["# Heading\n\n- First\n- Second", "Heading First Second"],
    ["[**nested** label](https://example.com/a_(b))", "nested label"],
    ["[Reference][guide]\n\n[guide]: https://example.com \"Title\"", "Reference"],
    ["![Screenshot][image]\n\n[image]: https://example.com/image.png", "Screenshot"],
    ["`file_name.ts` and **bold** and plain_file.ts", "file_name.ts and bold and plain_file.ts"],
    ["~~~ts\nconst some_value = a * b;\n~~~", "const some_value = a * b;"],
    ["Use \\*literal\\* &amp; &#60;tag&#62;", "Use *literal* &amp; &lt;tag&gt;"],
    ["First  \nsecond\n\n> Third", "First second Third"]
  ])("condenses Markdown summaries without losing literal content: %s", (markdown, expected) => {
    const html = renderReader({ value: conversation([
      ...value.events, event("06", "message", "User", markdown)
    ]) })
    expect(html).toContain(`class="message-index-summary">${expected}</span>`)
  })

  it("renders a compact header, user prompt, and primary agent response", () => {
    const html = renderReader()

    expect(html).toContain("session-reader-header")
    expect(html).toContain("Automatic refresh interval")
    expect(html).toContain('<option value="manual" selected="">Off</option>')
    expect(html).toContain("narrative-prompt")
    expect(html).toContain("Please diagnose this")
    expect(html).toContain("narrative-response")
    expect(html).toContain("<strong>The issue is fixed.</strong>")
    expect(html.indexOf("Please diagnose this")).toBeLessThan(html.indexOf("The issue is fixed"))
  })

  it("uses one collapsed Activity disclosure for thoughts, updates, and tools", () => {
    const html = renderReader()
    const activity = html.match(/<details class="narrative-activity"[^>]*>/)?.[0]

    expect(activity).toBe('<details class="narrative-activity">')
    expect(html).toContain("1 update · 1 thought · 1 tool event")
    expect(html).toContain("Planning diagnosis")
    expect(html.match(/<details/g)).toHaveLength(1)
    expect(html).not.toContain("process-tool")
  })

  it("opens Activity when a search result targets a folded event", () => {
    const html = renderReader({ highlightedEventId: "04" })

    expect(html).toContain('<details class="narrative-activity" open="">')
    expect(html).toContain('id="event-04"')
    expect(html).toContain("event-highlighted")
  })

  it("keeps incomplete Activity open so a capture never looks blank", () => {
    const incomplete = conversation([value.events[0]!, value.events[1]!, value.events[3]!])
    const html = renderReader({ value: incomplete })

    expect(html).toContain('<details class="narrative-activity" open="">')
    expect(html).not.toContain("narrative-response")
  })

  it("shows artifacts, notices, and unclassified messages outside Activity", () => {
    const ambiguous = conversation([
      event("01", "message", "User", "Review the result"),
      event("02", "artifact", "Codex", "[Open report](/report.md)"),
      event("03", "notice", "System", "Capture is partial"),
      event("04", "message", "Reviewer", "Independent review"),
      event("05", "message", "Codex", "Review complete")
    ])
    const html = renderReader({ value: ambiguous })

    expect(html).toContain("narrative-highlight-artifact")
    expect(html).toContain("narrative-highlight-notice")
    expect(html).toContain("narrative-highlight-message")
    expect(html).toContain("Unclassified message")
    expect(html).not.toContain("narrative-activity")
  })
})
