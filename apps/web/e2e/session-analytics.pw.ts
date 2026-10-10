import { expect, test } from "@playwright/test"
import { analyticsFixture } from "../test/sessionAnalyticsFixture"

const path = "/teams/team-id/projects/project-1/sessions/session-reader?thread=root"
test.beforeEach(async ({ context, request }) => {
  await request.post("http://127.0.0.1:8080/__fixture/reset")
  await context.addCookies([{ name: "fixture_session", value: "1", url: "http://127.0.0.1:4187" }])
})

test("analysis separates unknown counters, filters only evidence and pins every evidence continuation", async ({ page }) => {
  const reads: URL[] = []
  await page.route("**/api/v1/sessions/session-reader/analytics*", async route => {
    const url = new URL(route.request().url()); reads.push(url)
    const filtered = url.searchParams.get("metric") === "thoughts"
    const longLabel = "界".repeat(167)
    await route.fulfill({ json: { ...analyticsFixture,
      tools: [...analyticsFixture.tools, { ...analyticsFixture.tools[0], name: longLabel }], evidence: filtered ? { items: [] } :
      url.searchParams.has("cursor") ? { items: [{ ...analyticsFixture.evidence.items[0], label: "Second evidence page" }] } : analyticsFixture.evidence } })
  })
  await page.goto(path)
  await page.getByRole("button", { name: "Session analysis", exact: true }).click()
  const panel = page.getByRole("region", { name: "Session analysis", exact: true })
  await expect(panel.getByRole("heading", { name: "Session analysis", exact: true })).toBeFocused()
  await expect(panel.getByText("Capture: Partial", { exact: true })).toBeVisible()
  await expect(panel.locator(".analytics-token-grid").first()).toContainText("TotalUnknownInput10OutputUnknownCache read0Cache writeUnknown")
  await expect(panel.locator("time")).toHaveCount(0)
  await expect(panel.getByRole("button", { name: "界".repeat(167), exact: true })).toBeDisabled()
  await expect(panel.getByLabel("Tool label", { exact: true }).locator("option")).toHaveCount(2)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await page.locator(".session-main-reader").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.setViewportSize({ width: 1280, height: 720 })
  await panel.getByRole("button", { name: "Failed calls: Read file", exact: true }).click()
  await expect(panel.getByLabel("Evidence type", { exact: true })).toHaveValue("failed_tools")
  await expect(panel.getByLabel("Tool label", { exact: true })).toHaveValue("Read file")
  expect(reads.at(-1)!.searchParams.get("snapshot")).toBe("snapshot-one")
  expect(reads.at(-1)!.searchParams.get("tool")).toBe("Read file")
  await expect(panel.locator(".analytics-summary")).toContainText("Message fragments6")
  await panel.getByRole("button", { name: "Next evidence page", exact: true }).click()
  await expect(panel.getByRole("link", { name: "Second evidence page", exact: true })).toBeVisible()
  expect(Object.fromEntries(reads.at(-1)!.searchParams)).toMatchObject({ snapshot: "snapshot-one", metric: "failed_tools", tool: "Read file", cursor: "page-two" })
  await panel.getByLabel("Evidence type", { exact: true }).selectOption("thoughts")
  await expect(panel.getByText("No evidence matches these filters.", { exact: true })).toBeVisible()
  await expect(panel.getByLabel("Tool label", { exact: true })).toBeDisabled()
  expect(reads.at(-1)!.searchParams.has("tool")).toBe(false)
  expect(reads.at(-1)!.searchParams.has("cursor")).toBe(false)
  await expect(panel.locator(".analytics-summary")).toContainText("Message fragments6")
})

