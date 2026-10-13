import { expect, test, type Page } from "@playwright/test"
import { stableToolsFixture } from "../test/sessionAnalyticsFixture"
import { tokenActivityReport, tokenActivityResponse, tokenBucketLabel, tokenHead, tokenModelKey, tokenSnapshot, tokenUnknownModelKey } from "../test/sessionTokenActivityFixture"

const path = "/teams/team-id/projects/project-1/sessions/session-reader?thread=root"
test.beforeEach(async ({ context, request }) => {
  await request.post("http://127.0.0.1:8080/__fixture/reset")
  await context.addCookies([{ name: "fixture_session", value: "1", url: "http://127.0.0.1:4187" }])
})

const tokenAPI = async (page: Page) => {
  const reads: URL[] = [], violations: string[] = []
  let mode: "ready" | "changed" | "denied" = "ready"
  await page.route("**/api/v1/sessions/session-reader/analytics*", async route => {
    const url = new URL(route.request().url()); reads.push(url)
    expect(route.request().method()).toBe("GET")
    expect(route.request().headers().accept).toBe("application/vnd.atape.session-analytics.v5+json, application/vnd.atape.session-analytics.v4+json, application/vnd.atape.session-analytics.v3+json, application/json")
    if (mode === "changed") { await route.fulfill({ status: 409, json: { code: "refresh_required", detail: "Changed" } }); return }
    if (mode === "denied") { await route.fulfill({ status: 404, json: { code: "not_found", detail: "Unavailable" } }); return }
    const response = tokenActivityResponse(url.searchParams)
    if (response.violation) violations.push(response.violation)
    await route.fulfill({ status: response.status, json: response.body })
  })
  return { reads, violations, mode: (value: typeof mode) => { mode = value } }
}

const openTokens = async (page: Page) => {
  await page.goto(path)
  await page.getByRole("button", { name: "Session analysis", exact: true }).click()
  const panel = page.getByRole("region", { name: "Session analysis", exact: true })
  await expect(panel.getByRole("heading", { name: "Token consumption", exact: true })).toBeVisible()
  return { panel, tokens: panel.getByRole("region", { name: "Token consumption", exact: true }) }
}

const conditionalReader = async (page: Page) => {
  const reads: URL[] = []
  await page.route("**/api/v1/sessions/session-reader?*", async route => {
    const url = new URL(route.request().url()); reads.push(url)
    const response = await route.fetch({ url: `${url.origin}${url.pathname}?thread=root` }), value = await response.json()
    value.thread = { ...value.thread, id: url.searchParams.get("thread") ?? "root" }
    value.head = tokenHead; value.snapshot = tokenSnapshot
    if (url.searchParams.get("at") === "token-context-21") value.events = [{ id: "token-context-21", kind: "tool_result", author: "Agent",
      text: "Contemporaneous context, not a per-response Token attribution", occurredAt: "2026-10-13T08:01:30Z",
      tool: { sessionUpdate: "tool_call_update", toolCallId: "context-call", title: "Read file", status: "completed" } }]
    await route.fulfill({ json: value })
  })
  return reads
}

test("Token hotspots retain model, Thread, snapshot and page through conditional Reader focus and browser Back", async ({ page }) => {
  const api = await tokenAPI(page), readerReads = await conditionalReader(page), { panel, tokens } = await openTokens(page)
  await expect(tokens.getByText("3 reported · 1 missing", { exact: true })).toHaveCount(5)
  await expect(tokens.getByLabel("Recorded input cache shares", { exact: true })).toContainText("Cache read share20%Cache write share10%Uncached input share70%")
  await tokens.getByLabel("Token model", { exact: true }).selectOption(tokenModelKey)
  await tokens.getByLabel("Token thread", { exact: true }).selectOption("child")
  await expect(tokens.getByLabel("Token thread", { exact: true })).toHaveValue("child")
  await expect(tokens.getByLabel("Token model", { exact: true })).toHaveValue(tokenModelKey)
  const hot = tokens.locator(".analytics-token-hotspots").getByRole("button", { name: tokenBucketLabel("child", tokenModelKey), exact: true })
  await hot.click()
  const range = tokenActivityReport("child", tokenModelKey).buckets[1]!.range
  await expect(panel.getByLabel("Evidence type", { exact: true })).toHaveValue("token_records")
  await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveCount(20)
  expect(Object.fromEntries(api.reads.at(-1)!.searchParams)).toMatchObject({ metric: "token_records", model: tokenModelKey,
    thread: "child", snapshot: tokenSnapshot, tokenRange: range })
  await panel.getByRole("button", { name: "Next evidence page", exact: true }).click()
  await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveCount(4)
  expect(api.reads.at(-1)!.searchParams.get("tokenRange")).toBe(range)
  expect(api.reads.at(-1)!.searchParams.get("cursor")).toBe(`next-${range}`)
  const link = panel.getByRole("link", { name: "Token interval context", exact: true })
  await expect(link).toHaveAttribute("href", /snapshot=token-snapshot-one/)
  await link.click()
  await expect(page.locator("#event-token-context-21")).toBeFocused()
  await expect(page.locator(".narrative-activity:has(#event-token-context-21)")).toHaveAttribute("open", "")
  expect(Object.fromEntries(readerReads.at(-1)!.searchParams)).toMatchObject({ snapshot: tokenSnapshot, head: tokenHead,
    thread: "child", at: "token-context-21" })
  expect(readerReads.at(-1)!.searchParams.has("model")).toBe(false)
  await page.goBack()
  await expect(page).toHaveURL(/analysis=open/)
  await expect(tokens.getByLabel("Token model", { exact: true })).toHaveValue(tokenModelKey)
  await expect(tokens.getByLabel("Token thread", { exact: true })).toHaveValue("child")
  await expect(hot).toHaveAttribute("aria-pressed", "true")
  await expect(panel.getByRole("button", { name: "First evidence page", exact: true })).toBeEnabled()
  await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveCount(4)
  expect(api.violations).toEqual([])
})

