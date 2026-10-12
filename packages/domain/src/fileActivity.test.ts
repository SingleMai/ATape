import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AcpFileActivity, AcpToolUpdate, CanonicalProfileVersion3, CanonicalProfileVersion4, CanonicalProfileVersion5,
  FileActivityMetaKey, ToolIdentityMetaKey, admitsToolMetadata } from "./collector.ts"

const decode = Schema.decodeUnknownSync(AcpToolUpdate)
const update = (activity: unknown) => ({ sessionUpdate: "tool_call_update", toolCallId: "call",
  _meta: { [ToolIdentityMetaKey]: null, [FileActivityMetaKey]: activity } })

describe("admitted file activity facts", () => {
  it.each([null, [], [{ operation: "read", path: " ./src/../file.ts " }],
    [{ operation: "edit", path: "C:\\project\\file.ts" }, { operation: "search", path: "./src" }]])(
    "preserves exact paths, empty and explicit null facts %j", activity => {
      const admitted = decode(update(activity))
      expect(admitted).toEqual(update(activity))
      expect(admitsToolMetadata(CanonicalProfileVersion5, admitted)).toBe(true)
      for (const profile of [CanonicalProfileVersion3, CanonicalProfileVersion4]) expect(admitsToolMetadata(profile, admitted)).toBe(false)
    })
  it("preserves namespace absence separately from an explicit clear", () => {
    expect(decode({ sessionUpdate: "tool_call_update", toolCallId: "call", _meta: { [ToolIdentityMetaKey]: null } })._meta)
      .not.toHaveProperty(FileActivityMetaKey)
  })
  it.each([
    {}, [{ operation: "delete", path: "x" }], [{ operation: "read", path: "" }],
    [{ operation: "read", path: "x", inferred: true }], [{ operation: "read", path: "x\nfile" }],
    [{ operation: "read", path: "x\u0085file" }], [{ operation: "read", path: "x\uD800" }],
    [{ operation: "read", path: "界".repeat(683) }],
    Array.from({ length: 65 }, () => ({ operation: "read", path: "x" })),
    [{ operation: "read", path: "x".repeat(2048) }, { operation: "edit", path: "y".repeat(2048) }]
  ])("rejects invalid or unbounded activity %#", activity => {
    expect(() => decode(update(activity))).toThrow()
  })
  it("bounds decoded JSON bytes consistently for Unicode and escapes", () => {
    const decodeActivity = Schema.decodeUnknownSync(AcpFileActivity)
    const entry = { operation: "read", path: "界".repeat(682) }
    expect(decodeActivity([entry])).toEqual([entry])
    const escaped = { operation: "edit", path: '\\"'.repeat(1024) }
    expect(() => decodeActivity([escaped])).toThrow()
    expect(decodeActivity([{ operation: "search", path: "<>&\u2028\u2029🚀" }])).toEqual([{ operation: "search", path: "<>&\u2028\u2029🚀" }])
  })
})
