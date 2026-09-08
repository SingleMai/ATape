import { AdapterReleases } from "@atape/application"
import { Effect } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { makeAdapterReleasesLayer } from "./adapterReleases.ts"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it("keeps each official tool's 12-hour cache separate and bypasses it for an explicit check", async () => {
  const root = await mkdtemp(join(tmpdir(), "atape-tool-releases-")); roots.push(root)
  const calls: string[] = []
  const layer = makeAdapterReleasesLayer(root, async url => {
    calls.push(String(url))
    const name = decodeURIComponent(new URL(String(url)).pathname.slice(1).replace(/\/latest$/, ""))
    return Response.json({ name, version: name.endsWith("codex") ? "0.4.4" : "0.4.3" })
  })
  const latest = (id: string, cached = true) => Effect.runPromise(Effect.gen(function*() {
    return yield* (yield* AdapterReleases).latest(`@atape/adapter-${id}`, cached)
  }).pipe(Effect.provide(layer)))
  expect(await latest("codex")).toBe("0.4.4")
  expect(await latest("claude")).toBe("0.4.3")
  expect(await latest("codex")).toBe("0.4.4")
  expect(calls).toHaveLength(2)
  const file = join(root, "cache/adapter-codex-update.json")
  const cache = JSON.parse(await readFile(file, "utf8"))
  await writeFile(file, JSON.stringify({ ...cache, checkedAt: Date.now() - 12 * 60 * 60 * 1000 - 1 }))
  await latest("codex"); expect(calls).toHaveLength(3)
  await latest("codex", false); expect(calls).toHaveLength(4)
  await expect(latest("unknown")).rejects.toMatchObject({ _tag: "ToolUpdateError" })
  expect(calls).toHaveLength(4)
})

it("rejects wrong publishers, invalid stable versions and oversized metadata instead of caching them", async () => {
  for (const response of [Response.json({ name: "other", version: "0.4.4" }),
    Response.json({ name: "@atape/adapter-codex", version: "not-a-version" }), new Response("x".repeat(262145))]) {
    const root = await mkdtemp(join(tmpdir(), "atape-tool-release-invalid-")); roots.push(root)
    await expect(Effect.runPromise(Effect.gen(function*() {
      return yield* (yield* AdapterReleases).latest("@atape/adapter-codex", true)
    }).pipe(Effect.provide(makeAdapterReleasesLayer(root, async () => response))))).rejects.toMatchObject({ _tag: "ToolUpdateError" })
    await expect(readFile(join(root, "cache/adapter-codex-update.json"))).rejects.toMatchObject({ code: "ENOENT" })
  }
})