test("changing Token scopes clears interval and cursor, preserves a literal unknown model, and full refresh clears all selections", async ({ page }) => {
  const api = await tokenAPI(page), { panel, tokens } = await openTokens(page)
  await expect(tokens.getByLabel("Token model", { exact: true }).locator(`option[value="${tokenModelKey}"]`)).toHaveText("unknown")
  await expect(tokens.getByLabel("Token model", { exact: true }).locator(`option[value="${tokenUnknownModelKey}"]`)).toHaveText("Model unknown")
  await tokens.locator(".analytics-token-hotspots").getByRole("button", { name: tokenBucketLabel(), exact: true }).click()
  await panel.getByRole("button", { name: "Next evidence page", exact: true }).click()
  await tokens.getByLabel("Token model", { exact: true }).selectOption(tokenUnknownModelKey)
  await expect(panel.getByLabel("Evidence type", { exact: true })).toHaveValue("records")
  expect(Object.fromEntries(api.reads.at(-1)!.searchParams)).toEqual({ metric: "records", model: tokenUnknownModelKey, snapshot: tokenSnapshot })
  await tokens.getByLabel("Token thread", { exact: true }).selectOption("child")
  await expect(tokens.getByLabel("Token thread", { exact: true })).toHaveValue("child")
  expect(api.reads.at(-1)!.searchParams.get("model")).toBe(tokenUnknownModelKey)
  await panel.getByLabel("Evidence type", { exact: true }).selectOption("thoughts")
  await expect(panel.getByLabel("Evidence type", { exact: true })).toHaveValue("thoughts")
  expect(api.reads.at(-1)!.searchParams.get("model")).toBe(tokenUnknownModelKey)
  await tokens.getByLabel("Token model", { exact: true }).selectOption("")
  await expect(tokens.getByLabel("Token model", { exact: true })).toHaveValue("")
  expect(api.reads.at(-1)!.searchParams.has("model")).toBe(false)
  await tokens.locator(".analytics-token-hotspots").getByRole("button", { name: tokenBucketLabel("child"), exact: true }).click()
  api.mode("changed")
  await panel.getByRole("button", { name: "Next evidence page", exact: true }).click()
  await expect(panel.getByRole("heading", { name: "Conversation has changed", exact: true })).toBeVisible()
  await expect(panel.locator(".analytics-token-activity")).toHaveCount(0)
  api.mode("ready")
  await panel.getByRole("button", { name: "Reload analysis", exact: true }).first().click()
  await expect(tokens.getByLabel("Token thread", { exact: true })).toHaveValue("")
  await expect(tokens.getByLabel("Token model", { exact: true })).toHaveValue("")
  expect(Object.fromEntries(api.reads.at(-1)!.searchParams)).toEqual({ metric: "tools" })
  expect(api.violations).toEqual([])
})

test("zero-context intervals stay visible without a nearest-record jump and Token presentation fits a narrow Reader", async ({ page }) => {
  const api = await tokenAPI(page), { tokens } = await openTokens(page)
  const empty = tokens.locator(".analytics-token-bars").getByRole("button", { name: tokenBucketLabel(null, null, 2), exact: true })
  await expect(empty).toBeVisible()
  await expect(empty).toBeDisabled()
  await expect(empty).toHaveAttribute("title", "No contemporaneous records are available in this interval.")
  const untimed = tokens.getByText("Known subtotals without a usage time (1 samples)", { exact: true })
  await untimed.click()
  await expect(tokens.getByText("Included in subtotals; no interval can be selected without a time.", { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await page.locator(".session-main-reader").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(api.reads).toHaveLength(1)
  expect(api.violations).toEqual([])
})

test("a v4 Server retains its reports and explicitly marks Token distribution unavailable", async ({ page }) => {
  await page.route("**/api/v1/sessions/session-reader/analytics*", route => route.fulfill({ json: stableToolsFixture }))
  const { panel, tokens } = await openTokens(page)
  await expect(tokens.getByText("This Server does not provide Token distribution or cache shares yet.", { exact: true })).toBeVisible()
  await expect(tokens.getByLabel("Recorded input cache shares", { exact: true })).toHaveCount(0)
  await expect(tokens.locator(".analytics-token-bars")).toHaveCount(0)
  await expect(panel.getByRole("heading", { name: "Recorded tools", exact: true })).toBeVisible()
  await expect(panel.getByRole("heading", { name: "Recorded file activity", exact: true })).toBeVisible()
})
