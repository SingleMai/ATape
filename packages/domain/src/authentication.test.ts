import { describe, expect, it } from "vitest"
import {
  normalizeDeviceUserCode,
  safeAuthorizationURI,
  safeLocalReturnTo
} from "./authentication.ts"

describe("authentication boundary values", () => {
  it("keeps only local return targets without fragments or control characters", () => {
    expect(safeLocalReturnTo("/settings/account?from=login")).toBe("/settings/account?from=login")
    expect(safeLocalReturnTo("https://attacker.example/collect")).toBe("/")
    expect(safeLocalReturnTo("//attacker.example/collect")).toBe("/")
    expect(safeLocalReturnTo("/settings#secret")).toBe("/")
    expect(safeLocalReturnTo("/auth\\callback")).toBe("/")
    expect(safeLocalReturnTo("/auth\ncallback")).toBe("/")
  })

  it("normalizes the human CLI code but rejects ambiguous characters", () => {
    expect(normalizeDeviceUserCode("q7 km4w")).toBe("Q7KM4W")
    expect(normalizeDeviceUserCode("q7km4w")).toBe("Q7KM4W")
    expect(normalizeDeviceUserCode("Q7KMIW")).toBeUndefined()
  })

  it("accepts only credential-free HTTPS Provider navigation", () => {
    expect(safeAuthorizationURI("https://github.com/login/oauth/authorize?state=opaque"))
      .toBe("https://github.com/login/oauth/authorize?state=opaque")
    expect(safeAuthorizationURI("http://github.com/login")).toBeUndefined()
    expect(safeAuthorizationURI("https://user:secret@github.com/login")).toBeUndefined()
  })
})
