import { expect, test, type Locator, type Page } from "@playwright/test"

const providers = ["Codex", "Claude Code", "codebuddy-code", "grok-build", "kimi-code", "OpenCode", "Private Agent"]
const labels = ["Codex", "Claude Code", "WorkBuddy", "Grok", "Kimi Code", "OpenCode", "Private Agent"]
const assets = ["codex", "claude-code", "workbuddy", "grok", "kimi-code"]
const projectPath = "/teams/team-id/projects/project-1"

test.beforeEach(async ({ page, context, request }) => {
  await request.post("http://127.0.0.1:8080/__fixture/reset")
  await context.addCookies([{ name: "fixture_session", value: "1", url: "http://127.0.0.1:4187" }])
  await page.route("**/api/v1/teams/team-id/overview**", async route => {
    const response = await route.fetch(), data = await response.json()
    data.sessions = providers.map((agent, i) => ({ ...data.sessions[i], agent }))
    await route.fulfill({ response, json: data })
  })
  await page.route("**/api/v1/projects/project-1/memory", async route => {
    const response = await route.fetch(), data = await response.json()
    const session = [...data.active, ...data.trail][0]
    data.active = []
    data.trail = providers.map((harness, i) => ({ ...session, id: `identity-${i}`, title: `Identity ${i}`,
      actor: { ...session.actor, harness } }))
    await route.fulfill({ response, json: data })
  })
})

const expectFamily = async (identities: Locator) => {
  await expect(identities).toHaveCount(providers.length)
  for (const [i, label] of labels.entries()) {
    const identity = identities.nth(i)
    if (i < assets.length) {
      const image = identity.locator("img")
      await expect(image).toHaveAttribute("src", `/agents/${assets[i]}.svg`)
      await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
    } else {
      await expect(identity).toHaveText(label)
      await expect(identity.locator("img")).toHaveCount(0)
    }
  }
}

const expectFits = async (page: Page) => {
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  }
}

test("uses one identity across overview, project, search and reader without rewriting authors", async ({ page }, testInfo) => {
  await page.goto("/teams/team-id")
  await expectFamily(page.locator(".overview-session header .atape-agent-identity"))
  await expect(page.locator(".overview-session-meta").nth(2)).toContainText("WorkBuddy")
  await expectFits(page)
  await page.screenshot({ path: testInfo.outputPath("overview-agents.png"), fullPage: true })

  await page.goto(projectPath)
  await expectFamily(page.locator(".trail-item .atape-agent-identity"))
  await expect(page.locator(".conversation-status-dot")).toHaveCount(providers.length)
  await expectFits(page)
  await page.screenshot({ path: testInfo.outputPath("project-agents.png"), fullPage: true })

  await page.route("**/api/v1/projects/*/search?*", async route => {
    const url = new URL(route.request().url())
    await route.fulfill({ json: { projectId: "project-1", query: url.searchParams.get("q"), results: providers.map((harness, i) => ({
      eventId: `result-${i}`, sessionId: "session-reader", sessionTitle: `Identity result ${i}`, threadId: "root",
      threadPath: [{ id: "root", label: "Root" }], author: "Original Author", harness,
      occurredAt: "2026-09-05T00:00:04Z", text: "Identity search match"
    })) } })
  })
  await page.getByRole("button", { name: "Search all conversations" }).click()
  await page.getByRole("searchbox", { name: "Search conversations" }).fill("identity")
  await expectFamily(page.locator(".global-result .atape-agent-identity"))
  await expectFits(page)
  await page.screenshot({ path: testInfo.outputPath("search-agents.png"), fullPage: true })

  await page.route("**/api/v1/sessions/session-reader?*", async route => {
    const response = await route.fetch(), data = await response.json()
    data.session.actor.harness = "codebuddy-code"
    data.session.capturedBy = { id: "owner", displayName: "Original Owner", avatarUrl: "" }
    await route.fulfill({ response, json: data })
  })
  await page.locator(".global-result").nth(2).click()
  const identity = page.locator(".reader-user .atape-agent-identity")
  await expect(identity).toHaveText("WorkBuddy")
  await expect(identity.locator("img")).toHaveAttribute("src", "/agents/workbuddy.svg")
  await expect(page.locator(".reader-user")).toContainText("Original Owner")
  await expect(page.locator(".message-metadata").first()).toContainText("User")
  await expectFits(page)
  await page.screenshot({ path: testInfo.outputPath("reader-agent.png"), fullPage: true })
})

test("keeps the provider name when its image fails and loads a different provider after refresh", async ({ page }) => {
  await page.route("**/agents/workbuddy.svg", route => route.abort())
  await page.goto("/teams/team-id")
  const identity = page.locator(".overview-session header .atape-agent-identity").nth(2)
  await expect(identity).toHaveText("WorkBuddy")
  await expect(identity.locator("img")).toHaveCount(0)
  await page.route("**/api/v1/teams/team-id/overview**", async route => {
    const response = await route.fetch(), data = await response.json()
    data.sessions[2].agent = "kimi-code"
    await route.fulfill({ response, json: data })
  })
  await page.getByRole("button", { name: "Refresh", exact: true }).click()
  await expect(identity.locator("img")).toHaveAttribute("alt", "Kimi Code")
  await expect.poll(() => identity.locator("img").evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
})
