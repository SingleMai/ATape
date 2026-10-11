import { expect, test } from "@playwright/test"
import { analyticsAccept, corsCookie, historicalAnalyticsCors } from "../test/historicalAnalyticsCors"

type ProbeWindow = Window & {
  activityCorsProbe(): Promise<{ readonly analyticsVersion: number; readonly sessionId: string; readonly snapshot: string }>
  activityCorsNegativeControl(): Promise<string>
}
let fixture: Awaited<ReturnType<typeof historicalAnalyticsCors>>

test.describe("genuine 0.5.9 split-origin analytics compatibility", () => {
  test.describe.configure({ mode: "serial", timeout: 180000 })
  test.beforeAll(async () => { fixture = await historicalAnalyticsCors() })
  test.afterAll(async () => { await fixture?.cleanup() })

  test("the production browser caller sends the standard Accept and cookies, decodes v2, and needs no preflight", async ({ page, context }, testInfo) => {
    await context.addCookies([{ ...corsCookie, url: fixture.apiOrigin, httpOnly: true, sameSite: "Lax" }])
    const start = fixture.requests.length
    await page.goto(fixture.webOrigin)
    await page.waitForFunction(() => typeof (window as ProbeWindow).activityCorsProbe === "function")
    const result = await page.evaluate(() => (window as ProbeWindow).activityCorsProbe())
    expect(result.analyticsVersion).toBe(2)
    expect(result.sessionId).toBe("checkout")
    expect(result.snapshot).not.toBe("")
    expect(result).not.toHaveProperty("activity")
    await expect.poll(() => fixture.requests.slice(start).filter(request => request.method === "GET").length).toBe(1)
    const requests = fixture.requests.slice(start)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ method: "GET", status: 200, origin: fixture.webOrigin, accept: analyticsAccept, cookieMatched: true })
    expect(requests.some(request => request.method === "OPTIONS")).toBe(false)
    await testInfo.attach("genuine-v059-cors-provenance", { body: Buffer.from(JSON.stringify({ ...fixture.proof, requests }, null, 2)), contentType: "application/json" })
  })

  test("native fetch confirms the genuine old CORS rejects the abandoned custom header", async ({ page, context }, testInfo) => {
    await context.addCookies([{ ...corsCookie, url: fixture.apiOrigin, httpOnly: true, sameSite: "Lax" }])
    const start = fixture.requests.length
    await page.goto(fixture.webOrigin)
    await page.waitForFunction(() => typeof (window as ProbeWindow).activityCorsNegativeControl === "function")
    expect(await page.evaluate(() => (window as ProbeWindow).activityCorsNegativeControl())).toBe("cors-rejected")
    await expect.poll(() => fixture.requests.slice(start).length).toBe(1)
    const requests = fixture.requests.slice(start)
    expect(requests[0]).toMatchObject({ method: "OPTIONS", status: 403, origin: fixture.webOrigin,
      requestedHeaders: "atape-accept-analytics-version", cookieMatched: false })
    expect(requests.some(request => request.method === "GET")).toBe(false)
    await testInfo.attach("native-fetch-cors-negative-control", { body: Buffer.from(JSON.stringify({ requests,
      scope: "Native browser CORS control; not the production Gateway Interface" }, null, 2)), contentType: "application/json" })
  })
})
