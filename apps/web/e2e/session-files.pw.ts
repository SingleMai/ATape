import { expect, test, type Page } from "@playwright/test"
import { activityFixture, analyticsFixture, capabilitiesFixture, fileActivityFixture, searchScopeKey, sourceFileKey, stableToolsFixture } from "../test/sessionAnalyticsFixture"

const path = "/teams/team-id/projects/project-1/sessions/session-reader?thread=root"
test.beforeEach(async ({ context, request }) => {
  await request.post("http://127.0.0.1:8080/__fixture/reset")
  await context.addCookies([{ name: "fixture_session", value: "1", url: "http://127.0.0.1:4187" }])
})

// Only the owned HTTP Seam is substituted. Application selection, Browser
// decoding, Effect state, View and conditional Reader navigation remain real.
const fileAPI = async (page: Page) => {
  const reads: URL[] = [], violations: string[] = []
  let mode: "ready" | "changed" | "replacement" | "denied" = "ready"
  await page.route("**/api/v1/sessions/session-reader/analytics*", async route => {
    const url = new URL(route.request().url()), query = url.searchParams; reads.push(url)
    expect(route.request().headers().accept).toBe("application/vnd.atape.session-analytics.v4+json;v=5, application/vnd.atape.session-analytics.v3+json, application/json")
    if (mode === "changed") { await route.fulfill({ status: 409, json: { code: "refresh_required", detail: "Changed" } }); return }
    if (mode === "denied") { await route.fulfill({ status: 404, json: { code: "not_found", detail: "Unavailable" } }); return }
    if (mode === "replacement") {
      if (JSON.stringify(Object.fromEntries(query)) !== JSON.stringify({ metric: "tools" })) {
        violations.push("Refresh retained a removed file, operation, range, Thread or cursor.")
        await route.fulfill({ status: 422, json: { code: "validation_failed", detail: violations.at(-1) } }); return
      }
      await route.fulfill({ json: { ...stableToolsFixture, snapshot: "snapshot-two", evidence: { items: [] } } }); return
    }
    if (query.get("metric") === "files") {
      if (["tool", "capability", "server", "range"].some(key => query.has(key)) ||
        (query.has("file") && ![sourceFileKey, searchScopeKey].includes(query.get("file")!))) {
        violations.push("File selection sent an incompatible filter or a display path.")
        await route.fulfill({ status: 422, json: { code: "validation_failed", detail: violations.at(-1) } }); return
      }
    }
    const selected = fileActivityFixture.evidence.items.filter(item => {
      if (query.has("thread") && query.get("thread") !== item.threadId) return false
      if (query.get("metric") !== "files") return false
      const file = item.eventId === "file-search" ? searchScopeKey : sourceFileKey
      const operations = item.eventId === "file-search" ? ["search"] : item.eventId === "file-edit" ? ["read", "edit"] : ["read"]
      return (!query.has("file") || query.get("file") === file) && (!query.has("operation") || operations.includes(query.get("operation")!))
    })
    const items = query.has("cursor") ? selected.slice(1) : selected.slice(0, 1)
    await route.fulfill({ json: { ...fileActivityFixture,
      activity: { ...fileActivityFixture.activity, scopeThreadId: query.get("thread") },
      evidence: { items, ...(!query.has("cursor") && selected.length > 1 ? { nextCursor: "file-evidence-next" } : {}) } } })
  })
  return { reads, violations, mode: (next: typeof mode) => { mode = next } }
}

const openFiles = async (page: Page) => {
  await page.goto(path)
  await page.getByRole("button", { name: "Session analysis", exact: true }).click()
  return page.getByRole("region", { name: "Session analysis", exact: true })
}