for (const versioned of [true, false]) {
  test(`evidence opens and focuses a folded Reader event with ${versioned ? "head and snapshot" : "legacy snapshot"}`, async ({ page }) => {
    const { head: _head, ...legacy } = analyticsFixture
    await page.route("**/api/v1/sessions/session-reader/analytics*", route => route.fulfill({ json: versioned ? {
      ...analyticsFixture, evidence: { ...analyticsFixture.evidence, items: analyticsFixture.evidence.items.map(item => ({ ...item, threadId: "child" })) }
    } : legacy }))
    const reads: URL[] = []
    await page.route("**/api/v1/sessions/session-reader?*", async route => {
      const url = new URL(route.request().url()); reads.push(url)
      const response = await route.fetch({ url: `${url.origin}${url.pathname}?thread=root` }); const value = await response.json()
      value.thread = { ...value.thread, id: url.searchParams.get("thread") ?? "root" }
      value.snapshot = "snapshot-one"
      if (versioned) value.head = "head-one"
      else delete value.head
      if (url.searchParams.get("at") === "tool-1") value.events = [
        { id: "prompt", kind: "message", author: "User", text: "Check this file", occurredAt: null },
        { id: "tool-1", kind: "tool_call", author: "Agent", text: "Captured tool evidence", toolLabel: "Read file", occurredAt: null,
          tool: { sessionUpdate: "tool_call_update", toolCallId: "call-1", title: "Read file", status: "failed", rawInput: { path: "missing.txt" } } },
        { id: "answer", kind: "message", author: "Agent", text: "File was missing", occurredAt: null }
      ]
      await route.fulfill({ json: value })
    })
    await page.goto(path)
    await page.getByRole("button", { name: "Session analysis", exact: true }).click()
    const panel = page.getByRole("region", { name: "Session analysis", exact: true })
    await panel.getByRole("button", { name: "Failed calls: Read file", exact: true }).click()
    await panel.getByRole("button", { name: "Next evidence page", exact: true }).click()
    const link = panel.getByRole("link", { name: "Read failing file", exact: true })
    await expect(link).toHaveAttribute("href", /snapshot=snapshot-one/)
    if (versioned) await expect(link).toHaveAttribute("href", /head=head-one/)
    else await expect(link).not.toHaveAttribute("href", /head=/)
    await link.click()
    await expect(page.locator("#event-tool-1")).toBeFocused()
    await expect(page.locator("#event-tool-1")).toBeVisible()
    await expect(page.locator(".narrative-activity:has(#event-tool-1)")).toHaveAttribute("open", "")
    expect(reads.at(-1)!.searchParams.get("snapshot")).toBe("snapshot-one")
    expect(reads.at(-1)!.searchParams.get("at")).toBe("tool-1")
    expect(reads.at(-1)!.searchParams.get("head")).toBe(versioned ? "head-one" : null)
    expect(reads.at(-1)!.searchParams.get("thread")).toBe(versioned ? "child" : "root")
    await page.getByRole("button", { name: "Session analysis", exact: true }).click()
    await expect(panel.getByLabel("Evidence type", { exact: true })).toHaveValue("failed_tools")
    await expect(panel.getByLabel("Tool label", { exact: true })).toHaveValue("Read file")
    await expect(panel.getByRole("button", { name: "First evidence page", exact: true })).toBeEnabled()
  })
}

