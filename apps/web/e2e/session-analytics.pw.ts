import { expect, test, type Page } from "@playwright/test"
import { activityFixture, analyticsFixture, capabilitiesFixture, executeToolKey, literalUnknownToolFixture, stableToolsFixture, unknownToolKey } from "../test/sessionAnalyticsFixture"
import { activityHead, activityReplacement, activityReport, activityResponse, activitySnapshot,
  bucketName, childBucketRange, childPageCursor, unplacedRecords } from "../test/sessionActivityFixture"

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
  await expect(panel.getByText("This Server does not provide MCP or Skills reports yet.", { exact: true })).toBeVisible()
  await expect(panel.getByLabel("Evidence type", { exact: true }).locator('option[value="mcp_tools"]')).toHaveCount(0)
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


test("MCP and Skills filters retain identity, snapshot and page across Reader evidence navigation", async ({ page }) => {
  let mode = "ready"
  const reads: URL[] = []
  await page.route("**/api/v1/sessions/session-reader/analytics*", async route => {
    const url = new URL(route.request().url()); reads.push(url)
    if (mode === "changed") {
      await route.fulfill({ status: 409, json: { code: "refresh_required", detail: "Changed" } }); return
    }
    if (mode === "replacement") {
      if (url.searchParams.has("capability") || url.searchParams.has("server") || url.searchParams.has("thread")) {
        await route.fulfill({ status: 422, json: { code: "validation_failed", detail: "Selection was removed." } }); return
      }
      await route.fulfill({ json: { ...capabilitiesFixture, snapshot: "snapshot-two", capabilities: {
        mcpCalls: 0, skillCalls: 0, unclassifiedCalls: 5, mcp: [], skills: [] }, evidence: { items: [] } } }); return
    }
    await route.fulfill({ json: { ...capabilitiesFixture, evidence: {
      items: [{ eventId: "tool-capability", threadId: "child", kind: "tool_result", label: "Capability invocation evidence", occurredAt: null }], nextCursor: "next-capability" } } })
  })
  await page.route("**/api/v1/sessions/session-reader?*", async route => {
    const url = new URL(route.request().url())
    const response = await route.fetch({ url: `${url.origin}${url.pathname}?thread=root` }); const value = await response.json()
    value.thread = { ...value.thread, id: url.searchParams.get("thread") ?? "root" }
    value.head = "head-one"; value.snapshot = "snapshot-one"
    if (url.searchParams.get("at") === "tool-capability") value.events = [{
      id: "tool-capability", kind: "tool_result", author: "Agent", text: "The recorded invocation finished", occurredAt: null,
      tool: { sessionUpdate: "tool_call_update", toolCallId: "call-capability", title: "Skill", status: "completed" }
    }]
    await route.fulfill({ json: value })
  })
  await page.goto(path)
  await page.getByRole("button", { name: "Session analysis", exact: true }).click()
  const panel = page.getByRole("region", { name: "Session analysis", exact: true })
  await expect(panel.getByText("Completed means the tool finished, not that a Skill task succeeded.", { exact: false })).toBeVisible()
  await panel.getByRole("button", { name: "MCP evidence: repo / lookup", exact: true }).click()
  await expect(panel.getByLabel("Evidence type", { exact: true })).toHaveValue("mcp_tools")
  await expect(panel.getByLabel("MCP server", { exact: true })).toHaveValue("repo")
  await expect(panel.getByLabel("Name", { exact: true })).toHaveValue("lookup")
  expect(Object.fromEntries(reads.at(-1)!.searchParams)).toMatchObject({ metric: "mcp_tools", server: "repo", capability: "lookup", snapshot: "snapshot-one" })
  await panel.getByLabel("Thread", { exact: true }).selectOption("child")
  await expect(panel.getByLabel("Thread", { exact: true })).toHaveValue("child")
  expect(reads.at(-1)!.searchParams.get("server")).toBe("repo")
  await panel.getByRole("button", { name: "Next evidence page", exact: true }).click()
  await expect(panel.getByRole("button", { name: "First evidence page", exact: true })).toBeEnabled()
  expect(Object.fromEntries(reads.at(-1)!.searchParams)).toMatchObject({ metric: "mcp_tools", server: "repo", capability: "lookup", thread: "child", snapshot: "snapshot-one", cursor: "next-capability" })
  await expect(panel.locator(".analytics-summary").first()).toContainText("Linked tool calls5")
  await panel.getByRole("link", { name: "Capability invocation evidence", exact: true }).click()
  await expect(page.locator("#event-tool-capability")).toBeFocused()
  await expect(page).toHaveURL(/snapshot=snapshot-one/)
  await page.getByRole("button", { name: "Session analysis", exact: true }).click()
  await expect(panel.getByLabel("MCP server", { exact: true })).toHaveValue("repo")
  await expect(panel.getByLabel("Name", { exact: true })).toHaveValue("lookup")
  await expect(panel.getByRole("button", { name: "First evidence page", exact: true })).toBeEnabled()
  await panel.getByRole("button", { name: "Skill evidence: review-code", exact: true }).click()
  await expect(panel.getByLabel("Evidence type", { exact: true })).toHaveValue("skills")
  await expect(panel.getByLabel("Name", { exact: true })).toHaveValue("review-code")
  await expect(panel.getByLabel("MCP server", { exact: true })).toHaveCount(0)
  expect(Object.fromEntries(reads.at(-1)!.searchParams)).toMatchObject({ metric: "skills", capability: "review-code", thread: "child", snapshot: "snapshot-one" })
  expect(reads.at(-1)!.searchParams.has("server")).toBe(false)
  expect(reads.at(-1)!.searchParams.has("tool")).toBe(false)
  expect(reads.at(-1)!.searchParams.has("cursor")).toBe(false)
  await panel.getByLabel("Evidence type", { exact: true }).selectOption("thoughts")
  await expect(panel.getByLabel("Name", { exact: true })).toHaveCount(0)
  expect(reads.at(-1)!.searchParams.has("capability")).toBe(false)
  expect(reads.at(-1)!.searchParams.has("server")).toBe(false)
  await panel.getByRole("button", { name: "MCP evidence: docs / lookup", exact: true }).click()
  await expect(panel.getByLabel("MCP server", { exact: true })).toHaveValue("docs")
  await panel.getByLabel("MCP server", { exact: true }).selectOption("repo")
  await expect(panel.getByLabel("Name", { exact: true })).toHaveValue("")
  expect(reads.at(-1)!.searchParams.has("capability")).toBe(false)
  await panel.getByLabel("Name", { exact: true }).selectOption("lookup")
  await expect(panel.getByLabel("Name", { exact: true })).toHaveValue("lookup")
  mode = "changed"
  await panel.getByRole("button", { name: "Next evidence page", exact: true }).click()
  await expect(panel.getByRole("heading", { name: "Conversation has changed", exact: true })).toBeVisible()
  mode = "replacement"
  await panel.getByRole("button", { name: "Reload analysis", exact: true }).first().click()
  await expect(panel.getByText("No MCP calls with structured identity were recorded.", { exact: true })).toBeVisible()
  expect(Object.fromEntries(reads.at(-1)!.searchParams)).toEqual({ metric: "tools" })
})