test("file path and operation select their intersection and retain snapshot, Thread and page through Reader and Back", async ({ page }) => {
  const api = await fileAPI(page), readerReads: URL[] = []
  let readerChanged = false
  await page.route("**/api/v1/sessions/session-reader?*", async route => {
    const url = new URL(route.request().url()); readerReads.push(url)
    expect(url.searchParams.has("file")).toBe(false)
    expect(url.searchParams.has("operation")).toBe(false)
    if (readerChanged && url.searchParams.has("at")) {
      await route.fulfill({ status: 409, json: { code: "refresh_required", detail: "The Reader head changed." } }); return
    }
    const response = await route.fetch({ url: `${url.origin}${url.pathname}?thread=root` }), value = await response.json()
    if (url.searchParams.has("at")) {
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ snapshot: "snapshot-one", head: "head-one", thread: "child", at: "file-edit" })
      value.snapshot = "snapshot-one"; value.head = "head-one"
      value.thread = { id: "child", label: "Captured child", captureStatus: "complete", parentThreadId: "root" }
      value.threadPath = [{ id: "root", label: "Root" }, { id: "child", label: "Captured child" }]
      value.events = [{ id: "file-edit", kind: "tool_result", author: "Agent", text: "The recorded file modification failed", occurredAt: null,
        tool: { sessionUpdate: "tool_call_update", toolCallId: "call-edit", title: "Failed file modification", kind: "edit", status: "failed" } }]
    }
    await route.fulfill({ json: value })
  })
  const panel = await openFiles(page)
  const files = panel.getByRole("region", { name: "Recorded file activity", exact: true })
  await expect(files.getByText("Calls with usable file activity", { exact: true }).locator("..")).toContainText("3")
  await expect(files.getByText("Calls without usable file activity", { exact: true }).locator("..")).toContainText("2")
  await panel.getByRole("button", { name: "Show 4 records from 2026-10-12T00:00:00Z to 2026-10-12T00:01:00Z", exact: true }).click()
  expect(api.reads.at(-1)!.searchParams.has("range")).toBe(true)
  await files.getByRole("button", { name: "File evidence: Read calls · /work/src/app.ts", exact: true }).click()
  await panel.getByLabel("Thread", { exact: true }).selectOption("child")
  await expect(panel.getByLabel("Path", { exact: true })).toHaveValue(sourceFileKey)
  await expect(panel.getByLabel("File operation", { exact: true })).toHaveValue("read")
  await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveText(["Read source file"])
  expect(Object.fromEntries(api.reads.at(-1)!.searchParams)).toEqual({ metric: "files", snapshot: "snapshot-one", thread: "child", file: sourceFileKey, operation: "read" })
  await panel.getByRole("button", { name: "Next evidence page", exact: true }).click()
  await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveText(["Failed file modification"])
  expect(api.reads.at(-1)!.searchParams.get("cursor")).toBe("file-evidence-next")
  await panel.getByRole("link", { name: "Failed file modification", exact: true }).click()
  await expect(page.locator("#event-file-edit")).toBeFocused()
  await page.goBack()
  await expect(panel.getByLabel("Path", { exact: true })).toHaveValue(sourceFileKey)
  await expect(panel.getByLabel("File operation", { exact: true })).toHaveValue("read")
  await expect(panel.getByRole("button", { name: "First evidence page", exact: true })).toBeEnabled()
  readerChanged = true
  await panel.getByRole("link", { name: "Failed file modification", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Conversation has changed", exact: true })).toBeVisible()
  await expect(page.locator("#event-file-edit")).toHaveCount(0)
  await page.goBack()
  await panel.getByLabel("File operation", { exact: true }).selectOption("edit")
  await expect(panel.getByRole("button", { name: "First evidence page", exact: true })).toBeDisabled()
  expect(api.reads.at(-1)!.searchParams.has("cursor")).toBe(false)
  await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveText(["Failed file modification"])
  await panel.getByLabel("File operation", { exact: true }).selectOption("search")
  await expect(panel.getByText("No evidence matches these filters.", { exact: true })).toBeVisible()
  await panel.getByLabel("Thread", { exact: true }).selectOption("")
  await panel.getByLabel("Path", { exact: true }).selectOption(searchScopeKey)
  await expect(panel.locator(".analytics-evidence-list").getByRole("link")).toHaveText(["Search source scope"])
  await expect(files.getByText("Distinct recorded paths", { exact: true }).locator("..")).toContainText("2")
  await panel.getByLabel("Evidence type", { exact: true }).selectOption("thoughts")
  expect(api.reads.at(-1)!.searchParams.has("file")).toBe(false)
  expect(api.reads.at(-1)!.searchParams.has("operation")).toBe(false)
  expect(readerReads.some(url => url.searchParams.get("at") === "file-edit")).toBe(true)
  expect(api.violations).toEqual([])
})

