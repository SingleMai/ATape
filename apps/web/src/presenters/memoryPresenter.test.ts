import { describe, expect, it } from "vitest"
import { refreshCadenceMilliseconds } from "./memoryPresenter.ts"

describe("refreshCadenceMilliseconds", () => {
  it("keeps automatic refresh off until the user opts in", () => {
    expect(refreshCadenceMilliseconds("manual")).toBeUndefined()
  })

  it("maps the exposed refresh intervals", () => {
    expect(refreshCadenceMilliseconds("30_seconds")).toBe(30_000)
    expect(refreshCadenceMilliseconds("1_minute")).toBe(60_000)
    expect(refreshCadenceMilliseconds("5_minutes")).toBe(300_000)
  })
})
