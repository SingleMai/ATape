import { describe, expect, it } from "vitest"
import { parseCLI } from "./commands.ts"
import { requestsGuidedExperience, supportsInteractiveExperience } from "./interactiveEligibility.ts"

describe("interactive entry selection", () => {
  it("routes bare atape and unqualified setup to the guided experience", () => {
    for (const args of [[], ["setup"], ["setup", "/work/a b"], ["--instance", "https://atape.net"], ["--lang", "zh-CN"]]) {
      expect(requestsGuidedExperience(parseCLI(args))).toBe(true)
    }
    for (const args of [["--help"], ["--version"], ["status", "--json"], ["setup", "--json"], ["setup", "--team", "acme"], ["--lang", "zh-CN", "--json"], ["__collector-daemon"]]) {
      expect(requestsGuidedExperience(parseCLI(args))).toBe(false)
    }
  })
  it("never enters input in CI, pipes, unsupported terminals or platforms", () => {
    expect(supportsInteractiveExperience({}, true, true, "linux")).toBe(true)
    for (const env of [{ CI: "true" }, { CONTINUOUS_INTEGRATION: "1" }, { BUILD_NUMBER: "123" }, { TERM: "dumb" }]) {
      expect(supportsInteractiveExperience(env, true, true, "darwin")).toBe(false)
    }
    expect(supportsInteractiveExperience({}, false, true, "linux")).toBe(false)
    expect(supportsInteractiveExperience({}, true, false, "linux")).toBe(false)
    expect(supportsInteractiveExperience({}, true, true, "win32")).toBe(false)
  })
})
