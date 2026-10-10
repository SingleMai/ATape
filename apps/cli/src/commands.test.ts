import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const exec = promisify(execFile)
const cli = fileURLToPath(new URL("./main.ts", import.meta.url))
const bootstrap = fileURLToPath(new URL("./entry.ts", import.meta.url))
const environment = { ...process.env, ATAPE_LANG: "en", ATAPE_REDACTION_CONFIG_FILE: undefined }

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
      for (const args of [["login"], ["setup"], ["tools", "list"], ["adapters", "prune", "--apply"], ["collect", "--once"], ["status", "--json"], ["start", "--tool", "cursor"], [], ["--json"]]) {
        await expect(exec(process.execPath, [cli, ...args], { env: { ...environment, ATAPE_HOME: home,
          ATAPE_INSTANCE_URL: `http://127.0.0.1:${address.port}` } })).rejects.toMatchObject({ code: 2, stdout: "", stderr: expect.stringContaining("ATape") })
      }
      expect(requests).toBe(0)
      await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)
  it("reports version and concise help without requiring an interactive terminal", async () => {
    expect((await exec(process.execPath, [cli, "--version"], { env: environment })).stdout.trim()).toBe("ATape development")
    const help = (await exec(process.execPath, [cli, "--help"], { env: environment })).stdout
    expect(help).toContain("projects, tools and settings")
    expect(help).toContain("atape redaction-test <file>")
    expect(help).not.toMatch(/atape (setup|login|status|upgrade|adapters|collect)|__collector-daemon/)
    expect((await exec(process.execPath, [cli, "--help", "--lang", "zh-CN"], { env: environment })).stdout).toContain("用法")
  }, 30000)
})


