import assert from "node:assert/strict"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { acquireToolIdentityBaselines, toolIdentityBaselineMaximumBytes, verifyToolIdentityRelease } from "./tool-identity-release-gate.mjs"

const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), "atape-baseline-gate-test-"))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test("other releases do not download or execute the .9 transition", async () => {
  const result = await verifyToolIdentityRelease({ version: "0.5.8", releaseDirectory: "/unavailable" }, async () => { throw new Error("must not fetch") })
  assert.deepEqual(result, { required: false, reason: "other-release" })
})

test("the baseline caller pins public URLs, no credentials, deadline and exact integrity", async () => fixture(async root => {
  let calls = 0
  await assert.rejects(acquireToolIdentityBaselines(root, async (url, options) => {
    calls++
    assert.equal(url, "https://registry.npmjs.org/@atape/cli/-/cli-0.5.8.tgz")
    assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit")
    assert.ok(options.signal instanceof AbortSignal)
    return new Response("a rebuilt or tampered lookalike package")
  }), /fixed published integrity/)
  assert.equal(calls, 1)
  assert.deepEqual(await readdir(root), [])
}))

test("unavailable historical bytes fail instead of skipping the transition", async () => fixture(async root => {
  let cancelled = false
  await assert.rejects(acquireToolIdentityBaselines(root, async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 503 })), /download failed \(503\)/)
  assert.equal(cancelled, true)
  assert.deepEqual(await readdir(root), [])
}))

test("declared oversized archives are cancelled before reading or publishing", async () => fixture(async root => {
  let cancelled = false
  await assert.rejects(acquireToolIdentityBaselines(root, async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), {
    headers: { "content-length": String(toolIdentityBaselineMaximumBytes + 1) }
  })), /size bound/)
  assert.equal(cancelled, true)
  assert.deepEqual(await readdir(root), [])
}))

test("streamed archives have a byte bound even without Content-Length", async () => fixture(async root => {
  let cancelled = false
  await assert.rejects(acquireToolIdentityBaselines(root, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(toolIdentityBaselineMaximumBytes + 1)) },
    cancel() { cancelled = true }
  }))), /size bound/)
  assert.equal(cancelled, true)
  assert.deepEqual(await readdir(root), [])
}))
