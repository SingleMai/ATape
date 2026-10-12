import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AcpToolMetadata, AcpToolUpdate, ToolIdentityMetaKey } from "./collector.ts"

describe("admitted ACP tool identity", () => {
  const decode = Schema.decodeUnknownSync(AcpToolUpdate)
  it.each([
    { type: "tool", name: "exec_command" }, { type: "mcp", server: "service", name: "read" }, { type: "skill", name: "review" }, null
  ])("retains the exact normalized identity %j", identity => {
    const update = { sessionUpdate: "tool_call", toolCallId: "call", title: "Call",
      _meta: { [ToolIdentityMetaKey]: identity } }
    expect(decode(update)).toEqual(update)
    expect(decode({ ...update, sessionUpdate: "tool_call_update" })).toEqual({ ...update, sessionUpdate: "tool_call_update" })
  })

  it("preserves absence separately from an explicit identity clear", () => {
    const update = { sessionUpdate: "tool_call_update", toolCallId: "call" }
    expect(decode(update)).not.toHaveProperty("_meta")
    expect(decode({ ...update, _meta: { [ToolIdentityMetaKey]: null } })).toHaveProperty("_meta", { [ToolIdentityMetaKey]: null })
  })

  it.each([
    null, {}, { other: null },
    { [ToolIdentityMetaKey]: { type: "tool", name: "exec_command", server: "extra" } },
    { [ToolIdentityMetaKey]: { type: "tool", name: "x".repeat(501) } }, { [ToolIdentityMetaKey]: null, extra: true },
    { [ToolIdentityMetaKey]: { type: "mcp", server: "service", name: "tool", extra: true } },
    { [ToolIdentityMetaKey]: { type: "skill", name: "review", server: "not-a-skill-field" } },
    { [ToolIdentityMetaKey]: { type: "mcp", name: "tool" } },
    { [ToolIdentityMetaKey]: { type: "skill", name: "" } },
    { [ToolIdentityMetaKey]: { type: "skill", name: " review" } },
    { [ToolIdentityMetaKey]: { type: "mcp", server: "service ", name: "tool" } },
    { [ToolIdentityMetaKey]: { type: "skill", name: "界".repeat(167) } }
  ])("rejects malformed, unbounded or nonclosed metadata %j", _meta => {
    expect(() => decode({ sessionUpdate: "tool_call_update", toolCallId: "call", _meta })).toThrow()
  })

  it("uses UTF-8 bytes for both name and server bounds", () => {
    const identity = { type: "mcp", server: "界".repeat(166), name: "x".repeat(500) }
    expect(Schema.decodeUnknownSync(AcpToolMetadata)({ [ToolIdentityMetaKey]: identity }))
      .toEqual({ [ToolIdentityMetaKey]: identity })
    expect(() => decode({ sessionUpdate: "tool_call", toolCallId: "call", title: "Call",
      _meta: { [ToolIdentityMetaKey]: { ...identity, server: "界".repeat(167) } } })).toThrow()
  })

  it.each(["\u0085", "\uFEFF"])("rejects shared trim edge %j without altering interior characters", whitespace => {
    const decodeMetadata = Schema.decodeUnknownSync(AcpToolMetadata)
    for (const name of [`${whitespace}review`, `review${whitespace}`]) {
      expect(() => decodeMetadata({ [ToolIdentityMetaKey]: { type: "skill", name } })).toThrow()
      expect(() => decodeMetadata({ [ToolIdentityMetaKey]: { type: "mcp", server: name, name: "read" } })).toThrow()
    }
    const identity = { type: "mcp", server: `service${whitespace}host`, name: `read${whitespace}page` }
    expect(decodeMetadata({ [ToolIdentityMetaKey]: identity })).toEqual({ [ToolIdentityMetaKey]: identity })
  })

  it.each(["\uD800", "\uDBFF", "\uDC00", "\uDFFF"])("rejects lone UTF-16 surrogate %j in names and servers", surrogate => {
    const decodeMetadata = Schema.decodeUnknownSync(AcpToolMetadata)
    for (const name of [surrogate, `review${surrogate}`, `${surrogate}review`]) {
      expect(() => decodeMetadata({ [ToolIdentityMetaKey]: { type: "skill", name } })).toThrow()
      expect(() => decodeMetadata({ [ToolIdentityMetaKey]: { type: "mcp", server: name, name: "read" } })).toThrow()
      expect(() => decodeMetadata({ [ToolIdentityMetaKey]: { type: "mcp", server: "docs", name } })).toThrow()
    }
  })

  it("preserves valid surrogate pairs and genuine replacement characters as exact identities", () => {
    const decodeMetadata = Schema.decodeUnknownSync(AcpToolMetadata)
    for (const name of ["\uD83D\uDE80", "\uFFFD", "review\uFFFD", "review\uD83D\uDE80"]) {
      const identity = { type: "mcp", server: name, name }
      expect(decodeMetadata({ [ToolIdentityMetaKey]: identity })).toEqual({ [ToolIdentityMetaKey]: identity })
    }
  })
})
