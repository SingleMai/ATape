import type { RawContentPage, SessionRawArchive } from "@atape/domain"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { RawGateway, listSessionRaw, readRawContent } from "./raw"

const archive: SessionRawArchive = { sessionId: "checkout", objects: [] }
const page: RawContentPage = {
  objectId: "raw-1", generation: 1, sizeBytes: 4, finalized: true,
  chunks: [{ offset: 0, sizeBytes: 4, sha256: "a".repeat(64), contentBase64: "dGVzdA==" }]
}

const testLayer = Layer.succeed(RawGateway, RawGateway.of({
  listSession: () => Effect.succeed(archive),
  readContent: () => Effect.succeed(page)
}))

describe("Raw Module", () => {
  it("keeps manifest and content reads behind one independent Gateway", async () => {
    const listed = await listSessionRaw("checkout").pipe(Effect.provide(testLayer), Effect.runPromise)
    const read = await readRawContent({ objectId: "raw-1", generation: 1 }).pipe(
      Effect.provide(testLayer),
      Effect.runPromise
    )
    expect(listed.objects).toHaveLength(0)
    expect(read.chunks[0]?.contentBase64).toBe("dGVzdA==")
  })
})
