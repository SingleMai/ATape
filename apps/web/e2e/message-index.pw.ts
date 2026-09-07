import { expect, test } from "@playwright/test"

const path = "/teams/team-id/projects/project-1/sessions/session-reader?thread=root"

test.beforeEach(async ({ context, page, request }) => {
  await request.post("http://127.0.0.1:8080/__fixture/reset")
  await context.addCookies([{ name: "fixture_session", value: "1", url: "http://127.0.0.1:4187" }])
  let reads = 0
  await page.route("**/api/v1/sessions/session-reader?*", async (route) => {
    const response = await route.fetch()
    const data = await response.json()
    const child = new URL(route.request().url()).searchParams.get("thread") === "child"
    reads++
    data.thread = { id: child ? "child" : "root", label: child ? "Child" : "Root", captureStatus: "healthy" }
    data.events = Array.from({ length: child ? 2 : 12 }, (_, i) => [
      { id: `${child ? "child" : "prompt"}-${i}`, kind: "message", author: "User", occurredAt: "2026-09-05T00:00:01Z", text: `**继续**\n[检查结果](https://example.com) ${i + 1}` },
      { id: `response-${i}`, kind: "message", author: "Codex", occurredAt: "2026-09-05T00:00:02Z", text: "A long response paragraph.\n\n".repeat(i === 0 && reads > 1 ? 60 : 40) }
    ]).flat()
    await route.fulfill({ json: data })
  })
})

test("locates Canonical prompts and keeps the reading interval through long responses and refresh", async ({ page }) => {
  await page.goto(path)
  const rail = page.locator(".message-index-rail")
  await expect(rail.locator("button")).toHaveCount(12)
  await rail.locator("button").nth(2).click()
  await expect(page.locator("#event-prompt-2")).toBeFocused()
  const centered = await page.locator("#event-prompt-2").evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return Math.abs(rect.top + rect.height / 2 - innerHeight / 2)
  })
  expect(centered).toBeLessThan(3)
  await page.evaluate(() => scrollBy(0, 850))
  await expect(rail.locator('[aria-current="location"]')).toHaveAttribute("aria-label", /^3\./)
  const before = await page.locator("#event-prompt-2").evaluate((el) => el.getBoundingClientRect().top)
  // Programmatic activation preserves the user's scroll position while exercising
  // the same refresh button and presenter used by pointer/keyboard callers.
  await page.getByRole("button", { name: "Refresh", exact: true }).evaluate((el: HTMLButtonElement) => el.click())
  await expect.poll(async () => (await page.locator("#event-response-0").innerText()).split("A long response paragraph.").length).toBe(61)
  await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled()
  await expect.poll(async () => Math.abs(await page.locator("#event-prompt-2").evaluate((el) => el.getBoundingClientRect().top) - before)).toBeLessThanOrEqual(1)
  await rail.hover()
  await expect(page.locator(".message-index-panel")).toBeVisible()
  await expect(page.locator(".message-index-summary").first()).toHaveText("继续 检查结果 1")
  await rail.locator("button").nth(2).focus()
  await page.keyboard.press("ArrowDown")
  await expect(rail.locator("button").nth(3)).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(page.locator(".message-index-panel")).toBeHidden()
  await page.goto(path.replace("thread=root", "thread=child"))
  await expect(rail.locator("button")).toHaveCount(2)
  await expect(page.locator("#event-child-0")).toBeAttached()
})

for (const width of [390, 800, 1440]) {
  test(`index remains usable at ${width}px with reduced motion`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(path)
    if (width <= 640) {
      await expect(page.locator(".message-index-rail")).toBeHidden()
      await page.getByRole("button", { name: "User messages: 1 of 12" }).click()
    } else await page.locator(".message-index-rail").hover()
    const panel = page.locator(".message-index-panel")
    await expect(panel).toBeVisible()
    await panel.locator(".message-index-list button").nth(10).click()
    await expect(page.locator("#event-prompt-10")).toBeFocused()
    await expect(panel).toBeHidden()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
    if (width <= 640) {
      await page.getByRole("button", { name: "User messages: 11 of 12" }).click()
      await expect(panel).toBeVisible()
      const visible = await panel.locator('[aria-current="location"]').evaluate((el) => {
        const row = el.getBoundingClientRect(), list = el.parentElement!.getBoundingClientRect()
        return row.top >= list.top && row.bottom <= list.bottom
      })
      expect(visible).toBe(true)
      await page.getByRole("button", { name: "Close user messages" }).click()
      await expect(page.getByRole("button", { name: "User messages: 11 of 12" })).toBeFocused()
    }
  })
}
