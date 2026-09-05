import { describe, expect, it } from "vitest"
import {
  normalizeInstanceOrigin,
  normalizeInstanceTopology
} from "./cliAuthentication.ts"

describe("CLI authentication boundary values", () => {
  it("accepts only canonical HTTPS origins in production", () => {
    expect(normalizeInstanceOrigin("https://atape.dev")).toBe("https://atape.dev")
    expect(normalizeInstanceOrigin("https://atape.dev:443")).toBe("https://atape.dev")
    expect(normalizeInstanceOrigin("https://atape.dev/")).toBe("https://atape.dev")
    expect(normalizeInstanceOrigin("https://atape.dev/path")).toBeUndefined()
    expect(normalizeInstanceOrigin("https://user:secret@atape.dev")).toBeUndefined()
    expect(normalizeInstanceOrigin("http://atape.dev")).toBeUndefined()
  })

  it("limits explicitly enabled HTTP development to loopback", () => {
    const development = { allowLoopbackHttp: true }
    expect(normalizeInstanceOrigin("http://127.0.0.1:8080", development))
      .toBe("http://127.0.0.1:8080")
    expect(normalizeInstanceOrigin("http://localhost:8080", development))
      .toBe("http://localhost:8080")
    expect(normalizeInstanceOrigin("http://[::1]:8080", development))
      .toBe("http://[::1]:8080")
    expect(normalizeInstanceOrigin("http://192.168.1.10:8080", development)).toBeUndefined()
  })

  it("requires the canonical Instance and Web origins to match", () => {
    expect(normalizeInstanceTopology({
      instanceOrigin: "https://atape.dev",
      webOrigin: "https://atape.dev",
      apiOrigin: "https://api.atape.dev"
    })).toEqual({
      instanceOrigin: "https://atape.dev",
      webOrigin: "https://atape.dev",
      apiOrigin: "https://api.atape.dev"
    })
    expect(normalizeInstanceTopology({
      instanceOrigin: "https://atape.dev",
      webOrigin: "https://login.atape.dev",
      apiOrigin: "https://api.atape.dev"
    })).toBeUndefined()
  })
})
