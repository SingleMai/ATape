import { describe, expect, it } from "vitest"
import {
  normalizeInstanceOrigin,
  normalizeInstanceTopology
} from "./cliAuthentication.ts"

describe("CLI authentication boundary values", () => {
  it("accepts only canonical HTTPS origins in production", () => {
    expect(normalizeInstanceOrigin("https://atape.net")).toBe("https://atape.net")
    expect(normalizeInstanceOrigin("https://atape.net:443")).toBe("https://atape.net")
    expect(normalizeInstanceOrigin("https://atape.net/")).toBe("https://atape.net")
    expect(normalizeInstanceOrigin("https://atape.net/path")).toBeUndefined()
    expect(normalizeInstanceOrigin("https://user:secret@atape.net")).toBeUndefined()
    expect(normalizeInstanceOrigin("http://atape.net")).toBeUndefined()
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
      instanceOrigin: "https://atape.net",
      webOrigin: "https://atape.net",
      apiOrigin: "https://api.atape.net"
    })).toEqual({
      instanceOrigin: "https://atape.net",
      webOrigin: "https://atape.net",
      apiOrigin: "https://api.atape.net"
    })
    expect(normalizeInstanceTopology({
      instanceOrigin: "https://atape.net",
      webOrigin: "https://login.atape.net",
      apiOrigin: "https://api.atape.net"
    })).toBeUndefined()
  })
})
