import { execFile } from "node:child_process"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const exec = promisify(execFile)
const cli = fileURLToPath(new URL("./main.ts", import.meta.url))
const environment = { ...process.env, ATAPE_LANG: "en" }

describe("ATape executable entry", () => {
  it("rejects removed commands and unsupported terminals before mutation or network access", async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-entry-"))
    let requests = 0
    const server = createServer((_, response) => { requests++; response.end() })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("fixture did not bind")
    const home = join(root, "home")
    try {
      for (const args of [["login"], ["setup"], ["tools", "list"], ["adapters", "prune", "--apply"], ["collect", "--once"], ["status", "--json"], [], ["--json"]]) {
        await expect(exec(process.execPath, [cli, ...args], { env: { ...environment, ATAPE_HOME: home,
          ATAPE_INSTANCE_URL: `http://127.0.0.1:${address.port}` } })).rejects.toMatchObject({ code: 2, stdout: "", stderr: expect.stringContaining("ATape") })
      }
      expect(requests).toBe(0)
      await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 15000)
  it("reports version and concise help without requiring an interactive terminal", async () => {
    expect((await exec(process.execPath, [cli, "--version"], { env: environment })).stdout.trim()).toBe("ATape development")
    const help = (await exec(process.execPath, [cli, "--help"], { env: environment })).stdout
    expect(help).toContain("projects, tools and settings")
    expect(help).not.toMatch(/atape (setup|login|status|upgrade|adapters|collect)|__collector-daemon/)
    expect((await exec(process.execPath, [cli, "--help", "--lang", "zh-CN"], { env: environment })).stdout).toContain("用法")
  })
})
