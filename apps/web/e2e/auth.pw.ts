import { expect, test, type BrowserContext, type Page } from "@playwright/test"

// These full-browser tests intentionally use a .pw.ts suffix so the unit-test
// runner never evaluates Playwright's global lifecycle hooks.

const fixtureOrigin = "http://127.0.0.1:8080"
const appOrigin = "http://127.0.0.1:4187"

const authenticate = (context: BrowserContext) => context.addCookies([{
  name: "fixture_session",
  value: "1",
  url: appOrigin
}])

const fixtureState = async (page: Page) => page.request.get(`${fixtureOrigin}/__fixture/state`).then((response) => response.json())

const clientNavigate = (page: Page, path: string) => page.evaluate((target) => {
  history.pushState({}, "", target)
  window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }))
}, path)

const expectNoBrowserSecrets = async (page: Page) => {
  const result = await page.evaluate(() => ({
    html: document.documentElement.innerHTML,
    localKeys: Object.keys(localStorage),
    sessionKeys: Object.keys(sessionStorage),
    href: location.href
  }))
  expect(result.html).not.toMatch(/csrf-fixture|grant-view-one|atc_v1_|credential-secret/)
  expect(result.href).not.toMatch(/csrf-fixture|grant-view-one|atc_v1_|credential-secret/)
  expect(result.localKeys).toEqual([])
  expect(result.sessionKeys).toEqual([])
}

test.beforeEach(async ({ context, request }) => {
  await request.post(`${fixtureOrigin}/__fixture/reset`)
  await context.clearCookies()
})

test("redirects a signed-out landing visit with a bounded return path", async ({ page }) => {
  await page.goto("/")

  await expect(page.getByRole("heading", { name: "Sign in to ATape" })).toBeVisible()
  await expect(page.getByText("Your previous session ended. Sign in again to continue.")).toBeVisible()
  const location = new URL(page.url())
  expect(location.pathname).toBe("/auth/sign-in")
  expect(location.searchParams.get("returnTo")).toBe("/")
  expect(location.searchParams.get("reason")).toBe("session_ended")
})

test("keeps ordinary and CLI-return sign-in minimal at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/auth/sign-in")

  await expect(page.getByRole("heading", { name: "Sign in to ATape" })).toBeVisible()
  const provider = page.getByRole("button", { name: "Continue with GitHub" })
  await expect(provider).toBeVisible()
  expect((await provider.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await expect(page.getByText("Team permissions")).toHaveCount(0)
  await expect(page.locator("body")).not.toContainText("OAuth")
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await expectNoBrowserSecrets(page)

  await page.goto("/cli/authorize?user_code=Q7KM4W")
  await expect(page.getByText("CLI sign-in in progress")).toBeVisible()
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible()
  expect((await fixtureState(page)).cliResolveCount).toBe(0)
})

test("requires an explicit CLI decision and renders terminal outcomes", async ({ context, page, request }) => {
  await authenticate(context)
  await page.goto("/cli/authorize?user_code=Q7KM4W")

  await expect(page.getByRole("heading", { name: /Allow atape-cli/ })).toBeVisible()
  await expect(page.getByText("Q7KM4W")).toBeVisible()
  await expect(page.getByText(appOrigin)).toBeVisible()
  await expect(page.locator(".request-facts dd").filter({ hasText: "Mai" })).toBeVisible()
  expect((await fixtureState(page)).cliDecision).toBe("none")
  await expectNoBrowserSecrets(page)

  await page.getByRole("button", { name: "Authorize CLI" }).click()
  await expect(page.getByRole("heading", { name: "The CLI is connected" })).toBeVisible()
  expect((await fixtureState(page)).cliDecision).toBe("approve")
  await expect(page.getByRole("button", { name: "Authorize CLI" })).toHaveCount(0)
  await expectNoBrowserSecrets(page)

  await request.post(`${fixtureOrigin}/__fixture/reset`)
  await clientNavigate(page, "/cli/authorize?user_code=AAAAAA")
  await expect(page.getByRole("heading", { name: "This code is no longer valid" })).toBeVisible()

  await request.post(`${fixtureOrigin}/__fixture/reset`)
  await clientNavigate(page, "/cli/authorize?user_code=Q7KM4W")
  await expect(page.getByRole("heading", { name: /Allow atape-cli/ })).toBeVisible()
  await page.getByRole("button", { name: "Deny" }).click()
  await expect(page.getByRole("heading", { name: "The CLI was not connected" })).toBeVisible()
  expect((await fixtureState(page)).cliDecision).toBe("deny")
})

