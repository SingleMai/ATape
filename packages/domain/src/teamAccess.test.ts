import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  JoinCodeGrant,
  normalizeTeamJoinCode,
  slugifyTeamName,
  validTeamSlug
} from "./teamAccess.ts"

describe("Team access boundary values", () => {
  it("normalizes case and spaces in generated join codes", () => {
    expect(normalizeTeamJoinCode("k7m 4px")).toBe("K7M4PX")
    expect(normalizeTeamJoinCode("K7MI4P")).toBeUndefined()
    expect(normalizeTeamJoinCode("K7M40P")).toBeUndefined()
  })

  it("derives and validates stable Team address slugs", () => {
    expect(slugifyTeamName("  My Design Team  ")).toBe("my-design-team")
    expect(validTeamSlug("my-design-team")).toBe(true)
    expect(validTeamSlug("My Team")).toBe(false)
    expect(validTeamSlug("a")).toBe(false)
  })

  it("rejects malformed one-time grants at the decoding boundary", async () => {
    await expect(Schema.decodeUnknownPromise(JoinCodeGrant)({
      code: "K7M4PX",
      generation: -1,
      rotatedAt: "2026-09-05T00:00:00Z"
    })).rejects.toBeDefined()
    await expect(Schema.decodeUnknownPromise(JoinCodeGrant)({
      code: "K7MI4P",
      generation: 1,
      rotatedAt: "2026-09-05T00:00:00Z"
    })).rejects.toBeDefined()
  })
})