// These routes replace only the owned remote HTTP boundary. The application,
// browser Gateway, router, Effect state and rendered UI all run unchanged.
const activityAPI = async (page: Page) => {
  const reads: URL[] = [], violations: string[] = []
  let mode: "ready" | "changed" | "replacement" | "denied" = "ready"
  let hold: ((url: URL) => Promise<void>) | undefined
  await page.route("**/api/v1/sessions/session-reader/analytics*", async route => {
    const url = new URL(route.request().url()); reads.push(url)
    expect(route.request().method()).toBe("GET")
    expect(route.request().headers().accept).toBe("application/vnd.atape.session-analytics.v5+json, application/vnd.atape.session-analytics.v4+json, application/vnd.atape.session-analytics.v3+json, application/json")
    expect(route.request().headers()).not.toHaveProperty("atape-accept-analytics-version")
    await hold?.(url)
    if (mode === "changed") { await route.fulfill({ status: 409, json: { code: "refresh_required", detail: "The selected snapshot changed." } }); return }
    if (mode === "denied") { await route.fulfill({ status: 404, json: { code: "not_found", detail: "Unavailable" } }); return }
    if (mode === "replacement") {
      if (Object.keys(Object.fromEntries(url.searchParams)).some(key => key !== "metric") || url.searchParams.get("metric") !== "tools") {
        violations.push("A full activity refresh reused an expired selection.")
        await route.fulfill({ status: 422, json: { code: "validation_failed", detail: violations.at(-1) } }); return
      }
      await route.fulfill({ json: activityReplacement }); return
    }
    const response = activityResponse(url.searchParams)
    if (response.violation) violations.push(response.violation)
    await route.fulfill({ status: response.status, json: response.body })
  })
  return { reads, violations, mode: (next: typeof mode) => { mode = next }, hold: (next: typeof hold) => { hold = next } }
}
const openActivity = async (page: Page) => {
  await page.goto(path)
  await page.getByRole("button", { name: "Session analysis", exact: true }).click()
  await expect(page).toHaveURL(/analysis=open/)
  const panel = page.getByRole("region", { name: "Session analysis", exact: true })
  await expect(panel.getByRole("region", { name: "Recorded activity", exact: true })).toBeVisible()
  return panel
}
const conditionalActivityReader = async (page: Page, mode: () => "ready" | "changed" = () => "ready") => {
  const reads: URL[] = []
  await page.route("**/api/v1/sessions/session-reader?*", async route => {
    const url = new URL(route.request().url()); reads.push(url)
    expect(url.searchParams.has("range")).toBe(false)
    expect(url.searchParams.has("metric")).toBe(false)
    if (url.searchParams.has("at")) {
      expect(url.searchParams.get("snapshot")).toBe(activitySnapshot)
      expect(url.searchParams.get("head")).toBe(activityHead)
      expect(url.searchParams.get("thread")).toBe("child")
      expect(url.searchParams.has("after")).toBe(false)
      if (mode() === "changed") { await route.fulfill({ status: 409, json: { code: "refresh_required", detail: "The Reader snapshot changed." } }); return }
    }
    const response = await route.fetch({ url: `${url.origin}${url.pathname}?thread=root` })
    const value = await response.json()
    if (url.searchParams.get("thread") === "child") {
      value.thread = { id: "child", label: "Captured child", captureStatus: "complete", parentThreadId: "root" }
      value.threadPath = [{ id: "root", label: "Root" }, { id: "child", label: "Captured child" }]
    }
    if (url.searchParams.has("at")) {
      const id = url.searchParams.get("at")!
      value.snapshot = activitySnapshot; value.head = activityHead
      value.events = [
        { id: "child-prompt", kind: "message", author: "User", text: "Inspect the captured child activity", occurredAt: null },
        { id, kind: "tool_result", author: "Codex", text: "The recorded child tool finished", occurredAt: "2026-10-12T08:30:00Z",
          tool: { sessionUpdate: "tool_call_update", toolCallId: "child-call", title: "Read file", status: "completed" } },
        { id: "child-answer", kind: "message", author: "Codex", text: "Captured child evidence is available", occurredAt: null }
      ]
    } else if (url.searchParams.get("thread") === "child") {
      value.head = "activity-head-two"
      value.events = [{ id: "child-fresh", kind: "message", author: "User", occurredAt: "2026-10-12T08:40:00Z",
        text: "Refreshed Reader after explicit reload" }]
    }
    await route.fulfill({ json: value })
  })
  return reads
}

