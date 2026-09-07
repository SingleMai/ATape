import { expect, test } from "@playwright/test"

const projectPath = "/teams/team-id/projects/project-1"

test.beforeEach(async ({ page, context, request }) => {
  await request.post("http://127.0.0.1:8080/__fixture/reset")
  await context.addCookies([{ name: "fixture_session", value: "1", url: "http://127.0.0.1:4187" }])
  await page.route("**/api/v1/workspace", async (route) => {
    const response = await route.fetch(),
      data = await response.json()
    data.projects.push({ ...data.projects[0], id: "project-2", name: "Docs" })
    await route.fulfill({ json: data })
  })
  await page.route("**/api/v1/projects/*/search?*", async (route) => {
    const url = new URL(route.request().url()),
      projectId = url.pathname.split("/")[4]
    const query = url.searchParams.get("q"),
      next = url.searchParams.get("cursor")
    await route.fulfill({
      json: {
        projectId,
        query,
        results:
          query === "missing"
            ? []
            : Array.from({ length: next ? 1 : 12 }, (_, index) => ({
                eventId: next ? "event-08" : index === 0 ? "event-04" : "event-05",
                sessionId: "session-reader",
                sessionTitle: `${projectId === "project-1" ? "ATape" : "Docs"} startup ${index + 1}`,
                threadId: "root",
                threadPath: [{ id: "root", label: "Root" }],
                author: "User",
                harness: "Codex",
                occurredAt: "2026-09-05T00:00:04Z",
                text: `Investigating ${query}: captured tool activity and its surrounding conversation.`
              })).map((result, index) => ({
                ...result,
                eventId: index === 0 ? result.eventId : `fixture-${index}`
              })),
        ...(!next && query !== "missing" && projectId === "project-2" ? { nextCursor: "next-docs" } : {})
      }
    })
  })
})

test("searches across projects and retains filters, result scroll, and exact-message navigation", async ({
  page
}) => {
  await page.goto(projectPath)
  await expect(page.getByRole("heading", { name: "Conversations", exact: true })).toBeVisible()
  await expect(page.locator(".trail-item")).toHaveCount(1)
  await page.getByRole("button", { name: "Search all conversations" }).click()
  const dialog = page.getByRole("dialog", { name: "Search everything" })
  await expect(dialog).toBeVisible()
  const input = dialog.getByRole("searchbox", { name: "Search conversations" })
  await expect(input).toBeFocused()
  await input.fill("startup")
  await expect(dialog.getByText("24 matches on this page · Grouped by project")).toBeVisible()
  await dialog.locator(".global-search-results").evaluate((el) => {
    el.scrollTop = 450
  })
  const scroll = await dialog.locator(".global-search-results").evaluate((el) => el.scrollTop)
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("button", { name: "Search all conversations" })).toBeFocused()
  await page.keyboard.press("ControlOrMeta+k")
  await expect(input).toHaveValue("startup")
  expect(await dialog.locator(".global-search-results").evaluate((el) => el.scrollTop)).toBe(scroll)
  await dialog.getByRole("button", { name: "Filters +", exact: true }).click()
  await dialog.getByLabel("Project", { exact: true }).selectOption("project-1")
  await expect(dialog.locator(".global-result")).toHaveCount(12)
  await input.focus()
  await page.keyboard.press("ArrowDown")
  await expect(dialog.locator(".global-result").first()).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/sessions\/session-reader.*event=event-04/)
  await expect(page.locator("#event-event-04")).toBeFocused()
  await expect(page.locator(".narrative-activity").first()).toHaveAttribute("open", "")
  await expect(page.getByRole("button", { name: "View Raw source" })).toBeHidden()
  await page.keyboard.press("ControlOrMeta+k")
  await expect(dialog.getByRole("button", { name: "Remove project filter" })).toHaveText("ATape ×")
  await expect(input).toHaveValue("startup")
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Back to conversations", exact: true }).click()
  await page.getByRole("button", { name: "Team options for Team A" }).click()
  await page.getByRole("link", { name: "Team settings" }).click()
  await page.keyboard.press("ControlOrMeta+k")
  await expect(input).toHaveValue("startup")
  await expect(dialog.getByRole("button", { name: "Remove project filter" })).toBeVisible()
})

