import type { Conversation } from "@atape/domain"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { SessionReaderView } from "./SessionReaderView.tsx"

it("renders shared tool values as escaped, collapsed details while preserving empty and null values", () => {
  const conversation: Conversation = {
    session: { id: "s", projectId: "p", title: "Tool details", actor: { name: "User", harness: "Any harness" }, branch: "", status: "active", captureStatus: "partial", updatedAt: "2026-09-07T00:00:00Z" },
    thread: { id: "root", label: "Main", captureStatus: "partial" }, threadPath: [],
    events: [
      { id: "call", kind: "tool_call", author: "Any harness", occurredAt: "2026-09-07T00:00:00Z", text: "Read · pending", tool: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read", rawInput: null } },
      { id: "result", kind: "tool_result", author: "Any harness", occurredAt: "2026-09-07T00:00:00Z", text: "Read · completed", tool: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", rawOutput: "<script>alert(1)</script>" } },
      { id: "empty", kind: "tool_result", author: "Any harness", occurredAt: "2026-09-07T00:00:00Z", text: "Read · completed", tool: { sessionUpdate: "tool_call_update", toolCallId: "tool-2", rawOutput: "" } },
      { id: "legacy", kind: "message", author: "User", occurredAt: "2026-09-07T00:00:00Z", text: "Legacy message" }
    ]
  }
  const html = renderToStaticMarkup(<SessionReaderView state={{ _tag: "Ready", value: conversation, refreshing: false }} refresh={{ cadence: "manual", setCadence: () => undefined }} projectName="Project" onBack={() => {}} onOpenThread={() => {}} onRetry={() => {}} onOpenRaw={() => {}} />)
  expect(html).toContain("<summary>Input</summary><pre>null</pre>")
  expect(html).toContain("<summary>Output</summary><pre></pre>")
  expect(html).toContain("&lt;script&gt;")
  expect(html).not.toContain("<script>")
  expect(html).not.toContain("<details open")
  expect(html).toContain("Legacy message")
})
