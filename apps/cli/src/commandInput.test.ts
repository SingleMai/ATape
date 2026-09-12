import { describe, expect, it } from "vitest"
import { parseCLI } from "./commandInput.ts"

describe("single CLI entry", () => {
  it.each([[[], "interactive"], [["--no-browser", "--lang", "zh-CN"], "interactive"],
    [["--help"], "help"], [["-h"], "help"], [["--version"], "version"], [["-v"], "version"]] as const)("accepts %j", (args, kind) => {
    expect(parseCLI(args).kind).toBe(kind)
  })
  it.each(["login", "logout", "setup", "projects", "tools", "adapters", "collect", "start", "stop", "status", "language", "upgrade", "help"])("removes the %s command", command => {
    expect(() => parseCLI([command])).toThrow("Run atape")
    expect(() => parseCLI([command, "--help"])).toThrow()
  })
  it.each([["--json"], ["--instance", "https://atape.net"], ["--help", "--version"], ["--help", "--no-browser"],
    ["--lang", ""], ["--lang", "en", "--lang", "zh-CN"], ["--daemon-token", "token"],
    ["__collector-daemon"], ["__collector-daemon", "--daemon-token", ""],
    ["__collector-daemon", "--daemon-token", "token", "--interval", "1"],
    ["__collector-daemon", "--daemon-token", "token", "--concurrency", "9"],
    ["__collector-daemon", "--daemon-token", "token", "--interval", "1e2"],
    ["__collector-daemon", "--daemon-token", "token", "extra"]])("rejects unsupported arguments %j", (...args) => {
    expect(() => parseCLI(args)).toThrow()
  })
  it("retains only the process owner's internal Collector invocation", () => {
    expect(parseCLI(["__collector-daemon", "--daemon-token", "owner", "--interval", "30", "--concurrency", "4"]))
      .toEqual({ kind: "__collector-daemon", options: { daemonToken: "owner", intervalMs: 30000, concurrency: 4 } })
  })
})
