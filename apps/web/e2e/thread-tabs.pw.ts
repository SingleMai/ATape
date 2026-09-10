import { expect, test } from "@playwright/test"

const path = "/teams/team-id/projects/project-1/sessions/session-reader?thread=root"
test.beforeEach(async ({ context, page, request }) => {
  await request.post("http://127.0.0.1:8080/__fixture/reset")
  await context.addCookies([{ name: "fixture_session", value: "1", url: "http://127.0.0.1:4187" }])
  await page.route("**/api/v1/sessions/session-reader?*", async route => {
    const response = await route.fetch()
    if (!response.ok()) { await route.fulfill({ response }); return }
    const data = await response.json()
    const id = new URL(route.request().url()).searchParams.get("thread") ?? "root"
    const label = id === "root" ? "Root" : id === "alpha" ? "Alpha" : "Beta"
    data.thread = { id, label, captureStatus: "healthy" }
    data.threadPath = id === "root" ? [{ id, label }] : [{ id: "root", label: "Root" }, { id, label }]
    // Deliberately reuse event IDs across threads: DOM positioning must be local.
    data.events = [
      { id: "prompt", kind: "message", author: "User", occurredAt: "2026-09-05T00:00:01Z", text: `Review ${label}` },
      ...["alpha", "beta"].filter(child => child !== id).map(child => ({
        id: `spawn-${child}`, kind: "spawn", author: "Codex", occurredAt: "2026-09-05T00:00:02Z", text: `Delegate ${child}`,
        childThread: { id: child, label: child === "alpha" ? "Alpha" : "Beta", summary: "Independent review", captureStatus: "healthy", eventCount: 4 }
      })),
      { id: "response", kind: "message", author: "Codex", occurredAt: "2026-09-05T00:00:03Z", text: `${label} findings.\n\n`.repeat(60) },
      { id: "followup", kind: "message", author: "User", occurredAt: "2026-09-05T00:00:04Z", text: "Continue the review" }
    ]
    await route.fulfill({ json: data })
  })
})

test("keeps main reading position, multiple child tabs, nested navigation and keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(path)
  const main = page.locator(".session-main-reader")
  const alpha = main.getByRole("button", { name: /Alpha · child thread/ })
  await alpha.scrollIntoViewIfNeeded()
  const before = await alpha.evaluate(el => el.getBoundingClientRect().top)
  const identity = await page.evaluate(() => performance.timeOrigin)
  await alpha.click()
  const panel = page.getByRole("tabpanel")
  await expect(panel.getByRole("heading", { name: "Alpha", exact: true })).toBeVisible()
  await expect(page).toHaveURL(path)
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(identity)
  await expect.poll(async () => Math.abs(await alpha.evaluate(el => el.getBoundingClientRect().top) - before)).toBeLessThanOrEqual(1)
  await alpha.click()
  await expect(page.getByRole("tab")).toHaveCount(1)
  await panel.getByRole("button", { name: /Beta · child thread/ }).click()
  await expect(page.getByRole("tab")).toHaveCount(2)
  await expect(panel.getByRole("heading", { name: "Beta", exact: true })).toBeVisible()
  await page.getByRole("tab", { name: "Alpha", exact: true }).click()
  await panel.evaluate(el => { el.scrollTop = 500 })
  await expect.poll(() => panel.evaluate(el => el.scrollTop)).toBe(500)
  await page.getByRole("tab", { name: "Beta", exact: true }).click()
  await panel.evaluate(el => { el.scrollTop = 250 })
  await page.getByRole("tab", { name: "Alpha", exact: true }).click()
  await expect.poll(() => panel.evaluate(el => el.scrollTop)).toBe(500)
  const mainScroll = await page.locator(".session-main-reader").evaluate(el => el.scrollTop)
  await panel.locator(".refresh-now").evaluate((el: HTMLButtonElement) => el.click())
  await expect(panel.locator(".refresh-now")).toBeEnabled()
  expect(await page.locator(".session-main-reader").evaluate(el => el.scrollTop)).toBe(mainScroll)
  await expect.poll(() => panel.evaluate(el => el.scrollTop)).toBe(500)
  const duplicateIds = await page.evaluate(() => {
    const ids = [...document.querySelectorAll("[id]")].map(el => el.id)
    return ids.length - new Set(ids).size
  })
  expect(duplicateIds).toBe(0)
  await page.getByRole("tab", { name: "Alpha", exact: true }).focus()
  await page.keyboard.press("ArrowRight")
  await expect(page.getByRole("tab", { name: "Beta", exact: true })).toBeFocused()
  await expect.poll(() => panel.evaluate(el => el.scrollTop)).toBe(250)
  await page.keyboard.press("Delete")
  await expect(page.getByRole("tab", { name: "Alpha", exact: true })).toBeFocused()
  await page.getByRole("button", { name: "Close side panel" }).click()
  await expect(page.getByRole("tab")).toHaveCount(0)
  await expect(alpha).toBeFocused()
  await expect(page).toHaveURL(path)
})