test("stale file evidence requires refresh, clears removed filters and hides prior paths after authorization denial", async ({ page }) => {
  const api = await fileAPI(page), panel = await openFiles(page)
  await panel.getByRole("button", { name: "File evidence: Read calls · /work/src/app.ts", exact: true }).click()
  api.mode("changed")
  await panel.getByRole("button", { name: "Next evidence page", exact: true }).click()
  await expect(panel.getByRole("heading", { name: "Conversation has changed", exact: true })).toBeVisible()
  await expect(panel.getByRole("region", { name: "Recorded file activity", exact: true })).toHaveCount(0)
  api.mode("replacement")
  await panel.getByRole("button", { name: "Reload analysis", exact: true }).first().click()
  await expect(panel.getByText("No usable file paths were recorded.", { exact: true })).toBeVisible()
  expect(Object.fromEntries(api.reads.at(-1)!.searchParams)).toEqual({ metric: "tools" })
  await expect(panel.getByLabel("Evidence type", { exact: true })).toHaveValue("tools")
  await expect(panel.getByLabel("Path", { exact: true })).toHaveCount(0)
  api.mode("denied")
  await panel.getByRole("button", { name: "Reload analysis", exact: true }).first().click()
  await expect(panel.getByRole("heading", { name: "Analysis is unavailable", exact: true })).toBeVisible()
  await expect(panel.getByRole("region", { name: "Recorded file activity", exact: true })).toHaveCount(0)
  await expect(panel.getByText("/work/src/app.ts", { exact: true })).toHaveCount(0)
  expect(api.violations).toEqual([])
})

test("v1 to v3 Server fallbacks disclose file activity unavailable without synthetic zeros or new filters", async ({ page }) => {
  let version = 1
  await page.route("**/api/v1/sessions/session-reader/analytics*", async route => {
    const query = new URL(route.request().url()).searchParams
    expect(query.get("metric")).not.toBe("files")
    expect(query.has("file") || query.has("operation")).toBe(false)
    await route.fulfill({ json: version === 1 ? analyticsFixture : version === 2 ? capabilitiesFixture : activityFixture })
  })
  for (const supported of [1, 2, 3]) {
    version = supported
    const panel = await openFiles(page)
    await expect(panel.getByText("This Server does not provide file activity yet.", { exact: true })).toBeVisible()
    await expect(panel.getByLabel("Evidence type", { exact: true }).locator('option[value="files"]')).toHaveCount(0)
    await expect(panel.getByText("Calls with usable file activity", { exact: true })).toHaveCount(0)
    await expect(panel.getByLabel("File operation", { exact: true })).toHaveCount(0)
  }
})

test("an empty v4 file report preserves calls without usable paths and works at 390px", async ({ page }) => {
  await page.route("**/api/v1/sessions/session-reader/analytics*", route => route.fulfill({ json: stableToolsFixture }))
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = await openFiles(page), files = panel.getByRole("region", { name: "Recorded file activity", exact: true })
  await expect(files.getByText("No usable file paths were recorded.", { exact: true })).toBeVisible()
  await expect(files.getByText("Calls with usable file activity", { exact: true }).locator("..")).toContainText("0")
  await expect(files.getByText("Calls without usable file activity", { exact: true }).locator("..")).toContainText("3")
  await expect(files.getByText("This Server does not provide file activity yet.", { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
