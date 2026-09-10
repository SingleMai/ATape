import { expect, test } from "@playwright/test"

const path = "/teams/team-id/projects/project-1/sessions/session-reader?thread=root"

test("pages keep one head, retain browser navigation, and refresh explicitly after replacement", async ({ context, page, request }) => {
  await request.post("http://127.0.0.1:8080/__fixture/reset")
  await context.addCookies([{ name: "fixture_session", value: "1", url: "http://127.0.0.1:4187" }])
  let head = "first-head"
  const reads: URL[] = []
  await page.route("**/api/v1/sessions/session-reader?*", async route => {
    const url = new URL(route.request().url()); reads.push(url)
    expect(url.searchParams.get("limit")).toBe("100")
    if (head === "retry-failure") {
      await route.fulfill({ status: 503, json: { code: "service_unavailable", detail: "Temporary failure." } })
      return
    }
    if (head === "network-failure") { await route.abort(); return }
    if (head === "revoked") {
      await route.fulfill({ status: 404, json: { code: "not_found", detail: "This conversation is unavailable." } })
      return
    }
    if (url.searchParams.has("head") && url.searchParams.get("head") !== head) {
      await route.fulfill({ status: 409, json: { code: "refresh_required", detail: "The conversation changed. Reload it before continuing." } })
      return
    }
    const response = await route.fetch(); const value = await response.json()
    const start = url.searchParams.has("after") ? Number(url.searchParams.get("after")!.slice(6)) + 1
      : url.searchParams.has("at") ? Number(url.searchParams.get("at")!.slice(6)) : 0
    const end = head === "first-head" ? Math.min(start + 100, 201) : 1
    value.head = head
    if (end < 201 && head === "first-head") value.nextEventId = `event-${end - 1}`
    value.events = Array.from({ length: end - start }, (_, index) => ({
      id: `event-${start + index}`, kind: "message", author: "User", occurredAt: "2026-09-05T00:00:01Z",
      text: head === "first-head" ? `Published message ${start + index}` : "Replacement conversation"
    }))
    await route.fulfill({ json: value })
  })
  await page.goto(path)
  await expect(page.locator("#event-event-0")).toBeVisible()
  await page.getByRole("button", { name: "Next page", exact: true }).click()
  await expect(page.locator("#event-event-100")).toBeVisible()
  await expect(page.locator("#event-event-0")).toHaveCount(0)
  expect(reads.at(-1)!.searchParams.get("head")).toBe("first-head")
  expect(reads.at(-1)!.searchParams.get("after")).toBe("event-99")
  await page.goBack()
  await expect(page.locator("#event-event-0")).toBeVisible()
  await page.goForward()
  await expect(page.locator("#event-event-100")).toBeVisible()
  head = "replacement-head"
  await page.getByRole("button", { name: "Next page", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Conversation has changed" })).toBeVisible()
  await expect(page.locator("#event-event-100")).toHaveCount(0)
  await page.getByRole("button", { name: "Reload conversation", exact: true }).click()
  await expect(page.getByText("Replacement conversation", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toHaveCount(0)
  await expect(page).not.toHaveURL(/head=|after=/)
  head = "revoked"
  await page.locator(".refresh-now").evaluate((el: HTMLButtonElement) => el.click())
  await expect(page.getByRole("heading", { name: "Conversation is unavailable" })).toBeVisible()
  await expect(page.getByText("Replacement conversation", { exact: true })).toHaveCount(0)
  for (const failure of ["retry-failure", "network-failure"]) {
    head = failure
    await page.getByRole("button", { name: "Try again", exact: true }).click()
    await expect(page.getByText(failure === "retry-failure" ? "Temporary failure." : "The ATape server is unavailable.", { exact: true })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Conversation is unavailable" })).toBeVisible()
    await expect(page.getByText("Replacement conversation", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeEnabled()
  }
  head = "replacement-head"
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(page.getByText("Replacement conversation", { exact: true })).toBeVisible()
})

test("search can open a later event directly and return to the beginning", async ({ context, page, request }) => {
  await request.post("http://127.0.0.1:8080/__fixture/reset")
  await context.addCookies([{ name: "fixture_session", value: "1", url: "http://127.0.0.1:4187" }])
  const anchors: Array<string | null> = []
  await page.route("**/api/v1/sessions/session-reader?*", async route => {
    const at = new URL(route.request().url()).searchParams.get("at"); anchors.push(at)
    const response = await route.fetch(); const value = await response.json()
    value.head = "search-head"
    value.events = [{ id: at ?? "beginning", kind: "message", author: "User", occurredAt: "2026-09-05T00:00:01Z", text: at ? "Later matching message" : "Beginning of conversation" }]
    await route.fulfill({ json: value })
  })
  await page.goto(`${path}&event=event-180&from=search&q=matching`)
  await expect(page.locator("#event-event-180")).toBeFocused()
  expect(anchors[0]).toBe("event-180")
  await page.getByRole("button", { name: "Read from the beginning" }).click()
  await expect(page.getByText("Beginning of conversation", { exact: true })).toBeVisible()
  expect(anchors.at(-1)).toBeNull()
})