describe("local redaction executable", () => {
  it("tests effective rules locally without authentication, managed runtime selection or state writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-redaction-command-"))
    let requests = 0
    const server = createServer((_, response) => { requests++; response.end() })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("fixture did not bind")
    const home = join(root, "home")
    const file = join(root, "sample.jsonl")
    const config = join(root, "redaction.json")
    const env = { ...environment, ATAPE_HOME: home, ATAPE_REDACT_VALUES: "[]",
      ATAPE_INSTANCE_URL: `http://127.0.0.1:${address.port}` }
    try {
      await writeFile(file, '{"message":"keep ticket=private-alpha","password":"x"}\n')
      await writeFile(config, JSON.stringify({ patterns: [{ name: "Local pattern", pattern: "ticket=(private-[a-z]+)", type: "local", capture_group: 1 }] }))
      const result = await exec(process.execPath, [bootstrap, "redaction-test", file, "--config", config], { env })
      expect(JSON.parse(result.stdout)).toEqual({ message: "keep ticket=[REDACTED:LOCAL]", password: "[REDACTED]" })
      expect(result.stderr).toMatch(/Redaction test: \d+ mask operation\(s\)\./)
      expect(result.stderr).toContain("custom:0 (local): 1")
      expect(result.stderr).not.toMatch(/private-alpha|Local pattern|ticket=/)
      await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" })

      await mkdir(join(home, "releases"), { recursive: true })
      await writeFile(join(home, "releases", "current.json"), "malformed selection")
      await writeFile(join(home, "config.json"), "malformed client configuration")
      const direct = await exec(process.execPath, [bootstrap, "redaction-test", file, "--config", config], { env })
      expect(direct.stdout).toBe(result.stdout)
      expect(await readFile(join(home, "releases", "current.json"), "utf8")).toBe("malformed selection")
      expect(await readFile(join(home, "config.json"), "utf8")).toBe("malformed client configuration")
      await expect(stat(join(home, "config"))).rejects.toMatchObject({ code: "ENOENT" })
      expect(requests).toBe(0)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 60000)

  it("uses format overrides and default global configuration, preserving masked-only stdout", async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-redaction-formats-"))
    const home = join(root, "home")
    const file = join(root, "sample.json")
    const env = { ...environment, ATAPE_HOME: home, ATAPE_REDACT_VALUES: '["local-literal"]' }
    try {
      await mkdir(join(home, "config"), { recursive: true })
      await writeFile(join(home, "config", "redaction.json"), JSON.stringify({ patterns: [{ name: "Configured custom rule", pattern: "custom-[a-z]+", type: "local" }] }))
      await writeFile(file, "readable custom-value and local-literal\n")
      const result = await exec(process.execPath, [cli, "redaction-test", file, "--format", "text"], { env })
      expect(result.stdout).toContain("readable [REDACTED:LOCAL] and ")
      expect(result.stdout).not.toMatch(/custom-value|local-literal/)
      expect(result.stdout.endsWith("\n")).toBe(true)
      await writeFile(file, '{"password":"x","message":"custom-value"}')
      const json = await exec(process.execPath, [cli, "redaction-test", file], { env })
      expect(JSON.parse(json.stdout)).toEqual({ password: "[REDACTED]", message: "[REDACTED:LOCAL]" })
      const help = await exec(process.execPath, [cli, "redaction-test", "--help", "--lang", "zh-CN"], { env })
      expect(help.stdout).toContain("本地测试脱敏规则")
      expect(help.stderr).toBe("")
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 60000)

  it("fails without partial stdout or source/configuration details", async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-redaction-failure-"))
    const home = join(root, "home")
    const file = join(root, "secret-filename.jsonl")
    const config = join(root, "secret-config.json")
    const env = { ...environment, ATAPE_HOME: home, ATAPE_REDACT_VALUES: "[]" }
    const rejected = async (args: string[]) => {
      try { await exec(process.execPath, [cli, "redaction-test", ...args], { env }); throw new Error("expected failure") }
      catch (cause) {
        expect(cause).toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("Local redaction test failed") })
        expect((cause as { stderr: string }).stderr).not.toMatch(/secret-filename|secret-config|source-secret|regex-secret|private-alpha/)
      }
    }
    try {
      await writeFile(file, '{"message":"private-alpha"}\n{"source-secret":invalid}\n')
      await rejected([file])
      await writeFile(file, '{"password":"x","pass\\u0077ord":"source-secret"}')
      await rejected([file])
      await writeFile(file, "private-alpha")
      await writeFile(config, '{"patterns":[{"name":"Invalid custom rule","pattern":"regex-secret(","type":"local"}]}')
      await rejected([file, "--format", "text", "--config", config])
      for (const args of [["--help"], ["--version"], ["redaction-test", "--help"]]) {
        const info = await exec(process.execPath, [cli, ...args], { env: { ...env, ATAPE_REDACTION_CONFIG_FILE: config } })
        expect(info.stdout).not.toBe("")
        expect(info.stderr).toBe("")
      }
      await rejected([join(root, "secret-filename-missing")])
      await rejected([root])
      await writeFile(file, Buffer.from([0xff, 0xfe]))
      await rejected([file, "--format", "text"])
      await truncate(file, 16 * 1024 * 1024 + 1)
      await rejected([file, "--format", "text"])
      await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" })
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 60000)
})

it("shows start help through both public entries without touching malformed managed state", async () => {
  const root = await mkdtemp(join(tmpdir(), "atape-start-help-")), home = join(root, "home")
  try {
    for (const entry of [cli, bootstrap]) {
      const result = await exec(process.execPath, [entry, "start", "--help"], { env: { ...environment, ATAPE_HOME: home } })
      expect(result.stdout).toContain("atape start --tool <id>"); expect(result.stderr).toBe("")
      await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" })
    }
    await mkdir(join(home, "updates"), { recursive: true }); await writeFile(join(home, "updates", "runtime.json"), "malformed")
    expect((await exec(process.execPath, [bootstrap, "start", "--help", "--lang", "zh-CN"], { env: { ...environment, ATAPE_HOME: home } })).stdout).toContain("启动受控")
    await expect(exec(process.execPath, [bootstrap, "start", "--tool", "cursor"], { env: { ...environment, ATAPE_HOME: home } })).rejects.toMatchObject({ code: 2 })
    expect(await readFile(join(home, "updates", "runtime.json"), "utf8")).toBe("malformed")
    await expect(stat(join(home, "config"))).rejects.toMatchObject({ code: "ENOENT" })
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
