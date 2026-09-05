import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? "line" : "list",
  outputDir: "../../test-results/web",
  use: {
    baseURL: "http://127.0.0.1:4187",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [{
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      ...(process.env.CI ? {} : { channel: "chrome" as const })
    }
  }],
  webServer: [
    {
      command: "node e2e/fixture-server.mjs",
      url: "http://127.0.0.1:8080/healthz",
      reuseExistingServer: false,
      timeout: 15_000
    },
    {
      command: "pnpm exec vite --host 127.0.0.1 --port 4187 --strictPort",
      url: "http://127.0.0.1:4187/auth/sign-in",
      reuseExistingServer: false,
      timeout: 15_000
    }
  ]
})