test("continues only remaining projects and offers recovery from empty results", async ({ page }) => {
  const requests: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("/search?")) requests.push(request.url())
  })
  await page.goto(projectPath)
  await expect(page.getByRole("heading", { name: "Conversations", exact: true })).toBeVisible()
  await page.keyboard.press("ControlOrMeta+k")
  const dialog = page.getByRole("dialog"),
    input = dialog.getByRole("searchbox", { name: "Search conversations" })
  await input.fill("startup")
  await expect(dialog.locator(".global-result")).toHaveCount(24)
  await dialog.getByRole("button", { name: "Next", exact: true }).click()
  await expect(dialog.locator(".global-result")).toHaveCount(1)
  await expect(dialog.locator(".global-result-context")).toContainText("Docs")
  expect(requests.filter((url) => url.includes("project-1"))).toHaveLength(1)
  await input.fill("missing")
  await expect(dialog.getByRole("heading", { name: "No matching conversations" })).toBeVisible()
  await expect(dialog.getByText("Try fewer words or a specific phrase from the conversation.")).toBeVisible()
})

for (const width of [390, 800, 1440]) {
  test(`keeps keyboard focus inside search and avoids overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(projectPath)
    await page.getByRole("button", { name: "Search all conversations" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("searchbox").fill("startup")
    await expect(dialog.locator(".global-result")).toHaveCount(24)
    await dialog.getByRole("button", { name: "Close search" }).focus()
    await page.keyboard.press("Shift+Tab")
    expect(await page.evaluate(() => !!document.activeElement?.closest("dialog"))).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
  })
}

test("opens a legacy search link as a project-scoped dialog", async ({ page }) => {
  await page.goto(`${projectPath}/search?q=startup`)
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("searchbox")).toHaveValue("startup")
  await expect(dialog.getByRole("button", { name: "Remove project filter" })).toHaveText("ATape ×")
  await page.keyboard.press("Escape")
  await expect(page).toHaveURL(projectPath)
  await expect(page.getByRole("heading", { name: "Conversations", exact: true })).toBeVisible()
})

for (const width of [390, 1440]) {
  test(`keeps the account avatar reachable with the sidebar collapsed at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(projectPath)
    const account = page.getByRole("link", { name: "Open account security for Mai" })
    await expect(account).toBeVisible()
    await expect(account.locator(".workspace-profile-avatar")).toBeVisible()
    if (width > 640) {
      await expect(account.getByText("Account & security")).toBeVisible()
      await page.getByRole("button", { name: "Collapse sidebar" }).click()
    }
    await expect(account).toBeVisible()
    await expect(account.locator(".workspace-profile-avatar")).toBeVisible()
    await page.getByRole("button", { name: "Expand sidebar" }).click()
    await expect(account).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0)
    await account.click()
    await expect(page.getByRole("heading", { name: "Account security" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Browser sessions" })).toBeVisible()
  })
}

for (const width of [320, 390, 1440]) {
  test(`opens Team settings from the Team menu at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(projectPath)
    const trigger = page.getByRole("button", { name: "Team options for Team A" })
    await expect(trigger).toBeVisible()
    if (width > 640) await page.getByRole("button", { name: "Collapse sidebar" }).click()
    await trigger.click()
    const menu = page.getByRole("navigation", { name: "Team options", exact: true })
    await expect(menu.getByRole("link", { name: "Team settings" })).toHaveAttribute(
      "href",
      "/teams/team-a/settings/access"
    )
    expect(
      await menu.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return rect.left >= 0 && rect.right <= innerWidth
      })
    ).toBe(true)
    await page.keyboard.press("Tab")
    await expect(menu.getByRole("link", { name: "Team settings" })).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(menu).toBeHidden()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await menu.getByRole("link", { name: "Team settings" }).click()
    await expect(page.getByRole("heading", { name: "Team & access" })).toBeVisible()
  })
}
