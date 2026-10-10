import type { ProjectMemory, SessionSummary } from "@atape/domain"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ProjectMemoryView } from "./ProjectMemoryView"

const session = (id: string, updatedAt: string | null): SessionSummary => ({
  id,
  title: id,
  summary: "Captured conversation",
  insight: "",
  actor: { name: "User", harness: "Codex" },
  branch: "main",
  status: "idle",
  updatedAt,
  eventCount: 2,
  childThreadCount: 0
})

describe("ProjectMemoryView", () => {
  it("puts known conversation times first and preserves the supplied order of unknown times", () => {
    const unknownFirst = session("unknown-first", null)
    const memory: ProjectMemory = {
      project: { id: "project-1", teamId: "team-1", name: "ATape", type: "git" },
      capturedThrough: "2026-10-10T10:00:00Z",
      active: [unknownFirst, session("known-older", "2026-09-01T00:00:00Z")],
      trail: [unknownFirst, session("unknown-second", null), session("known-newer", "2026-09-02T00:00:00Z")]
    }
    const html = renderToStaticMarkup(<ProjectMemoryView
      state={{ _tag: "Ready", value: memory, refreshing: false }}
      refresh={{ cadence: "manual", setCadence: () => undefined }}
      onOpenSession={() => undefined}
      onRetry={() => undefined}
    />)
    const titles = [...html.matchAll(/<strong>([^<]+)<\/strong>/g)].map((match) => match[1])
    expect(titles).toEqual(["known-newer", "known-older", "unknown-first", "unknown-second"])
    expect(html.match(/<span class="conversation-time">Time unknown<\/span>/g)).toHaveLength(2)
    expect(html).toContain(`dateTime="${memory.capturedThrough}"`)
    expect(html).not.toContain("1970")
  })
})