test("v3 displays Server clock coverage and sixty exact intervals without changing Session-wide counts", async ({ page }) => {
  const api = await activityAPI(page), panel = await openActivity(page)
  const activity = panel.getByRole("region", { name: "Recorded activity", exact: true })
  await expect(activity.getByRole("button", { name: /^Show \d+ records from/ })).toHaveCount(60)
  await expect(activity.getByRole("button", { name: bucketName("all", 0), exact: true })).toBeVisible()
  await expect(activity.getByRole("button", { name: bucketName("all", 59), exact: true })).toHaveCount(1)
  await expect(activity.getByText("Record span", { exact: true }).locator("..")).toContainText(/1 h|3,600,000 ms/)
  expect(await activity.locator("time").evaluateAll(times => times.every(time => time.getAttribute("datetime")?.startsWith("2026-10-12")))).toBe(true)
  await expect(activity.getByRole("button", { name: /^Show unplaced records/ })).toContainText("2 unknown time · 2 legacy time")
  const summary = panel.locator(".analytics-summary").filter({ has: page.getByText("Events with known time", { exact: true }) })
  await expect(summary).toContainText("Events with known time31")
  await expect(summary).toContainText("Events with unknown time2")
  await expect(panel.locator(".analytics-token-grid").first()).toContainText("Input10")
  await activity.getByLabel("Activity thread", { exact: true }).selectOption("child")
  await expect(activity.getByText("Record span", { exact: true }).locator("..")).toContainText(/10 min|600,000 ms/)
  await expect(summary).toContainText("Events with known time31")
  await expect(panel.locator(".analytics-token-grid").first()).toContainText("Input10")
  expect(api.violations).toEqual([])
})

