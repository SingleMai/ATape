import { describe, expect, it } from "vitest"
import type { CLICredential } from "@atape/domain"
import { presentCLIDevice, cliVersionView } from "./cliDeviceView.ts"
const now = Date.parse("2026-09-09T10:00:00Z")
const credential: CLICredential = { id: "one", capability: "atape-cli.v1", createdAt: new Date(now).toISOString(), lastUsedAt: new Date(now).toISOString() }
const reported: CLICredential = { ...credential, reportedAt: new Date(now).toISOString(), sync: { phase: "waiting", jobsTruncated: false,
  jobs: [{ projectId: "p", projectName: "Project", adapterId: "codex", state: "synced", hasMore: false }] } }
describe("CLI device dashboard", () => {
  it("does not derive liveness from authentication activity", () => {
    expect(presentCLIDevice(credential, now).status).toBe("Status not reported")
    expect(presentCLIDevice(reported, now).status).toBe("Up to date")
    expect(presentCLIDevice(reported, now + 120_001).status).toBe("Status expired")
    expect(presentCLIDevice({ ...reported, reportedAt: "invalid" }, now).status).toBe("Status expired")
  })
  it("keeps failed and partial jobs visible while a subsequent cycle runs", () => {
    for (const state of ["failed", "partial"] as const) {
      expect(presentCLIDevice({ ...reported, sync: { ...reported.sync!, phase: "syncing", jobs: [{ ...reported.sync!.jobs[0]!, state }] } }, now).status).toBe("Needs attention")
    }
  })
  it("distinguishes backlog and stopped collection from healthy idle", () => {
    expect(presentCLIDevice({ ...reported, sync: { ...reported.sync!, jobs: [{ ...reported.sync!.jobs[0]!, hasMore: true }] } }, now).status).toBe("Catching up")
    expect(presentCLIDevice({ ...reported, sync: { ...reported.sync!, phase: "stopped" } }, now).status).toBe("Collector stopped")
  })
  it("compares stable versions numerically and treats unavailable checks as unknown", () => {
    expect(cliVersionView("0.4.9", "0.4.10")).toBe("Update available · v0.4.10")
    expect(cliVersionView("0.4.5")).toBe("Update status unknown")
    expect(cliVersionView("0.4.5", "0.4.5")).toBe("Latest stable version")
    expect(cliVersionView("0.4.6", "0.4.5")).toBe("Ahead of latest stable")
  })
})

it("groups project jobs by installed package without hiding a failed or never-synced project", () => {
  const view = presentCLIDevice({ ...reported, device: { name: "Mac", platform: "darwin", version: "1.0.0", adapters: [
    { id: "custom", packageName: "@third-party/source", version: "2.1.0", enabled: true }
  ] }, sync: { phase: "waiting", jobsTruncated: false, jobs: [
    { projectId: "a", projectName: "A", adapterId: "custom", state: "synced", hasMore: false, lastSuccessAt: new Date(now).toISOString() },
    { projectId: "b", projectName: "B", adapterId: "custom", state: "failed", hasMore: false }
  ] } }, now)
  expect(view.adapters).toHaveLength(1)
  expect(view.adapters[0]).toMatchObject({ packageName: "@third-party/source", version: "2.1.0", status: "Sync failed", lastSuccessAt: undefined })
  expect(view.adapters[0]?.jobs).toHaveLength(2)
  expect(presentCLIDevice(reported, now).adapters[0]).toMatchObject({ packageName: "codex", versionStatus: "Version not reported" })
})
