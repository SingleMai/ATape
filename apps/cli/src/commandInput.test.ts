import { describe, expect, it } from "vitest"
import { parseCLI } from "./commandInput.ts"

describe("CLI command input", () => {
  it.each([
    [[], "interactive"], [["setup", "a b"], "interactive"], [["--version"], "version"],
    [["adapters", "upgrade", "--help"], "help"], [["status", "--json"], "status"],
    [["login", "--no-browser", "--instance", "https://atape.example"], "login"],
    [["setup", "--team", "one", "--create"], "setup"], [["projects", "list"], "projects.list"],
    [["projects", "remove", "one"], "projects.remove"], [["adapters", "install", "./pkg"], "adapters.install"],
    [["adapters", "upgrade", "--all"], "adapters.upgrade"], [["adapters", "upgrade", "codex"], "adapters.upgrade"],
    [["adapters", "prune", "--keep", "0"], "adapters.prune"], [["tools", "configure", "--none"], "tools.configure"],
    [["collect", "--once", "--json"], "collect"], [["start", "--interval", "30"], "start"],
    [["language", "zh-CN"], "language"], [["__collector-daemon", "--daemon-token", "token"], "__collector-daemon"]
  ] as const)("decodes %j into %s", (args, kind) => { expect(parseCLI(args).kind).toBe(kind) })

  it("retains repeated tool choices in a command-specific value", () => {
    expect(parseCLI(["--lang", "zh-CN", "tools", "configure", "--adapter", "codex", "--adapter", "opencode", "--apply"]))
      .toEqual({ kind: "tools.configure", adapterIds: ["codex", "opencode"], options: { lang: "zh-CN", apply: true } })
  })

  it.each([
    ["status", "--team", "one"], ["tools", "list", "--apply"], ["tools", "configure", "--none", "--adapter", "codex"],
    ["tools", "configure", "--project", "one", "--none"], ["setup", "--adapter", "codex"],
    ["language", "en", "extra"], ["login", "extra"], ["adapters", "upgrade", "codex", "--all"],
    ["adapters", "upgrade"], ["adapters", "install"], ["adapters", "prune", "extra"],
    ["collect", "--json"], ["start", "--once"], ["logout", "--no-browser"], ["__collector-daemon"],
    ["status", "--instance", "https://ignored.example"], ["--version", "status"], ["--help", "--apply"],
    ["setup", "--team", ""], ["setup", "--team", "one", "--team", "two"], ["status", "--unknown"]
  ])("rejects an invalid invocation %j", (...args) => { expect(() => parseCLI(args)).toThrow() })
})
