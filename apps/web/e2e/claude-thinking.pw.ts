import { readFile } from "node:fs/promises"
import { expect, test } from "@playwright/test"

const provenance = JSON.parse(await readFile(new URL("../../../adapters/claude/fixtures/native-thinking-2.1.263/provenance.json", import.meta.url), "utf8")) as {
  agentId: string
  thoughts: Array<{ source: string; uuid: string; block: number; body: string; signature: string }>
}
const rootPath = "/teams/team-id/projects/project-1/sessions/session-reader?thread=root"

test.beforeEach(async ({ context, page, request }) => {
  await request.post("http://127.0.0.1:8080/__fixture/reset")
  await context.addCookies([{ name: "fixture_session", value: "1", url: "http://127.0.0.1:4187" }])
  // Canonical HTTP fixture: real Adapter/Collector/Server delivery is checked
  // separately by the installed Claude contract, without browser route mocks.
  await page.route("**/api/v1/sessions/session-reader?*", async route => {
    const response = await route.fetch(), data = await response.json()
    const id = new URL(route.request().url()).searchParams.get("thread") ?? "root"
    const child = id !== "root"
    data.session.actor.harness = "Claude Code"
    data.thread = { id, label: child ? "Foreground child" : "Root", captureStatus: "partial" }
    data.threadPath = child ? [{ id: "root", label: "Root" }, data.thread] : [data.thread]
    data.events = [
      { id: "prompt", kind: "message", author: "User", occurredAt: "2026-10-09T00:00:00Z", text: "Read the controlled fixture" },
      ...provenance.thoughts.filter(thought => thought.source.includes("/subagents/") === child).map(thought => ({
        id: `${thought.uuid}:${thought.block}`, kind: "thought", author: "Claude Code", occurredAt: "2026-10-09T00:00:01Z", text: thought.body
      })),
      { id: "read", kind: "tool_call", author: "Claude Code", occurredAt: "2026-10-09T00:00:02Z", text: "Read · completed", toolLabel: "Read" },
      { id: "reply", kind: "message", author: "Claude Code", occurredAt: "2026-10-09T00:00:03Z", text: "Controlled fixture reviewed." }
    ]
    await route.fulfill({ json: data })
  })
})

for (const width of [390, 1440]) {
  test(`opens Claude thoughts from collapsed Activity with keyboard at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(rootPath)
    const activity = page.locator(".narrative-activity")
    await expect(activity).not.toHaveAttribute("open")
    await expect(activity.locator("summary")).toContainText("2 thoughts")
    const thought = provenance.thoughts.find(thought => !thought.source.includes("/subagents/"))!
    await expect(activity.getByText(thought.body, { exact: true })).toBeHidden()
    await activity.locator("summary").focus()
    await page.keyboard.press("Enter")
    await expect(activity.getByText(thought.body, { exact: true })).toBeVisible()
    await expect(page.getByText("Controlled fixture reviewed.", { exact: true })).toBeVisible()
    await expect(page.getByText(thought.signature, { exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
    await page.goto(`${rootPath}&event=${encodeURIComponent(`${thought.uuid}:${thought.block}`)}`)
    await expect(page.locator(`[id="event-${thought.uuid}:${thought.block}"]`)).toBeFocused()
    await expect(page.locator(".narrative-activity")).toHaveAttribute("open", "")
  })

  test(`opens the exact foreground child thought at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const thought = provenance.thoughts.find(thought => thought.source.includes("/subagents/"))!
    await page.goto(`${rootPath.replace("thread=root", `thread=claude-agent:${provenance.agentId}`)}&event=${encodeURIComponent(`${thought.uuid}:${thought.block}`)}`)
    const event = page.locator(`[id="event-${thought.uuid}:${thought.block}"]`)
    await expect(event).toBeFocused()
    await expect(event).toContainText(thought.body)
    await expect(page.locator(".narrative-activity")).toHaveAttribute("open", "")
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
  })
}
