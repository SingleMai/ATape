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
    ["__collector-daemon", "--daemon-token", "token", "extra"],
    ["__automatic-update"], ["__automatic-update", "--update-token", "token"],
    ["__login-start"], ["__login-start", "--startup-token", "token"],
    ["__login-start", "--startup-token", "e859003d-90b4-44f6-ae5a-c14aa3c8ede7", "--no-browser"],
    ["__automatic-update", "--update-token", "e859003d-90b4-44f6-ae5a-c14aa3c8ede7", "extra"]])("rejects unsupported arguments %j", (...args) => {
    expect(() => parseCLI(args)).toThrow()
  })
  it("decodes the local redaction test without exposing other business commands", () => {
    expect(parseCLI(["redaction-test", "sample.ndjson"])).toEqual({ kind: "redaction-test", options: { file: "sample.ndjson" } })
    expect(parseCLI(["redaction-test", "sample", "--format", "text", "--config", "/tmp/rules.json", "--lang", "zh-CN"]))
      .toEqual({ kind: "redaction-test", options: { file: "sample", format: "text", config: "/tmp/rules.json", lang: "zh-CN" } })
    expect(parseCLI(["redaction-test", "--help"])).toEqual({ kind: "redaction-help", options: {} })
    expect(parseCLI(["redaction-test", "--", "--sample.txt"])).toEqual({ kind: "redaction-test", options: { file: "--sample.txt" } })
  })
  it.each([
    ["redaction-test"], ["redaction-test", "a", "b"], ["redaction-test", ""],
    ["redaction-test", "a", "--format", "xml"], ["redaction-test", "a", "--format", "text", "--format", "json"],
    ["redaction-test", "a", "--config", ""], ["redaction-test", "a", "--no-browser"],
    ["redaction-test", "--help", "a"], ["redaction-test", "--help", "--config", "a"],
    ["redaction-test", "a", "--password=private-value"]
  ])("rejects invalid local test arguments safely %j", (...args) => {
    expect(() => parseCLI(args)).toThrow("Unsupported arguments")
    expect(() => parseCLI(args)).not.toThrow("private-value")
  })
  it("retains only the process owner's internal Collector invocation", () => {
    expect(parseCLI(["__collector-daemon", "--daemon-token", "owner", "--interval", "30", "--concurrency", "4"]))
      .toEqual({ kind: "__collector-daemon", options: { daemonToken: "owner", intervalMs: 30000, concurrency: 4 } })
  })
  it("decodes the independent updater's internal invocation", () => {
    expect(parseCLI(["__automatic-update", "--update-token", "e859003d-90b4-44f6-ae5a-c14aa3c8ede7"]))
      .toEqual({ kind: "__automatic-update", options: { updateToken: "e859003d-90b4-44f6-ae5a-c14aa3c8ede7" } })
  })
  it("decodes only the registered login coordinator's internal invocation", () => {
    expect(parseCLI(["__login-start", "--startup-token", "e859003d-90b4-44f6-ae5a-c14aa3c8ede7"]))
      .toEqual({ kind: "__login-start", options: { startupToken: "e859003d-90b4-44f6-ae5a-c14aa3c8ede7" } })
  })
})
