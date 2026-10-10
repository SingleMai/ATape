import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { AdapterManifest, AdapterProtocolVersion, SourceCaptureVersion, SourceCaptureVersion2 } from "./client.ts"
import { PublicationTargetProfile2, PublicationTargetProfile3 } from "./publication.ts"

const manifest = { protocolVersion: AdapterProtocolVersion, adapterId: "fixture", displayName: "Fixture",
  entry: "./index.js", harnesses: ["fixture"] }
const decode = Schema.decodeUnknownSync(AdapterManifest)

describe("Adapter publication prerequisites", () => {
  it("preserves undeclared legacy and source manifests without adding a new requirement", () => {
    expect(decode(manifest)).toEqual(manifest)
    for (const sourceCapture of [SourceCaptureVersion, SourceCaptureVersion2]) {
      const source = { ...manifest, sourceCapture }
      expect(decode(source)).toEqual(source)
    }
  })

  it.each([PublicationTargetProfile2, PublicationTargetProfile3])("accepts source v2's declared %s minimum", publicationTargetProfile => {
    const source = { ...manifest, sourceCapture: SourceCaptureVersion2, publicationTargetProfile }
    expect(decode(source)).toEqual(source)
  })

  it.each([undefined, SourceCaptureVersion])("rejects a publication declaration without source v2 (%s)", sourceCapture => {
    expect(() => decode({ ...manifest, ...(sourceCapture === undefined ? {} : { sourceCapture }),
      publicationTargetProfile: PublicationTargetProfile3 })).toThrow()
  })

  it.each([null, 3, {}, "atape.publication-target.v1", "atape.publication-target.v4"])("rejects unsupported profile declarations %j", publicationTargetProfile => {
    expect(() => decode({ ...manifest, sourceCapture: SourceCaptureVersion2, publicationTargetProfile })).toThrow()
  })
})