test("isolates a child load failure and retries in place", async ({ page, request }) => {
  let childReads = 0
  page.on("request", request => {
    const url = new URL(request.url())
    if (url.pathname === "/api/v1/sessions/session-reader" && url.searchParams.get("thread") === "alpha") childReads++
  })
  await page.goto(path)
  await expect(page.locator(".session-main-reader .narrative-prompt").getByText("Review Root", { exact: true })).toBeVisible()
  await request.post("http://127.0.0.1:8080/__fixture/fail-conversation?value=1")
  await page.getByRole("button", { name: /Alpha · child thread/ }).click()
  await expect(page.getByRole("tabpanel").getByRole("alert")).toBeVisible()
  await expect(page.locator(".session-main-reader .narrative-prompt").getByText("Review Root", { exact: true })).toBeVisible()
  await expect(page.locator(".session-reader-workspace")).toHaveAttribute("data-motion", "open")
  await page.requestGC()
  await page.setViewportSize({ width: 800, height: 900 })
  await expect(page.locator(".session-reader-workspace")).toHaveAttribute("data-direction", "vertical")
  await expect(page.getByRole("tabpanel").getByRole("alert")).toBeVisible()
  expect(childReads).toBe(1)
  await request.post("http://127.0.0.1:8080/__fixture/fail-conversation?value=0")
  await page.getByRole("tabpanel").getByRole("button", { name: "Try again" }).click()
  await expect(page.getByRole("tabpanel").getByRole("heading", { name: "Alpha", exact: true })).toBeVisible()
  expect(childReads).toBe(2)
  await expect(page).toHaveURL(path)
})

test("pages each child independently and reloads a replaced publication", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  let head = "alpha-first"
  const reads: URL[] = []
  await page.route("**/api/v1/sessions/session-reader?*", async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get("thread") !== "alpha") { await route.fallback(); return }
    reads.push(url)
    expect(url.searchParams.get("limit")).toBe("100")
    if (url.searchParams.has("head") && url.searchParams.get("head") !== head) {
      await route.fulfill({ status: 409, json: { code: "refresh_required", detail: "Reload the changed conversation." } })
      return
    }
    const response = await route.fetch()
    const data = await response.json()
    data.thread = { id: "alpha", label: "Alpha", captureStatus: "healthy" }
    data.threadPath = [{ id: "root", label: "Root" }, data.thread]
    data.head = head
    data.nextEventId = "alpha-page-end"
    const text = head === "alpha-replaced" ? "Replaced Alpha" : url.searchParams.has("after") ? "Alpha second page" : "Alpha first page"
    data.events = [{ id: text, kind: "message", author: "User", occurredAt: "2026-09-05T00:00:01Z", text }]
    await route.fulfill({ json: data })
  })
  await page.goto(path)
  const main = page.locator(".session-main-reader")
  await main.getByRole("button", { name: /Alpha · child thread/ }).click()
  const panel = page.getByRole("tabpanel")
  await expect(panel.getByText("Alpha first page", { exact: true })).toBeVisible()
  await panel.getByRole("button", { name: "Next page", exact: true }).click()
  await expect(panel.getByText("Alpha second page", { exact: true })).toBeVisible()
  expect(reads.at(-1)!.searchParams.get("head")).toBe("alpha-first")
  expect(reads.at(-1)!.searchParams.get("after")).toBe("alpha-page-end")
  await main.getByRole("button", { name: /Beta · child thread/ }).click()
  await expect(panel.getByRole("heading", { name: "Beta", exact: true })).toBeVisible()
  await page.getByRole("tab", { name: "Alpha", exact: true }).click()
  await expect(panel.getByText("Alpha second page", { exact: true })).toBeVisible()
  await panel.getByRole("button", { name: "Read from the beginning" }).click()
  await expect(panel.getByText("Alpha first page", { exact: true })).toBeVisible()
  head = "alpha-replaced"
  await panel.getByRole("button", { name: "Next page", exact: true }).click()
  await expect(panel.getByRole("heading", { name: "Conversation has changed" })).toBeVisible()
  await panel.getByRole("button", { name: "Reload conversation" }).click()
  await expect(panel.getByText("Replaced Alpha", { exact: true })).toBeVisible()
  expect(reads.at(-1)!.searchParams.has("head")).toBe(false)
  expect(reads.at(-1)!.searchParams.has("after")).toBe(false)
  await expect(main.locator(".narrative-prompt").getByText("Review Root", { exact: true })).toBeVisible()
  await expect(page).toHaveURL(path)
})

