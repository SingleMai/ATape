import { expect, test } from "@playwright/test"

const path = "/teams/team-id/projects/project-1/sessions/session-reader?thread=root"

test("Raw pages load on demand, replace objects, and retain browser navigation", async ({ context, page, request }) => {
  await request.post("http://127.0.0.1:8080/__fixture/reset")
  await context.addCookies([{ name: "fixture_session", value: "1", url: "http://127.0.0.1:4187" }])
  const reads: string[] = []
  await page.route("**/api/v1/sessions/session-reader/raw?*", async route => {
    const url = new URL(route.request().url())
    expect(url.searchParams.get("limit")).toBe("50")
    const second = url.searchParams.has("cursor")
    reads.push(second ? "second" : "first")
    await route.fulfill({ json: { sessionId: "session-reader", objects: Array.from({ length: second ? 1 : 50 }, (_, n) => ({
      objectId: `raw-${second ? 50 : n}`, projectId: "project-1", sessionId: "session-reader", sourceName: `Source ${second ? 50 : n}`,
      mediaType: "text/plain", adapterId: "opencode", adapterVersion: "1", capturedAt: "2026-09-11T00:00:00Z", clientRedacted: true,
      currentGeneration: 1, generationCount: 1, currentSizeBytes: 4, currentFinalized: true
    })), ...(second ? {} : { nextCursor: "next-manifest-page" }) } })
  })
  await page.route("**/api/v1/raw-objects/*/content?*", async route => {
    const url = new URL(route.request().url())
    expect(url.searchParams.get("limit")).toBe("1")
    const objectId = url.pathname.split("/")[4]!
    const bytes = objectId === "raw-0" ? Buffer.alloc(3 * 1024 * 1024, "x") : Buffer.from(`Bytes for ${objectId}`)
    await route.fulfill({ json: { objectId, generation: 1, sizeBytes: bytes.length, finalized: true,
      chunks: [{ offset: 0, sizeBytes: bytes.length, sha256: "hash", contentBase64: bytes.toString("base64") }] } })
  })
  await page.goto(path)
  await expect(page.getByRole("heading", { name: "Conversation hierarchy", exact: true })).toBeVisible()
  expect(reads).toEqual([])
  await page.getByText("More", { exact: true }).click()
  await page.getByRole("button", { name: "View Raw source", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Raw source" })
  await expect.poll(() => dialog.locator(".raw-code").evaluateAll(elements => elements[0]?.textContent?.length ?? 0)).toBe(3 * 1024 * 1024)
  await dialog.getByRole("button", { name: "Source 10", exact: true }).click()
  await expect(dialog.locator(".raw-code")).toHaveText("Bytes for raw-10")
  await dialog.getByRole("button", { name: "Next sources", exact: true }).click()
  await expect(dialog.locator(".raw-code")).toHaveText("Bytes for raw-50")
  await expect(dialog.getByRole("button", { name: "Source 10", exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(/rawCursor=next-manifest-page/)
  await page.goBack()
  await expect(page).toHaveURL(/raw=open/ )
  await expect.poll(() => dialog.locator(".raw-code").evaluateAll(elements => elements[0]?.textContent?.length ?? 0)).toBe(3 * 1024 * 1024)
  await page.goForward()
  await expect(dialog.locator(".raw-code")).toHaveText("Bytes for raw-50")
  await dialog.getByRole("button", { name: "First sources", exact: true }).click()
  await expect(page).not.toHaveURL(/rawCursor=/)
  await expect(dialog.getByRole("button", { name: "Source 10", exact: true })).toBeVisible()
  await dialog.getByRole("button", { name: "Close Raw source", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page).not.toHaveURL(/raw=open|rawCursor=/)
})
