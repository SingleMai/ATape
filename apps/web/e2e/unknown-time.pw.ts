import { expect, test, type Page } from "@playwright/test"

const projectPath = "/teams/team-id/projects/project-1"

const unknownReader = async (page: Page) => {
  await page.route("**/api/v1/sessions/session-reader?*", async route => {
    const response = await route.fetch(), data = await response.json()
    data.session.updatedAt = null
    data.events = data.events.map((event: { id: string }) => ({
      ...event,
      // A known response between unknown prompts must not reorder the narrative.
      occurredAt: event.id === "event-05" ? "2026-10-10T23:00:00Z" : null
    }))
    await route.fulfill({ response, json: data })
  })
}

test.beforeEach(async ({ context, request, page }) => {
  await request.post("http://127.0.0.1:8080/__fixture/reset")
  await context.addCookies([{ name: "fixture_session", value: "1", url: "http://127.0.0.1:4187" }])
  await page.emulateMedia({ reducedMotion: "reduce" })
  await unknownReader(page)
})

test("keeps unknown conversation and prompt times usable without replacing them with capture time", async ({ page }) => {
  await page.route("**/api/v1/projects/project-1/memory", async route => {
    const response = await route.fetch(), data = await response.json()
    const session = data.active[0]
    const unknownFirst = { ...session, updatedAt: null }
    data.active = [unknownFirst, { ...session, id: "older", title: "Older known time", updatedAt: "2026-09-01T00:00:00Z" }]
    data.trail = [unknownFirst, { ...session, id: "unknown-second", title: "Second unknown time", updatedAt: null },
      { ...session, id: "newer", title: "Newer known time", updatedAt: "2026-09-02T00:00:00Z" }]
    await route.fulfill({ response, json: data })
  })
  await page.goto(projectPath)
  await expect(page.locator(".trail-item strong")).toHaveText([
    "Newer known time", "Older known time", "Conversation hierarchy", "Second unknown time"
  ])
  const unknownSession = page.locator(".trail-item").filter({ hasText: "Conversation hierarchy" })
  await expect(unknownSession.locator(".conversation-time")).toHaveText("Time unknown")
  await expect(unknownSession.locator("time")).toHaveCount(0)
  await unknownSession.click()
  await expect(page.getByRole("heading", { name: "Conversation hierarchy" })).toBeVisible()
  await expect(page.locator(".narrative-prompt")).toHaveText([
    /Please diagnose the startup failure.*Time unknown/s,
    /Can you verify it\?.*Time unknown/s
  ])
  await expect(page.locator("#event-event-01 .message-metadata time")).toHaveCount(0)
  await expect(page.locator("#event-event-05 time")).toHaveAttribute("datetime", "2026-10-10T23:00:00Z")
  await page.getByLabel("Conversation details and actions").click()
  await expect(page.locator(".quiet-disclosure-panel .conversation-time")).toHaveText("Time unknown")
  await page.getByLabel("Conversation details and actions").click()
  const rail = page.locator(".message-index-rail")
  await expect(rail.locator("button")).toHaveCount(2)
  await expect(rail.locator("button").first()).toHaveAttribute("aria-label", /^1\. Time unknown/)
  await expect(rail.locator("button").last()).toHaveAttribute("aria-label", /^2\. Time unknown/)
  await rail.hover()
  await expect(page.locator(".message-index-list .conversation-time")).toHaveText(["Time unknown", "Time unknown"])
  await page.locator(".message-index-list button").nth(1).click()
  await expect(page.locator("#event-event-06")).toBeFocused()
  await expect(page.locator('time[datetime="1970-01-01T00:00:00.000Z"]')).toHaveCount(0)
})

test("preserves unknown-time search result order and exact event navigation", async ({ page }) => {
  await page.route("**/api/v1/projects/project-1/search?*", async route => {
    const response = await route.fetch(), data = await response.json()
    const result = data.results[0]
    data.results = [
      { ...result, eventId: "event-05", sessionTitle: "Known result", occurredAt: "2026-10-10T23:00:00Z" },
      { ...result, sessionTitle: "First unknown result", occurredAt: null },
      { ...result, eventId: "event-06", sessionTitle: "Second unknown result", occurredAt: null }
    ]
    await route.fulfill({ response, json: data })
  })
  await page.goto(projectPath)
  await page.getByRole("button", { name: "Search all conversations" }).click()
  const dialog = page.getByRole("dialog", { name: "Search everything" })
  await dialog.getByRole("searchbox", { name: "Search conversations" }).fill("startup")
  await expect(dialog.locator(".global-result strong")).toHaveText([
    "Known result", "First unknown result", "Second unknown result"
  ])
  await expect(dialog.locator(".global-result").nth(1).locator(".conversation-time")).toHaveText("Time unknown")
  await expect(dialog.locator(".global-result").nth(1).locator("time")).toHaveCount(0)
  await dialog.locator(".global-result").nth(1).focus()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/sessions\/session-reader.*event=event-01/)
  await expect(page.locator("#event-event-01")).toBeFocused()
  await expect(page.locator("#event-event-01 .conversation-time")).toHaveText("Time unknown")
})

test("discloses unknown activity times in Overview and Session pages while keeping refresh time separate", async ({ page }) => {
  await page.route("**/api/v1/teams/team-id/overview**", async route => {
    const response = await route.fetch(), data = await response.json()
    data.sessions[0].updatedAt = null
    data.sessions[1].updatedAt = null
    data.unknownTimeSessions = 2
    await route.fulfill({ response, json: data })
  })
  await page.goto("/teams/team-id")
  const first = page.locator(".overview-session").first()
  await expect(first.getByRole("button")).toHaveText("Conversation hierarchy")
  await expect(first.locator(".conversation-time")).toHaveText("Time unknown")
  await expect(first.locator("time")).toHaveCount(0)
  await expect(page.locator(".overview-coverage")).toContainText("2 sessions contain unknown activity times.")
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toHaveAttribute("title", /^Updated (?!.*unknown)/)
  await page.getByRole("button", { name: "Open sessions", exact: true }).click()
  await expect(first.locator(".conversation-time")).toHaveText("Time unknown")
  await expect(page.locator(".overview-session").nth(1).locator(".conversation-time")).toHaveText("Time unknown")
  await first.getByRole("button").click()
  await expect(page).toHaveURL(/sessions\/session-reader/)
  await expect(page.getByRole("heading", { name: "Conversation hierarchy" })).toBeVisible()
})