test("replacement requires refresh, and denied analysis cannot reappear during temporary retries", async ({ page }) => {
  let mode = "ready"
  const reads: URL[] = []
  await page.route("**/api/v1/sessions/session-reader/analytics*", async route => {
    const url = new URL(route.request().url()); reads.push(url)
    if (mode === "changed") {
      await route.fulfill({ status: 409, json: { code: "refresh_required", detail: "Changed" } }); return
    }
    if (mode === "denied") {
      await route.fulfill({ status: 404, json: { code: "not_found", detail: "Unavailable" } }); return
    }
    if (mode === "temporary") {
      await route.fulfill({ status: 503, json: { code: "service_unavailable", detail: "Temporary" } }); return
    }
    if (mode === "network") { await route.abort(); return }
    if (mode === "replacement" && (url.searchParams.has("tool") || url.searchParams.has("thread"))) {
      await route.fulfill({ status: 422, json: { code: "invalid_query", detail: "The selected filter no longer exists." } }); return
    }
    await route.fulfill({ json: mode === "replacement" ? { ...analyticsFixture, snapshot: "snapshot-two", tools: [], evidence: { items: [] } } : analyticsFixture })
  })
  await page.goto(path)
  await page.getByRole("button", { name: "Session analysis", exact: true }).click()
  const panel = page.getByRole("region", { name: "Session analysis", exact: true })
  await expect(panel.getByRole("link", { name: "Read failing file", exact: true })).toBeVisible()
  await panel.getByRole("button", { name: "Failed calls: Read file", exact: true }).click()
  await panel.getByLabel("Thread", { exact: true }).selectOption("child")
  await expect(panel.getByLabel("Thread", { exact: true })).toHaveValue("child")
  mode = "changed"
  await panel.getByRole("button", { name: "Next evidence page", exact: true }).click()
  await expect(panel.getByRole("heading", { name: "Conversation has changed" })).toBeVisible()
  await expect(panel.getByRole("link", { name: "Read failing file", exact: true })).toHaveCount(0)
  mode = "replacement"
  await panel.getByRole("button", { name: "Reload analysis", exact: true }).first().click()
  await expect(panel.getByText("No linked tool calls were captured.", { exact: true })).toBeVisible()
  expect(reads.at(-1)!.searchParams.has("snapshot")).toBe(false)
  expect(reads.at(-1)!.searchParams.has("cursor")).toBe(false)
  expect(reads.at(-1)!.searchParams.has("thread")).toBe(false)
  expect(reads.at(-1)!.searchParams.has("tool")).toBe(false)
  mode = "denied"
  await panel.getByRole("button", { name: "Reload analysis", exact: true }).first().click()
  await expect(panel.getByRole("heading", { name: "Analysis is unavailable" })).toBeVisible()
  await expect(panel.locator(".analytics-summary")).toHaveCount(0)
  for (const failure of ["temporary", "network"]) {
    mode = failure
    await panel.getByRole("button", { name: "Try again", exact: true }).click()
    await expect(panel.getByRole("heading", { name: "Analysis is unavailable" })).toBeVisible()
    await expect(panel.getByText(failure === "temporary" ? "ATape is temporarily unavailable. Try again shortly." : "ATape could not reach the server. Check your connection and try again.", { exact: true })).toBeVisible()
    await expect(panel.locator(".analytics-summary")).toHaveCount(0)
  }
})


test("returning to the Reader revalidates without old content and offers retry after a failed read", async ({ page }) => {
  let mode = "original"
  await page.route("**/api/v1/sessions/session-reader/analytics*", route => route.fulfill({ json: analyticsFixture }))
  await page.route("**/api/v1/sessions/session-reader?*", async route => {
    if (mode === "failed") {
      await route.fulfill({ status: 503, json: { code: "service_unavailable", detail: "Temporary" } }); return
    }
    const response = await route.fetch(); const value = await response.json()
    value.events = [{ id: "reader-body", kind: "message", author: "User", occurredAt: null,
      text: mode === "original" ? "Previously authorized Reader body" : "Freshly revalidated Reader body" }]
    await route.fulfill({ json: value })
  })
  await page.goto(path)
  await expect(page.getByText("Previously authorized Reader body", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Session analysis", exact: true }).click()
  await expect(page.locator(".analytics-summary")).toBeVisible()
  mode = "failed"
  await page.getByRole("button", { name: "Back to conversation", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Conversation is unavailable", exact: true })).toBeVisible()
  await expect(page.getByText("Previously authorized Reader body", { exact: true })).toHaveCount(0)
  mode = "fresh"
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(page.getByText("Freshly revalidated Reader body", { exact: true })).toBeVisible()
  await expect(page.getByText("Previously authorized Reader body", { exact: true })).toHaveCount(0)
})