test("recovers account sections independently and keyboard-confirms revocation", async ({ context, page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await authenticate(context)
  await page.goto("/settings/account")

  await expect(page.getByRole("heading", { name: "Account security" })).toBeVisible()
  await expect(page.getByText("singlemai")).toBeVisible()
  await expect(page.getByText("2 active")).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)

  await request.post(`${fixtureOrigin}/__fixture/fail-sessions?value=1`)
  await page.reload()
  const sessions = page.getByRole("region", { name: "Browser sessions" })
  await expect(sessions.getByRole("alert")).toBeVisible()
  await expect(sessions.getByRole("button", { name: "Try again" })).toBeVisible()
  await expect(page.getByText("singlemai")).toBeVisible()
  await expect(page.getByText("atape-cli")).toBeVisible()

  await request.post(`${fixtureOrigin}/__fixture/fail-sessions?value=0`)
  await sessions.getByRole("button", { name: "Try again" }).click()
  await expect(sessions.getByText("2 active")).toBeVisible()

  const otherSession = sessions.locator(".settings-row").filter({ hasText: "Browser session" }).filter({ hasNotText: "This browser session" })
  await otherSession.getByRole("button", { name: "Revoke" }).click()
  const dialog = page.getByRole("dialog", { name: "Revoke this browser session?" })
  await expect(dialog).toBeVisible()
  await expect(page.locator(":focus")).toHaveText("Cancel")
  await page.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible()
  expect((await fixtureState(page)).webSessions).toHaveLength(2)

  await otherSession.getByRole("button", { name: "Revoke" }).click()
  await page.keyboard.press("Tab")
  await expect(page.locator(":focus")).toHaveText("Revoke session")
  await page.keyboard.press("Enter")
  await expect(dialog).not.toBeVisible()
  await expect(sessions.getByText("1 active")).toBeVisible()
  expect((await fixtureState(page)).webSessions).toEqual(["session-current"])
  await expectNoBrowserSecrets(page)
})

test("recovers fresh authentication and scopes one-time Team codes locally", async ({ context, page, request }) => {
  await authenticate(context)
  await page.goto("/teams/team-a/settings/access")

  await expect(page.getByText("You are the only Owner.")).toBeVisible()
  await expect(page.getByText("K7M4PX")).toHaveCount(0)
  await page.getByRole("button", { name: "Rotate" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Rotate code" }).click()
  await expect(page.getByRole("alert")).toContainText("Confirm your sign-in")
  await expect(page.getByRole("button", { name: "Confirm sign-in" })).toBeVisible()
  expect(page.url()).toBe(`${appOrigin}/teams/team-a/settings/access`)

  await request.post(`${fixtureOrigin}/__fixture/fresh?value=1`)
  await page.getByRole("button", { name: "Rotate" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Rotate code" }).click()
  await expect(page.getByText("K7M4PX")).toBeVisible()
  await expect(page.getByText("Copy this now.")).toBeVisible()
  expect(page.url()).not.toContain("K7M4PX")
  expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)])).not.toContain("K7M4PX")

  await clientNavigate(page, "/settings/account")
  await expect(page.getByRole("heading", { name: "Account security" })).toBeVisible()
  await clientNavigate(page, "/teams/team-a/settings/access")
  await expect(page.getByText("K7M4PX")).toHaveCount(0)
})

test("normalizes first-Team create and join input through the same Web Interface", async ({ context, page }) => {
  await authenticate(context)
  await page.goto("/onboarding")
  await expect(page.getByRole("link", { name: "Create a Team" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Join a Team" })).toBeVisible()

  await page.goto("/onboarding/join-team")
  const joinCode = page.getByLabel("Team join code")
  await joinCode.fill("k7m 4px")
  await expect(joinCode).toHaveValue("K7M4PX")
  await page.getByRole("button", { name: "Join Team" }).click()
  await expect.poll(async () => (await fixtureState(page)).teamJoinBody).toEqual({ joinCode: "K7M4PX" })

  await page.goto("/onboarding/create-team")
  await page.getByLabel("Team name").fill("Tape Makers")
  await expect(page.getByLabel("Web address")).toHaveValue("tape-makers")
  await page.getByRole("button", { name: "Create Team" }).click()
  await expect.poll(async () => (await fixtureState(page)).teamCreateBody).toEqual({
    slug: "tape-makers",
    displayName: "Tape Makers"
  })
  expect((await fixtureState(page)).teamCreateIdempotencyKey).toMatch(/^[A-Za-z0-9_-]{22}$/)
})
