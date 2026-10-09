import { describe, expect, it, vi } from "vitest"
import { completedReleaseVersion, verifyPublishedRelease } from "./completedRelease.ts"

const githubURL = "https://api.github.com/repos/SingleMai/ATape/releases/latest"
const release = (overrides: Record<string, unknown> = {}) => ({
  tag_name: "v1.2.3", prerelease: false, draft: false, published_at: "2026-01-01T00:00:00Z", ...overrides
})
const activeSignal = () => new AbortController().signal

describe("completed official release metadata", () => {
  it("uses the final GitHub Release and pins each official package to that version", async () => {
    const requested: string[] = []
    const fetchMetadata: typeof fetch = async (url, options) => {
      const address = String(url)
      requested.push(address)
      expect(options?.redirect).toBe("error")
      expect(options?.signal).toBeDefined()
      if (address === githubURL) return Response.json(release())
      const name = address.includes("adapter-claude") ? "@atape/adapter-claude" : "@atape/cli"
      return Response.json({ name, version: "1.2.3" })
    }
    const version = await completedReleaseVersion(activeSignal(), fetchMetadata)
    expect(version).toBe("1.2.3")
    await verifyPublishedRelease(version, ["@atape/cli", "@atape/adapter-claude"], activeSignal(), fetchMetadata)
    expect(requested).toEqual([
      githubURL,
      "https://registry.npmjs.org/@atape%2fcli/1.2.3",
      "https://registry.npmjs.org/@atape%2fadapter-claude/1.2.3"
    ])
  })

  it("rejects partial publication and checks again after a package becomes available", async () => {
    let available = false
    let requests = 0
    const fetchMetadata: typeof fetch = async url => {
      requests++
      if (String(url).includes("adapter-codex") && !available) return new Response("missing", { status: 404 })
      return Response.json({ name: String(url).includes("adapter-codex") ? "@atape/adapter-codex" : "@atape/cli", version: "1.2.3" })
    }
    const names = ["@atape/cli", "@atape/adapter-codex"]
    await expect(verifyPublishedRelease("1.2.3", names, activeSignal(), fetchMetadata)).rejects.toThrow()
    available = true
    await expect(verifyPublishedRelease("1.2.3", names, activeSignal(), fetchMetadata)).resolves.toBeUndefined()
    expect(requests).toBe(4)
  })

  it.each([
    { prerelease: true }, { draft: true }, { published_at: null }, { published_at: "invalid" },
    { published_at: "9999-01-01T00:00:00Z" }, { tag_name: "1.2.3" },
    { tag_name: "v1.2.3-beta.1" }, { tag_name: "v1.2.3+build" }, { tag_name: "v01.2.3" },
    { tag_name: "v9007199254740992.2.3" }, { tag_name: null }
  ])("rejects an unpublished or invalid GitHub release: %j", async overrides => {
    await expect(completedReleaseVersion(activeSignal(), async () => Response.json(release(overrides)))).rejects.toThrow()
  })

  it("rejects mismatched package names or versions rather than accepting latest metadata", async () => {
    for (const manifest of [
      { name: "@atape/adapter-claude", version: "1.2.3" },
      { name: "@atape/cli", version: "1.2.4" },
      { name: "@atape/cli", version: 123 }
    ]) {
      await expect(verifyPublishedRelease("1.2.3", ["@atape/cli"], activeSignal(), async () => Response.json(manifest))).rejects.toThrow()
    }
  })

  it("rejects untrusted package selections or invalid versions before making a request", async () => {
    const fetchMetadata = vi.fn<typeof fetch>()
    for (const [version, names] of [
      ["latest", ["@atape/cli"]], ["1.2.3", ["@other/adapter-codex"]],
      ["1.2.3", ["@atape/cli", "@atape/adapter-unknown"]]
    ] as const) {
      await expect(verifyPublishedRelease(version, names, activeSignal(), fetchMetadata)).rejects.toThrow()
    }
    expect(fetchMetadata).not.toHaveBeenCalled()
  })

  it("bounds streamed metadata and cancels the reader on rejection", async () => {
    const cancelled = vi.fn()
    const bytes = new Uint8Array(128 * 1024)
    let reads = 0
    const response = new Response(new ReadableStream({
      pull(controller) { reads++; controller.enqueue(bytes) },
      cancel: cancelled
    }))
    await expect(completedReleaseVersion(activeSignal(), async () => response)).rejects.toThrow("too large")
    expect(cancelled).toHaveBeenCalledOnce()
    expect(reads).toBeLessThanOrEqual(4)
  })

  it("rejects oversized declared metadata, malformed JSON and unavailable responses", async () => {
    for (const response of [
      new Response("{}", { headers: { "content-length": String(256 * 1024 + 1) } }),
      new Response("not json"), new Response("unavailable", { status: 503 }), new Response(null)
    ]) {
      await expect(completedReleaseVersion(activeSignal(), async () => response)).rejects.toThrow()
    }
  })

  it("cancels a stalled body without waiting for a remote stream to cooperate", async () => {
    const cancelled = vi.fn()
    const cancellation = new AbortController()
    const response = new Response(new ReadableStream({ cancel: cancelled }))
    const pending = completedReleaseVersion(cancellation.signal, async () => response)
    await vi.waitFor(() => expect(response.body!.locked).toBe(true))
    const reason = new Error("cancelled by caller")
    cancellation.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(cancelled).toHaveBeenCalledOnce()
    expect(response.body!.locked).toBe(false)
  })

  it("does not start a request after cancellation and passes cancellation to an active request", async () => {
    const cancellation = new AbortController()
    cancellation.abort(new Error("already cancelled"))
    const neverCalled = vi.fn<typeof fetch>()
    await expect(completedReleaseVersion(cancellation.signal, neverCalled)).rejects.toThrow("already cancelled")
    expect(neverCalled).not.toHaveBeenCalled()

    const active = new AbortController()
    let requestSignal: AbortSignal | null | undefined
    const pending = completedReleaseVersion(active.signal, (_url, options) => {
      requestSignal = options?.signal
      return new Promise(() => {})
    })
    active.abort(new Error("cancel active request"))
    await expect(pending).rejects.toThrow("cancel active request")
    expect(requestSignal?.aborted).toBe(true)
  })

  it("bounds stalled requests and stalled bodies to ten seconds", async () => {
    vi.useFakeTimers()
    try {
      const pendingRequest = completedReleaseVersion(activeSignal(), () => new Promise(() => {}))
      const requestResult = expect(pendingRequest).rejects.toThrow("timed out")
      await vi.advanceTimersByTimeAsync(10_000)
      await requestResult

      const cancelled = vi.fn()
      const response = new Response(new ReadableStream({ cancel: cancelled }))
      const pendingBody = completedReleaseVersion(activeSignal(), async () => response)
      const bodyResult = expect(pendingBody).rejects.toThrow("timed out")
      await vi.advanceTimersByTimeAsync(10_000)
      await bodyResult
      expect(cancelled).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it("joins a request rejected during synchronous cancellation", async () => {
    const cancellation = new AbortController()
    const reason = new Error("cancelled while starting request")
    await expect(completedReleaseVersion(cancellation.signal, () => {
      cancellation.abort(reason)
      return Promise.reject(reason)
    })).rejects.toBe(reason)
  })
})
