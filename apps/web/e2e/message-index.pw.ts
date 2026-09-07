import { expect, test as base } from "@playwright/test"

const test = base.extend<{ scenario: { count?: number; paragraphs?: number; image?: boolean; append?: boolean } }>({
  scenario: [{}, { option: true }]
})

const path = "/teams/team-id/projects/project-1/sessions/session-reader?thread=root"

test.beforeEach(async ({ context, page, request, scenario }) => {
  await request.post("http://127.0.0.1:8080/__fixture/reset")
  await context.addCookies([{ name: "fixture_session", value: "1", url: "http://127.0.0.1:4187" }])
  let reads = 0
  await page.route("**/api/v1/sessions/session-reader?*", async (route) => {
    const response = await route.fetch()
    const data = await response.json()
    const child = new URL(route.request().url()).searchParams.get("thread") === "child"
    reads++
    data.thread = { id: child ? "child" : "root", label: child ? "Child" : "Root", captureStatus: "healthy" }
    data.threadPath = child ? [{ id: "root", label: "Root" }, { id: "child", label: "Child" }] : [{ id: "root", label: "Root" }]
    data.events = Array.from({ length: child ? 2 : (scenario.append && reads > 1 ? 2 : scenario.count ?? 12) }, (_, i) => [
      { id: `${child ? "child" : "prompt"}-${i}`, kind: "message", author: "User", occurredAt: "2026-09-05T00:00:01Z", text: `**继续**\n[检查结果](https://example.com) ${i + 1}` },
      { id: `response-${i}`, kind: "message", author: "Codex", occurredAt: "2026-09-05T00:00:02Z", text: (scenario.image && i === 0 ? "![Delayed diagram](/delayed-diagram.svg)\n\n" : "") + "A long response paragraph.\n\n".repeat(scenario.paragraphs ?? (i === 0 && reads > 1 ? 60 : 40)),
        ...(!child && i === 0 ? { childThread: { id: "child", label: "Child", summary: "Independent verification", captureStatus: "healthy", eventCount: 4 } } : {}) }
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
  const documentIdentity = await page.evaluate(() => performance.timeOrigin)
  await page.getByRole("button", { name: /Follow thread/ }).click()
  await expect(page).toHaveURL(/thread=child/)
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentIdentity)
  await expect(rail.locator("button")).toHaveCount(2)
  await expect(page.locator("#event-child-0")).toBeAttached()
  await page.getByRole("navigation", { name: "Thread path" }).getByRole("button", { name: "Root", exact: true }).click()
  await expect(rail.locator("button")).toHaveCount(12)
  await expect(page.locator("#event-child-0")).toHaveCount(0)
})

for (const width of [390, 640, 641, 800, 1023, 1024, 1440]) {
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


test.describe("delayed layout", () => {
  test.use({ scenario: { image: true } })

  test("keeps the visible paragraph when an earlier image in the same exchange loads", async ({ page }) => {
    let releaseImage!: () => void
    const imageReady = new Promise<void>((resolve) => { releaseImage = resolve })
    await page.route("**/delayed-diagram.svg", async (route) => {
      await imageReady
      await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="600"><rect width="480" height="600" fill="gold"/></svg>' })
    })
    await page.goto(path, { waitUntil: "domcontentloaded" })
    const paragraph = page.locator("#event-response-0 .narrative-markdown > p").nth(15)
    await paragraph.evaluate((el) => el.scrollIntoView({ block: "center" }))
    await expect(page.locator('.message-index-rail [aria-current="location"]')).toHaveAttribute("aria-label", /^1\./)
    // Allow a rendering frame to capture the explicit reading position.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const before = await paragraph.evaluate((el) => el.getBoundingClientRect().top)
    releaseImage()
    await expect.poll(() => page.locator("#event-response-0 img").evaluate((el: HTMLImageElement) => el.naturalHeight)).toBe(600)
    await expect.poll(async () => Math.abs(await paragraph.evaluate((el) => el.getBoundingClientRect().top) - before)).toBeLessThanOrEqual(1)
    await expect(page.locator('.message-index-rail [aria-current="location"]')).toHaveAttribute("aria-label", /^1\./)
    // Subsequent manual scrolling must establish a new anchor normally.
    const scrollBefore = await page.evaluate(() => scrollY)
    await page.mouse.wheel(0, 350)
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(scrollBefore + 300)
  })
})

test.describe("large index", () => {
  test.use({ scenario: { count: 240, paragraphs: 2 } })

  test("shows three-digit numbers and keeps keyboard-selected rows visible in both viewports", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(path)
    const rail = page.locator(".message-index-rail")
    await expect(rail.locator("button")).toHaveCount(240)
    await rail.locator("button").first().focus()
    await page.keyboard.press("End")
    await expect(rail.locator("button").last()).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(page.locator("#event-prompt-239")).toBeFocused()
    const number = page.locator(".message-index-current-number")
    await expect(number).toHaveText("240")
    await expect(number).toBeVisible()
    const numberFits = await number.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight && el.scrollWidth <= el.clientWidth
    })
    expect(numberFits).toBe(true)
    await rail.hover()
    const selected = page.locator('.message-index-list [aria-current="location"]')
    await expect(selected).toHaveAttribute("aria-label", /^240\./)
    expect(await selected.evaluate((el) => {
      const row = el.getBoundingClientRect(), parent = el.parentElement!.getBoundingClientRect()
      return row.top >= parent.top && row.bottom <= parent.bottom
    })).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
    await page.setViewportSize({ width: 1024, height: 400 })
    await rail.hover()
    await expect(page.locator(".message-index-panel")).toBeVisible()
    await expect.poll(() => selected.evaluate((el) => {
      const row = el.getBoundingClientRect(), parent = el.parentElement!.getBoundingClientRect()
      return row.top >= parent.top && row.bottom <= parent.bottom
    })).toBe(true)
    await expect(number).toBeVisible()
    await expect.poll(() => number.evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight)).toBe(true)
  })
})


for (const count of [0, 1]) {
  test.describe(`initially ${count} user messages`, () => {
    test.use({ scenario: { count, append: true } })
    test("introduces the index on refresh without an automatic jump", async ({ page }) => {
      await page.goto(path)
      await expect(page.getByRole("heading", { name: "Conversation hierarchy" })).toBeVisible()
      await expect(page.getByRole("navigation", { name: "User messages", exact: true })).toHaveCount(0)
      const before = await page.evaluate(() => scrollY)
      await page.getByRole("button", { name: "Refresh", exact: true }).evaluate((el: HTMLButtonElement) => el.click())
      await expect(page.locator(".message-index-rail button")).toHaveCount(2)
      expect(await page.evaluate(() => scrollY)).toBe(before)
    })
  })
}
