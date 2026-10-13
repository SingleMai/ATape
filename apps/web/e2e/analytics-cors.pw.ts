import { expect, test } from "@playwright/test"
import { createServer as createHTTPServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer as createViteServer } from "vite"
import { tokenActivityFixture } from "../test/sessionTokenActivityFixture"

test("production analytics negotiation reads across origins without an OPTIONS preflight", async ({ page }) => {
  const requests: Array<{ readonly method: string; readonly accept: string; readonly origin: string }> = []
  let browserOrigin = ""
  const api = createHTTPServer((request, response) => {
    requests.push({ method: request.method ?? "", accept: request.headers.accept ?? "", origin: request.headers.origin ?? "" })
    // This is deliberately as restrictive as the previous Server: no preflight
    // allow-list for Accept. A long unsafe header must fail, not get waived.
    if (request.method !== "GET" || request.url !== "/api/v1/sessions/session-reader/analytics" || request.headers.origin !== browserOrigin) {
      response.writeHead(403); response.end(); return
    }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": browserOrigin, "Access-Control-Allow-Credentials": "true", "Vary": "Origin" })
    response.end(JSON.stringify(tokenActivityFixture))
  })
  const cacheDirectory = await mkdtemp(join(tmpdir(), "atape-analytics-cors-"))
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined
  try {
    await new Promise<void>((resolve, reject) => { api.once("error", reject); api.listen(0, "127.0.0.1", resolve) })
    const apiAddress = api.address()
    if (apiAddress === null || typeof apiAddress === "string") throw new Error("Missing API test listener.")
    const apiOrigin = `http://127.0.0.1:${apiAddress.port}`
    vite = await createViteServer({
      configFile: false, root: fileURLToPath(new URL("..", import.meta.url)), cacheDir: cacheDirectory,
      define: { "import.meta.env.VITE_ATAPE_API_ORIGIN": JSON.stringify(apiOrigin) },
      server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
      plugins: [{ name: "analytics-cors-test-page", configureServer(server) {
        server.middlewares.use("/__analytics-cors-probe", (_request, response) => {
          response.setHeader("Content-Type", "text/html")
          response.end('<!doctype html><title>Analytics CORS probe</title><script type="module">window.analyticsProbe = import("/e2e/analytics-cors-probe.ts").then(module => module.readAnalyticsAcrossOrigins());</script>')
        })
      } }]
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    if (address === null || address === undefined || typeof address === "string") throw new Error("Missing browser test listener.")
    browserOrigin = `http://127.0.0.1:${address.port}`
    expect(browserOrigin).not.toBe(apiOrigin)
    await page.goto(`${browserOrigin}/__analytics-cors-probe`)
    await page.waitForFunction(() => "analyticsProbe" in window)
    const report = await page.evaluate(async () => await (window as typeof window & { analyticsProbe: Promise<unknown> }).analyticsProbe)
    expect(report).toMatchObject({ analyticsVersion: 5, sessionId: "session-reader", tokenActivity: { samples: 4 } })
    expect(requests).toEqual([{ method: "GET", origin: browserOrigin,
      accept: "application/vnd.atape.session-analytics.v4+json;v=5, application/vnd.atape.session-analytics.v3+json, application/json" }])
    expect(Buffer.byteLength(requests[0]!.accept)).toBeLessThanOrEqual(128)
  } finally {
    await vite?.close()
    await new Promise<void>(resolve => { api.close(() => resolve()); api.closeAllConnections() })
    await rm(cacheDirectory, { recursive: true, force: true })
  }
})