for (const width of [390, 800, 1280]) {
  test(`child tabs fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(path)
    await page.getByRole("button", { name: /Alpha · child thread/ }).click()
    await expect(page.getByRole("tabpanel").getByRole("heading", { name: "Alpha", exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
    const bounds = await page.locator(".thread-sidebar").boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    if (width <= 1100) expect(bounds!.y).toBeGreaterThan(300)
    await page.getByRole("button", { name: "Close Alpha tab", exact: true }).click()
    await expect(page.getByRole("tabpanel")).toHaveCount(0)
  })
}

for (const width of [800, 1600]) {
  test(`resizes the split with pointer and keyboard at ${width}px and remembers its size`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto(path)
    const opener = page.locator(".session-main-reader").getByRole("button", { name: /Alpha · child thread/ })
    await opener.click()
    const separator = page.getByRole("separator", { name: "Resize child conversations" })
    await expect(separator).toBeEnabled()
    const sidebar = page.locator(".thread-sidebar")
    const dimension = () => sidebar.evaluate((el, vertical) => vertical ? el.clientHeight : el.clientWidth, width <= 1100)
    const before = await dimension()
    const handle = (await separator.boundingBox())!
    expect(width > 1100 ? handle.width : handle.height).toBeGreaterThanOrEqual(7)
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x + handle.width / 2 - (width > 1100 ? 90 : 0), handle.y + handle.height / 2 - (width <= 1100 ? 90 : 0), { steps: 8 })
    await page.mouse.up()
    await expect.poll(dimension).toBeGreaterThan(before + 60)
    const dragged = await dimension()
    await separator.focus()
    await page.keyboard.press(width > 1100 ? "ArrowLeft" : "ArrowUp")
    await expect.poll(dimension).toBeGreaterThan(dragged)
    const resized = await dimension()
    await page.getByRole("button", { name: "Close side panel" }).click()
    await opener.click()
    await expect.poll(async () => Math.abs(await dimension() - resized)).toBeLessThanOrEqual(1)
    await page.setViewportSize({ width: width > 1100 ? 800 : 1600, height: 1000 })
    await expect(page.getByRole("tabpanel").getByRole("heading", { name: "Alpha", exact: true })).toBeVisible()
    await page.setViewportSize({ width, height: 1000 })
    await expect.poll(async () => Math.abs(await dimension() - resized)).toBeLessThanOrEqual(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
  })
}

test("animates opening, tab selection and closing, including reversing a close", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto(path)
  const split = page.locator(".session-reader-workspace")
  await split.evaluate(el => {
    el.setAttribute("data-observed-motion", "")
    for (const type of ["transitionrun", "animationstart"]) el.addEventListener(type, event => {
      const name = event instanceof TransitionEvent ? event.propertyName : (event as AnimationEvent).animationName
      el.setAttribute("data-observed-motion", `${el.getAttribute("data-observed-motion")} ${name}`)
    })
  })
  const alpha = page.locator(".session-main-reader").getByRole("button", { name: /Alpha · child thread/ })
  await alpha.click()
  await expect(split).toHaveAttribute("data-motion", "open")
  await expect(split).toHaveAttribute("data-observed-motion", /flex-grow/)
  await page.locator(".session-main-reader").getByRole("button", { name: /Beta · child thread/ }).click()
  await expect(page.getByRole("tabpanel").getByRole("heading", { name: "Beta", exact: true })).toBeVisible()
  await expect(split).toHaveAttribute("data-observed-motion", /thread-tab-reveal/)
  const reversing = await page.getByRole("button", { name: "Close side panel" }).evaluate(el => {
    (el as HTMLButtonElement).click()
    return new Promise<number>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
      const animations = document.querySelector(".session-reader-workspace")!.getAnimations({ subtree: true })
      const opener = document.querySelector<HTMLButtonElement>('.session-main-reader [data-event-id="spawn-alpha"] .child-thread')!
      opener.click()
      resolve(animations.length)
    })))
  })
  expect(reversing).toBeGreaterThan(0)
  await expect(split).toHaveAttribute("data-motion", "open")
  await expect(page.getByRole("tab", { name: "Alpha", exact: true })).toHaveAttribute("aria-selected", "true")
  await page.getByRole("button", { name: "Close side panel" }).click()
  await expect(split).toHaveAttribute("data-motion", "closed")
  await expect(page.getByRole("tab", { includeHidden: true })).toHaveCount(0)
})

test("reduced motion skips transitions and keeps narrow-screen message positioning inside the main panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(path)
  await page.getByRole("button", { name: /Alpha · child thread/ }).click()
  const split = page.locator(".session-reader-workspace")
  await expect(split).toHaveAttribute("data-motion", "open")
  expect(await split.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0)
  await page.getByRole("button", { name: /User messages:/ }).click()
  await page.locator(".message-index-list button").first().click()
  await expect(page.locator("#event-prompt")).toBeFocused()
  expect(await page.locator("#event-prompt").evaluate(el => {
    const rect = el.getBoundingClientRect(), viewport = el.closest(".session-main-reader")!.getBoundingClientRect()
    return rect.top >= viewport.top && rect.bottom <= viewport.bottom
  })).toBe(true)
  await page.getByRole("button", { name: "Close side panel" }).click()
  await expect(split).toHaveAttribute("data-motion", "closed")
})
