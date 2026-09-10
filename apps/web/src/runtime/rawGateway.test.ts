import { listSessionRaw, readRawContent } from "@atape/application"
import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BrowserRawGatewayLayer } from "./rawGateway"

const run = <A, E>(effect: Effect.Effect<A, E, import("@atape/application").RawGateway>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BrowserRawGatewayLayer)))

describe("Raw browser transport", () => {
  afterEach(() => vi.unstubAllGlobals())
  it("requests scoped manifest pages and accepts a maximum three MiB content chunk", async () => {
    const contentBase64 = Buffer.alloc(3 * 1024 * 1024, "x").toString("base64")
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: "one", objects: [], nextCursor: "opaque" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ objectId: "raw-one", generation: 1, sizeBytes: 3 * 1024 * 1024, finalized: true,
        chunks: [{ offset: 0, sizeBytes: 3 * 1024 * 1024, sha256: "hash", contentBase64 }] })))
    vi.stubGlobal("fetch", fetchMock)
    expect(await run(listSessionRaw("one", "previous"))).toHaveProperty("nextCursor", "opaque")
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/sessions/one/raw?limit=50&cursor=previous")
    const page = await run(readRawContent({ objectId: "raw-one", generation: 1 }))
    expect(page.chunks[0]?.contentBase64).toBe(contentBase64)
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/raw-objects/raw-one/content?generation=1&limit=1")
  })
  it("rejects a manifest above its object bound", async () => {
    const object = { objectId: "r", projectId: "p", sessionId: "s", sourceName: "source", mediaType: "text/plain", adapterId: "adapter", adapterVersion: "1",
      capturedAt: "now", clientRedacted: true, currentGeneration: 1, generationCount: 1, currentSizeBytes: 0, currentFinalized: true }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionId: "s", objects: Array.from({ length: 101 }, () => object) }))))
    await expect(run(listSessionRaw("s"))).rejects.toMatchObject({ reason: "decode" })
  })
})
