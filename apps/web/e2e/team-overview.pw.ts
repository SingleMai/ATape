import { expect, test } from "@playwright/test"

test.beforeEach(async ({ context, request }) => {
  await request.post("http://127.0.0.1:8080/__fixture/reset")
  await context.addCookies([{ name: "fixture_session", value: "1", url: "http://127.0.0.1:4187" }])
})
test("lands on Team Overview, exposes cache, drills down and restores navigation", async ({ page }) => {
  await page.goto("/")
  await expect(page).toHaveURL(/\/teams\/team-id$/)
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible()
  await expect(page.locator(".overview-metric")).toHaveCount(6)
  await expect(page.locator(".overview-metrics").getByText("Cache read", { exact: true })).toBeVisible()
  await expect(page.getByRole("region", { name: "Overview filters" })).toHaveCount(0)
  await page.getByLabel("Time range", { exact: true }).selectOption("7")
  await page.getByRole("button", { name: /^Filters/ }).click()
  await page.getByLabel("Model", { exact: true }).selectOption("model-a")
  await expect(page).toHaveURL(/model=model-a/)
  await page.getByRole("button", { name: /^Filters/ }).click()
  await expect(page.getByRole("region", { name: "Overview filters" })).toHaveCount(0)
  await page.getByRole("button", { name: "Open sessions", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 450))
  const priorScroll = await page.evaluate(() => window.scrollY)
  await page.getByRole("button", { name: "Conversation hierarchy", exact: true }).first().click()
  await expect(page).toHaveURL(/sessions\/session-reader/)
  await page.goBack()
  await expect(page.getByRole("button", { name: "Remove model filter: model-a" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(priorScroll)
  await page.getByRole("button", { name: "Next", exact: true }).click()
  await expect(page.getByText("24 sessions · Page 2")).toBeVisible()
  await page.reload()
  await expect(page.getByText("24 sessions · Page 2")).toBeVisible()
  await page.getByRole("button", { name: "Remove model filter: model-a" }).click()
  await expect(page).not.toHaveURL(/model=model-a/)
  await expect(page.getByText("24 sessions · Page 1")).toBeVisible()
})
test("updates conversation cards on manual refresh and retains successful data on failure", async ({ page, request }) => {
  await page.goto("/teams/team-id")
  await expect(page.locator(".overview-session").first()).toContainText("Conversation hierarchy")
  await page.clock.install()
  await request.post("http://127.0.0.1:8080/__fixture/overview?revision=1")
  await page.clock.fastForward(60_000)
  await expect(page.locator(".overview-session").first()).toContainText("Conversation hierarchy")
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.locator(".overview-session").first()).toContainText("New conversation arrived")
  await request.post("http://127.0.0.1:8080/__fixture/overview?fail=1")
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("last successful update")
  await expect(page.locator(".overview-metric")).toHaveCount(6)
})
test("remains readable without document overflow at supported widths", async ({ page }) => {
  await page.goto("/teams/team-id")
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible()
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    await expect(page.locator(".overview-metrics").getByText("Cache write", { exact: true })).toBeVisible()
  }
  await page.getByLabel("Chart metric").selectOption("tokens")
  await page.getByText("View exact chart values").click()
  const first = page.locator(".overview-chart-data tbody button").first()
  await first.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible()
})

test("clears the previous dashboard when Team access is revoked", async ({ page }) => {
  await page.goto("/teams/team-id")
  await expect(page.locator(".overview-metric")).toHaveCount(6)
  await page.route("**/api/v1/teams/team-id/overview*", route => route.fulfill({ status: 403, json: { code: "forbidden", message: "Team access was revoked." } }))
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByRole("alert")).toBeVisible()
  await expect(page.locator(".overview-metric")).toHaveCount(0)
  await expect(page.locator(".overview-session")).toHaveCount(0)
})

test("Session pages request only their visible snapshot and refresh summary with rows", async ({ page }) => {
  let dashboards = 0, pages = 0, revision = 0
  await page.route("**/api/v1/teams/team-id/overview**", async route => {
    const sessionsOnly = new URL(route.request().url()).pathname.endsWith("/sessions")
    if (sessionsOnly) pages++; else dashboards++
    const response = await route.fetch()
    const data = await response.json()
    if (sessionsOnly) {
      expect(data).not.toHaveProperty("trend")
      expect(data).not.toHaveProperty("members")
      expect(data).not.toHaveProperty("projects")
      expect(data).not.toHaveProperty("models")
      if (revision) {
        data.metrics.messages = 987
        data.sessions[0].title = "Fresh Session page"
      }
    }
    await route.fulfill({ response, json: data })
  })
  await page.goto("/teams/team-id?view=sessions")
  await expect(page.getByText("24 sessions · Page 1")).toBeVisible()
  await page.getByRole("button", { name: "Next", exact: true }).click()
  await expect(page.getByText("24 sessions · Page 2")).toBeVisible()
  expect({ dashboards, pages }).toEqual({ dashboards: 1, pages: 1 })
  revision = 1
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.locator(".overview-session").first()).toContainText("Fresh Session page")
  await expect(page.locator(".overview-metrics")).toContainText("987")
  expect({ dashboards, pages }).toEqual({ dashboards: 1, pages: 2 })
  await page.reload()
  await expect(page.getByText("24 sessions · Page 2")).toBeVisible()
  expect({ dashboards, pages }).toEqual({ dashboards: 1, pages: 3 })
})