test("a child interval retains its snapshot, range and second page through Reader focus and browser Back", async ({ page }) => {
  const api = await activityAPI(page), readerReads = await conditionalActivityReader(page), panel = await openActivity(page)
  await panel.getByLabel("Activity thread", { exact: true }).selectOption("child")
  const activity = panel.getByRole("region", { name: "Recorded activity", exact: true })
  const span = await activity.getByText("Record span", { exact: true }).locator("..").textContent()
  await activity.getByRole("button", { name: bucketName("child", 0), exact: true }).click()
  await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveCount(20)
  expect(Object.fromEntries(api.reads.at(-1)!.searchParams)).toMatchObject({ metric: "records", snapshot: activitySnapshot, thread: "child", range: childBucketRange })
  await panel.getByRole("button", { name: "Next evidence page", exact: true }).click()
  await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveCount(4)
  await expect(activity.getByText("Record span", { exact: true }).locator("..")).toHaveText(span!)
  expect(Object.fromEntries(api.reads.at(-1)!.searchParams)).toMatchObject({ metric: "records", snapshot: activitySnapshot,
    thread: "child", range: childBucketRange, cursor: childPageCursor })
  const link = panel.getByRole("link", { name: "Child tool evidence", exact: true })
  await expect(link).toHaveAttribute("href", /snapshot=activity-snapshot-one/)
  await link.click()
  await expect(page).not.toHaveURL(/analysis=open/)
  await expect(page.locator("#event-child-21")).toBeFocused()
  await expect(page.locator(".narrative-activity:has(#event-child-21)")).toHaveAttribute("open", "")
  expect(Object.fromEntries(readerReads.at(-1)!.searchParams)).toMatchObject({ snapshot: activitySnapshot, head: activityHead, thread: "child", at: "child-21" })
  await page.goBack()
  await expect(page).toHaveURL(/analysis=open/)
  await expect(panel.getByLabel("Activity thread", { exact: true })).toHaveValue("child")
  await expect(activity.getByRole("button", { name: bucketName("child", 0), exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(panel.getByRole("button", { name: "First evidence page", exact: true })).toBeEnabled()
  await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveCount(4)
  await expect(panel.getByRole("button", { name: "Next evidence page", exact: true })).toBeDisabled()
  expect(api.violations).toEqual([])
})

test("unplaced evidence preserves source order and distinguishes null clocks from stored legacy dates", async ({ page }) => {
  const api = await activityAPI(page), panel = await openActivity(page)
  const activity = panel.getByRole("region", { name: "Recorded activity", exact: true })
  await activity.getByRole("button", { name: /^Show unplaced records/ }).click()
  await expect(panel.getByLabel("Evidence type", { exact: true })).toHaveValue("records")
  await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveText(unplacedRecords.map(item => item.label))
  const unknown = panel.locator(".analytics-evidence-list li").filter({ has: page.getByRole("link", { name: "Root unknown-clock record", exact: true }) })
  const legacy = panel.locator(".analytics-evidence-list li").filter({ has: page.getByRole("link", { name: "Root legacy-clock record", exact: true }) })
  await expect(unknown.getByText("Time unknown", { exact: true }).first()).toBeVisible()
  await expect(legacy.getByText("Legacy time", { exact: true })).toBeVisible()
  await expect(legacy.locator("time")).toHaveAttribute("datetime", "1970-01-01T00:00:00Z")
  expect(await activity.locator("time").evaluateAll(times => times.every(time => time.getAttribute("datetime")?.startsWith("2026-10-12")))).toBe(true)
  expect(api.reads.at(-1)!.searchParams.get("range")).toBe(activityReport().unplacedRange)
  expect(api.violations).toEqual([])
})

test("stale evidence and conditional Reader failures require a full refresh without retaining an expired range", async ({ page }) => {
  const api = await activityAPI(page)
  let readerMode: "ready" | "changed" = "ready"
  await conditionalActivityReader(page, () => readerMode)
  const panel = await openActivity(page)
  await panel.getByLabel("Activity thread", { exact: true }).selectOption("child")
  await panel.getByRole("button", { name: bucketName("child", 0), exact: true }).click()
  await panel.getByRole("button", { name: "Next evidence page", exact: true }).click()
  readerMode = "changed"
  await panel.getByRole("link", { name: "Child tool evidence", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Conversation has changed", exact: true })).toBeVisible()
  await expect(page.locator("#event-child-21")).toHaveCount(0)
  await page.goBack()
  await expect(panel.getByLabel("Activity thread", { exact: true })).toHaveValue("child")
  await panel.getByRole("button", { name: "First evidence page", exact: true }).click()
  api.mode("changed")
  await panel.getByRole("button", { name: "Next evidence page", exact: true }).click()
  await expect(panel.getByRole("heading", { name: "Conversation has changed", exact: true })).toBeVisible()
  await expect(panel.getByRole("region", { name: "Recorded activity", exact: true })).toHaveCount(0)
  await expect(panel.getByRole("link", { name: "Child tool evidence", exact: true })).toHaveCount(0)
  api.mode("replacement")
  await panel.getByRole("button", { name: "Reload analysis", exact: true }).first().click()
  await expect(panel.getByText("No recorded source clocks are available for dated buckets.", { exact: true })).toBeVisible()
  expect(Object.fromEntries(api.reads.at(-1)!.searchParams)).toEqual({ metric: "tools" })
  await expect(panel.getByLabel("Activity thread", { exact: true })).toHaveValue("")
  api.mode("denied")
  await panel.getByRole("button", { name: "Reload analysis", exact: true }).first().click()
  await expect(panel.getByRole("heading", { name: "Analysis is unavailable", exact: true })).toBeVisible()
  await expect(panel.getByRole("region", { name: "Recorded activity", exact: true })).toHaveCount(0)
  expect(api.violations).toEqual([])
})

test("Thread and metric changes cannot carry a range or cursor into another activity scope", async ({ page }) => {
  const api = await activityAPI(page), panel = await openActivity(page)
  let release: () => void = () => undefined
  const waiting = new Promise<void>(accept => { release = accept })
  api.hold(url => url.searchParams.get("thread") === "child" && !url.searchParams.has("range") ? waiting : Promise.resolve())
  await panel.getByLabel("Activity thread", { exact: true }).selectOption("child")
  const oldBucket = panel.getByRole("button", { name: bucketName("all", 0), exact: true })
  if (await oldBucket.count()) await expect(oldBucket).toBeDisabled()
  else await expect(panel.getByText("Reading session analysis…", { exact: true })).toBeVisible()
  release(); api.hold(undefined)
  await panel.getByRole("button", { name: bucketName("child", 0), exact: true }).click()
  await panel.getByRole("button", { name: "Next evidence page", exact: true }).click()
  await panel.getByLabel("Activity thread", { exact: true }).selectOption("root")
  await expect(panel.getByLabel("Activity thread", { exact: true })).toHaveValue("root")
  expect(Object.fromEntries(api.reads.at(-1)!.searchParams)).toMatchObject({ thread: "root", metric: "records", snapshot: activitySnapshot })
  expect(api.reads.at(-1)!.searchParams.has("range")).toBe(false)
  expect(api.reads.at(-1)!.searchParams.has("cursor")).toBe(false)
  await panel.getByRole("button", { name: bucketName("root", 59), exact: true }).click()
  await panel.getByLabel("Evidence type", { exact: true }).selectOption("thoughts")
  await expect(panel.getByRole("link", { name: "Root recorded thought", exact: true })).toBeVisible()
  expect(api.reads.at(-1)!.searchParams.get("metric")).toBe("thoughts")
  expect(api.reads.at(-1)!.searchParams.has("range")).toBe(false)
  expect(api.reads.at(-1)!.searchParams.has("cursor")).toBe(false)
  expect(api.violations).toEqual([])
})

test("old v1 and v2 Servers expose unavailable activity while retaining their existing reports", async ({ page }) => {
  let version = 1
  const reads: URL[] = []
  await page.route("**/api/v1/sessions/session-reader/analytics*", async route => {
    const url = new URL(route.request().url()); reads.push(url)
    expect(route.request().headers().accept).toBe("application/vnd.atape.session-analytics.v5+json, application/vnd.atape.session-analytics.v4+json, application/vnd.atape.session-analytics.v3+json, application/json")
    expect(url.searchParams.has("range")).toBe(false)
    expect(url.searchParams.get("metric")).not.toBe("records")
    await route.fulfill({ json: version === 1 ? analyticsFixture : capabilitiesFixture })
  })
  for (const supported of [1, 2]) {
    version = supported
    await page.goto(path)
    await page.getByRole("button", { name: "Session analysis", exact: true }).click()
    const panel = page.getByRole("region", { name: "Session analysis", exact: true })
    await expect(panel.getByText("This Server does not provide recorded activity yet.", { exact: true })).toBeVisible()
    await expect(panel.getByLabel("Activity thread", { exact: true })).toHaveCount(0)
    await expect(panel.getByLabel("Evidence type", { exact: true }).locator('option[value="records"]')).toHaveCount(0)
    await expect(panel.getByText("Record span", { exact: true })).toHaveCount(0)
    if (version === 2) {
      await expect(panel.getByRole("button", { name: "MCP evidence: repo / lookup", exact: true })).toBeVisible()
      await panel.getByRole("button", { name: "MCP evidence: repo / lookup", exact: true }).click()
      expect(Object.fromEntries(reads.at(-1)!.searchParams)).toMatchObject({ metric: "mcp_tools", server: "repo", capability: "lookup" })
    }
  }
})

test("activity intervals support keyboard activation and a 390px Reader layout without page overflow", async ({ page }) => {
  const api = await activityAPI(page)
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = await openActivity(page)
  const bucket = panel.getByRole("button", { name: bucketName("all", 0), exact: true })
  await panel.getByLabel("Activity thread", { exact: true }).focus()
  await page.keyboard.press("Tab")
  await expect(bucket).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(bucket).toHaveAttribute("aria-pressed", "true")
  await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveCount(2)
  await bucket.focus(); await page.keyboard.press("Space")
  await expect(bucket).toHaveAttribute("aria-pressed", "true")
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(await page.locator(".session-main-reader").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await expect(panel.getByRole("button", { name: /^Show unplaced records/ })).toBeVisible()
  expect(api.violations).toEqual([])
})

test("a hidden pinned Reader auto-refresh cannot leave analysis, and returning revalidates before explicit reload", async ({ page }) => {
  const api = await activityAPI(page)
  let readerMode: "ready" | "changed" = "ready"
  const readerReads = await conditionalActivityReader(page, () => readerMode)
  await page.clock.install()
  await page.goto(`/teams/team-id/projects/project-1/sessions/session-reader?thread=child&snapshot=${activitySnapshot}&head=${activityHead}&event=child-21`)
  await expect(page.locator("#event-child-21")).toBeVisible()
  await page.getByText("More", { exact: true }).click()
  await page.getByLabel("Automatic refresh interval", { exact: true }).selectOption("30_seconds")
  await expect(page.getByLabel("Automatic refresh interval", { exact: true })).toHaveValue("30_seconds")
  await page.clock.runFor(50)
  await page.getByRole("button", { name: "Session analysis", exact: true }).click()
  const panel = page.getByRole("region", { name: "Session analysis", exact: true })
  await expect(panel.getByRole("region", { name: "Recorded activity", exact: true })).toBeVisible()
  readerMode = "changed"
  const beforeTimer = readerReads.length
  // Control only browser time, after choosing the real UI setting. The actual
  // Reader Effect timer and pinned-page restart callback remain in production.
  await page.clock.fastForward(31000)
  await expect(page).toHaveURL(/analysis=open/)
  await expect(page).toHaveURL(/snapshot=activity-snapshot-one/)
  await expect(page).toHaveURL(/head=activity-head-one/)
  await expect(page).toHaveURL(/event=child-21/)
  await expect(panel.getByRole("region", { name: "Recorded activity", exact: true })).toBeVisible()
  expect(readerReads).toHaveLength(beforeTimer)
  await panel.getByRole("button", { name: "Back to conversation", exact: true }).click()
  await expect(page).not.toHaveURL(/analysis=open/)
  await expect(page.getByRole("heading", { name: "Conversation has changed", exact: true })).toBeVisible()
  await expect(page.locator("#event-child-21")).toHaveCount(0)
  await expect.poll(() => readerReads.length).toBeGreaterThan(beforeTimer)
  await page.getByRole("button", { name: "Reload conversation", exact: true }).click()
  await expect(page.getByText("Refreshed Reader after explicit reload", { exact: true })).toBeVisible()
  await expect(page).not.toHaveURL(/snapshot=|head=|event=|analysis=/)
  expect(api.violations).toEqual([])
})

const stableToolAPI = async (page: Page) => {
  const reads: URL[] = [], violations: string[] = []
  let mode: "ready" | "changed" | "replacement" | "denied" = "ready"
  await page.route("**/api/v1/sessions/session-reader/analytics*", async route => {
    const url = new URL(route.request().url()); reads.push(url)
    expect(route.request().headers().accept).toBe("application/vnd.atape.session-analytics.v5+json, application/vnd.atape.session-analytics.v4+json, application/vnd.atape.session-analytics.v3+json, application/json")
    if (mode === "changed") { await route.fulfill({ status: 409, json: { code: "refresh_required", detail: "Changed" } }); return }
    if (mode === "denied") { await route.fulfill({ status: 404, json: { code: "not_found", detail: "Unavailable" } }); return }
    if (mode === "replacement") {
      if (JSON.stringify(Object.fromEntries(url.searchParams)) !== JSON.stringify({ metric: "tools" })) {
        violations.push("A full refresh reused an expired identity selection.")
        await route.fulfill({ status: 422, json: { code: "validation_failed", detail: violations.at(-1) } }); return
      }
      await route.fulfill({ json: { ...stableToolsFixture, snapshot: "snapshot-two", tools: [], evidence: { items: [] } } }); return
    }
    if (url.searchParams.has("tool") && ![executeToolKey, unknownToolKey].includes(url.searchParams.get("tool")!)) {
      violations.push("A native tool selection sent a command title instead of its row key.")
      await route.fulfill({ status: 422, json: { code: "validation_failed", detail: violations.at(-1) } }); return
    }
    const items = stableToolsFixture.evidence.items.filter(item => !url.searchParams.has("thread") || item.threadId === url.searchParams.get("thread"))
    const selected = url.searchParams.get("tool") === unknownToolKey ? [] :
      url.searchParams.has("cursor") ? items.slice(1) : url.searchParams.get("metric") === "failed_tools" ? items.slice(0, 1) : items
    await route.fulfill({ json: { ...stableToolsFixture,
      activity: { ...stableToolsFixture.activity, scopeThreadId: url.searchParams.get("thread") },
      evidence: { items: selected, ...(url.searchParams.has("cursor") || selected.length < 2 ? {} : { nextCursor: "stable-tools-next" }) } } })
  })
  return { reads, violations, mode: (next: typeof mode) => { mode = next } }
}

test("v4 groups different command titles by native tool identity and retains the key through Reader and Back", async ({ page }) => {
  const api = await stableToolAPI(page), readerReads: URL[] = []
  let readerChanged = false
  await page.route("**/api/v1/sessions/session-reader?*", async route => {
    const url = new URL(route.request().url()); readerReads.push(url)
    expect(url.searchParams.has("tool")).toBe(false)
    if (readerChanged && url.searchParams.has("at")) {
      await route.fulfill({ status: 409, json: { code: "refresh_required", detail: "The Reader head changed." } }); return
    }
    const response = await route.fetch({ url: `${url.origin}${url.pathname}?thread=root` }), value = await response.json()
    if (url.searchParams.has("at")) {
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ snapshot: "snapshot-one", head: "head-one", thread: "child", at: "tool-2" })
      value.snapshot = "snapshot-one"; value.head = "head-one"
      value.thread = { id: "child", label: "Captured child", captureStatus: "complete", parentThreadId: "root" }
      value.threadPath = [{ id: "root", label: "Root" }, { id: "child", label: "Captured child" }]
      value.events = [
        { id: "prompt", kind: "message", author: "User", text: "Inspect files", occurredAt: null },
        { id: "tool-2", kind: "tool_result", author: "Codex", toolLabel: "Run rg --files", text: "Captured command evidence", occurredAt: null,
          tool: { sessionUpdate: "tool_call_update", toolCallId: "call-2", title: "Run rg --files", kind: "execute", status: "completed" } }
      ]
    }
    await route.fulfill({ json: value })
  })
  await page.goto(path)
  await page.getByRole("button", { name: "Session analysis", exact: true }).click()
  const panel = page.getByRole("region", { name: "Session analysis", exact: true })
  await expect(panel.getByRole("heading", { name: "Recorded tools", exact: true })).toBeVisible()
  await expect(panel.getByText("Calls with tool identity", { exact: true }).locator("..")).toContainText("2")
  await expect(panel.getByText("Calls without tool identity", { exact: true }).locator("..")).toContainText("1")
  await expect(panel.getByRole("button", { name: "exec_command", exact: true })).toHaveCount(1)
  await panel.getByRole("button", { name: "exec_command", exact: true }).click()
  await expect(panel.getByLabel("Tool name", { exact: true })).toHaveValue(executeToolKey)
  await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveText(["Run pnpm check", "Run rg --files"])
  expect(Object.fromEntries(api.reads.at(-1)!.searchParams)).toMatchObject({ snapshot: "snapshot-one", metric: "tools", tool: executeToolKey })
  await panel.getByRole("button", { name: "Next evidence page", exact: true }).click()
  await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveText(["Run rg --files"])
  expect(api.reads.at(-1)!.searchParams.get("cursor")).toBe("stable-tools-next")
  const link = panel.getByRole("link", { name: "Run rg --files", exact: true })
  await expect(link).toHaveAttribute("href", /snapshot=snapshot-one/)
  await link.click()
  await expect(page.locator("#event-tool-2")).toBeFocused()
  await expect(page.locator(".narrative-activity:has(#event-tool-2)")).toHaveAttribute("open", "")
  await page.goBack()
  await expect(panel.getByLabel("Tool name", { exact: true })).toHaveValue(executeToolKey)
  await expect(panel.getByRole("button", { name: "First evidence page", exact: true })).toBeEnabled()
  await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveText(["Run rg --files"])
  readerChanged = true
  await panel.getByRole("link", { name: "Run rg --files", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Conversation has changed", exact: true })).toBeVisible()
  await expect(page.locator("#event-tool-2")).toHaveCount(0)
  await page.goBack()
  await expect(panel.getByLabel("Tool name", { exact: true })).toHaveValue(executeToolKey)
  await expect(panel.getByRole("button", { name: "First evidence page", exact: true })).toBeEnabled()
  expect(readerReads.some(url => url.searchParams.get("at") === "tool-2")).toBe(true)
  expect(api.violations).toEqual([])
})

test("v4 stale evidence clears identity filters on refresh and denial hides the previous report", async ({ page }) => {
  const api = await stableToolAPI(page)
  await page.goto(path)
  await page.getByRole("button", { name: "Session analysis", exact: true }).click()
  const panel = page.getByRole("region", { name: "Session analysis", exact: true })
  await panel.getByRole("button", { name: "exec_command", exact: true }).click()
  api.mode("changed")
  await panel.getByRole("button", { name: "Next evidence page", exact: true }).click()
  await expect(panel.getByRole("heading", { name: "Conversation has changed", exact: true })).toBeVisible()
  await expect(panel.getByRole("heading", { name: "Recorded tools", exact: true })).toHaveCount(0)
  api.mode("replacement")
  await panel.getByRole("button", { name: "Reload analysis", exact: true }).first().click()
  await expect(panel.getByText("No linked tool calls were captured.", { exact: true })).toBeVisible()
  await expect(panel.getByLabel("Tool name", { exact: true })).toHaveValue("")
  expect(Object.fromEntries(api.reads.at(-1)!.searchParams)).toEqual({ metric: "tools" })
  api.mode("denied")
  await panel.getByRole("button", { name: "Reload analysis", exact: true }).first().click()
  await expect(panel.getByRole("heading", { name: "Analysis is unavailable", exact: true })).toBeVisible()
  await expect(panel.locator(".analytics-summary")).toHaveCount(0)
  expect(api.violations).toEqual([])
})

test("a v3 Server keeps activity and display-label tool filters when it ignores the v4 preference", async ({ page }) => {
  const reads: URL[] = []
  await page.route("**/api/v1/sessions/session-reader/analytics*", async route => {
    const url = new URL(route.request().url()); reads.push(url)
    expect(route.request().headers().accept).toBe("application/vnd.atape.session-analytics.v5+json, application/vnd.atape.session-analytics.v4+json, application/vnd.atape.session-analytics.v3+json, application/json")
    await route.fulfill({ json: activityFixture })
  })
  await page.goto(path)
  await page.getByRole("button", { name: "Session analysis", exact: true }).click()
  const panel = page.getByRole("region", { name: "Session analysis", exact: true })
  await expect(panel.getByRole("region", { name: "Recorded activity", exact: true })).toBeVisible()
  await expect(panel.getByRole("heading", { name: "Tool call labels", exact: true })).toBeVisible()
  await expect(panel.getByText("Calls with tool identity", { exact: true })).toHaveCount(0)
  await panel.getByRole("button", { name: "Read file", exact: true }).click()
  await expect(panel.getByLabel("Tool label", { exact: true })).toHaveValue("Read file")
  expect(Object.fromEntries(reads.at(-1)!.searchParams)).toMatchObject({ metric: "tools", snapshot: "snapshot-one", tool: "Read file" })
})

for (const identityType of ["tool", "skill"] as const) {
  test(`a literal unknown ${identityType} name and a null identity remain distinct v4 selections in Chinese`, async ({ page }) => {
    const fixture = literalUnknownToolFixture(identityType), reads: URL[] = []
    await page.addInitScript(() => window.localStorage.setItem("atape.locale", "zh-CN"))
    await page.route("**/api/v1/sessions/session-reader/analytics*", async route => {
      const url = new URL(route.request().url()); reads.push(url)
      const selected = url.searchParams.get("tool")
      expect(selected === null || selected === executeToolKey || selected === unknownToolKey).toBe(true)
      const items = url.searchParams.get("metric") === "failed_tools" ? [] :
        selected === executeToolKey ? [fixture.evidence.items[0]] : selected === unknownToolKey ? [fixture.evidence.items[1]] : fixture.evidence.items
      await route.fulfill({ json: { ...fixture, evidence: { items } } })
    })
    await page.goto(path)
    await page.getByRole("button", { name: "会话分析", exact: true }).click()
    const panel = page.getByRole("region", { name: "会话分析", exact: true })
    const toolSection = panel.getByRole("heading", { name: "已记录工具", exact: true }).locator("..")
    await expect(toolSection.getByRole("button", { name: "unknown", exact: true })).toHaveCount(1)
    await expect(toolSection.getByRole("button", { name: "未知", exact: true })).toHaveCount(1)
    const dropdown = panel.getByLabel("工具名称", { exact: true })
    await expect(dropdown.locator(`option[value="${executeToolKey}"]`)).toHaveText(`unknown · execute · ${identityType === "tool" ? "工具" : "Skill"}`)
    await expect(dropdown.locator(`option[value="${unknownToolKey}"]`)).toHaveText("未知 · execute · 未知")
    await toolSection.getByRole("button", { name: "unknown", exact: true }).click()
    await expect(dropdown).toHaveValue(executeToolKey)
    await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveText(["Literal unknown native call"])
    expect(reads.at(-1)!.searchParams.get("tool")).toBe(executeToolKey)
    await dropdown.selectOption(unknownToolKey)
    await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveText(["Call without identity"])
    expect(reads.at(-1)!.searchParams.get("tool")).toBe(unknownToolKey)
    await toolSection.getByRole("button", { name: "状态未知调用：unknown", exact: true }).click()
    await expect(dropdown).toHaveValue(executeToolKey)
    expect(Object.fromEntries(reads.at(-1)!.searchParams)).toMatchObject({ metric: "unknown_tools", tool: executeToolKey, snapshot: "snapshot-one" })
    await toolSection.getByRole("button", { name: "失败调用：未知", exact: true }).click()
    await expect(dropdown).toHaveValue(unknownToolKey)
    expect(Object.fromEntries(reads.at(-1)!.searchParams)).toMatchObject({ metric: "failed_tools", tool: unknownToolKey, snapshot: "snapshot-one" })
  })
}