test("Session pages fall back to older Servers and still discard revoked data", async ({ page }) => {
  let dashboards = 0, pages = 0, revoked = false
  await page.route("**/api/v1/teams/team-id/overview**", async route => {
    if (new URL(route.request().url()).pathname.endsWith("/sessions")) {
      pages++
      await route.fulfill({ status: 404, json: { code: "not_found", message: "Not found" } })
    } else {
      dashboards++
      if (revoked) await route.fulfill({ status: 404, json: { code: "not_found", message: "Not found" } })
      else await route.continue()
    }
  })
  await page.goto("/teams/team-id?view=sessions&page=1")
  await expect(page.getByText("24 sessions · Page 2")).toBeVisible()
  expect({ dashboards, pages }).toEqual({ dashboards: 1, pages: 1 })
  revoked = true
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByRole("alert")).toBeVisible()
  await expect(page.locator(".overview-metric")).toHaveCount(0)
  await expect(page.locator(".overview-session")).toHaveCount(0)
  expect({ dashboards, pages }).toEqual({ dashboards: 2, pages: 2 })
})

test("a failed Session page refresh retains its snapshot without requesting the full dashboard", async ({ page }) => {
  await page.goto("/teams/team-id?view=sessions&page=1")
  await expect(page.getByText("24 sessions · Page 2")).toBeVisible()
  let dashboards = 0
  await page.route("**/api/v1/teams/team-id/overview**", async route => {
    if (!new URL(route.request().url()).pathname.endsWith("/sessions")) dashboards++
    await route.fulfill({ status: 503, json: { code: "unavailable", message: "Unavailable" } })
  })
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("last successful update")
  await expect(page.getByText("24 sessions · Page 2")).toBeVisible()
  await expect(page.locator(".overview-metric")).toHaveCount(6)
  expect(dashboards).toBe(0)
})

for (const representation of ["compact", "legacy"] as const) {
  test(`${representation} option representations retain members with no activity`, async ({ page }) => {
    await page.route("**/api/v1/teams/team-id/overview**", async route => {
      const url = new URL(route.request().url())
      expect(url.searchParams.get("options")).toBe("compact")
      if (representation === "legacy") url.searchParams.delete("options")
      const response = await route.fetch({ url: url.toString() })
      const data = await response.json()
      const choice = data.options.members[0]
      expect(Object.keys(choice).sort()).toEqual(representation === "compact"
        ? ["current", "id", "name"]
        : ["current", "id", "name", "projects", "sessions", "tokens"])
      data.options.members = [{ ...choice, id: "idle", name: "Idle member", current: true }]
      data.members = []
      await route.fulfill({ response, json: data })
    })
    await page.goto("/teams/team-id?view=members")
    const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Idle member", exact: true }) })
    await expect(row).toBeVisible()
    await expect(row.getByRole("cell", { name: "0", exact: true })).toHaveCount(2)
    await expect(row).toContainText("Not provided")
  })
}

for (const view of ["members", "projects", "usage"] as const) {
  test(`${view} pagination reuses the dashboard and still refreshes on demand`, async ({ page }) => {
    let requests = 0
    await page.route("**/api/v1/teams/team-id/overview*", async route => {
      requests++
      const response = await route.fetch()
      const data = await response.json()
      const rows = Array.from({ length: 30 }, (_, i) => ({ ...data.members[0], id: `row-${i}`, name: `Entry ${i + 1}`, current: true }))
      data.members = rows
      data.options.members = rows
      data.projects = rows
      data.models = rows
      await route.fulfill({ response, json: data })
    })
    await page.goto(`/teams/team-id?view=${view}`)
    await expect(page.getByRole("button", { name: "Entry 1", exact: true })).toBeVisible()
    expect(requests).toBe(1)
    await page.getByRole("button", { name: "Next", exact: true }).click()
    await expect(page.getByRole("button", { name: "Entry 26", exact: true })).toBeVisible()
    await expect(page).toHaveURL(/page=1/)
    expect(requests).toBe(1)
    const refreshed = page.waitForResponse(response => response.url().includes("/overview?") && response.request().method() === "GET")
    await page.getByRole("button", { name: "Refresh", exact: true }).click()
    await refreshed
    await expect(page.getByRole("button", { name: "Entry 26", exact: true })).toBeVisible()
    expect(requests).toBe(2)
    await page.reload()
    await expect(page.getByRole("button", { name: "Entry 26", exact: true })).toBeVisible()
    expect(requests).toBe(3)
  })
}
