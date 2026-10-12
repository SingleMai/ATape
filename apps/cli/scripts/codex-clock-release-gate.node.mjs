import assert from "node:assert/strict"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { acquireCodexClockBaselines, codexClockBaselineMaximumBytes, verifyCodexClockRelease } from "./codex-clock-release-gate.mjs"

const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), "atape-baseline-gate-test-"))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test("other releases do not download or execute the .10 transition", async () => {
  const result = await verifyCodexClockRelease({ version: "0.5.9", releaseDirectory: "/unavailable" }, async () => { throw new Error("must not fetch") })
  assert.deepEqual(result, { required: false, reason: "older-release" })
})

test("the baseline caller pins public URLs, no credentials, deadline and exact integrity", async () => fixture(async root => {
  let calls = 0
  await assert.rejects(acquireCodexClockBaselines(root, async (url, options) => {
    calls++
    assert.equal(url, "https://registry.npmjs.org/@atape/cli/-/cli-0.5.9.tgz")
    assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit")
    assert.ok(options.signal instanceof AbortSignal)
    return new Response("a rebuilt or tampered lookalike package")
  }), /fixed published integrity/)
  assert.equal(calls, 1)
  assert.deepEqual(await readdir(root), [])
}))

test("unavailable historical bytes fail instead of skipping the transition", async () => fixture(async root => {
  let cancelled = false
  await assert.rejects(acquireCodexClockBaselines(root, async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 503 })), /download failed \(503\)/)
  assert.equal(cancelled, true)
  assert.deepEqual(await readdir(root), [])
}))

test("declared oversized archives are cancelled before reading or publishing", async () => fixture(async root => {
  let cancelled = false
  await assert.rejects(acquireCodexClockBaselines(root, async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), {
    headers: { "content-length": String(codexClockBaselineMaximumBytes + 1) }
  })), /size bound/)
  assert.equal(cancelled, true)
  assert.deepEqual(await readdir(root), [])
}))

test("streamed archives have a byte bound even without Content-Length", async () => fixture(async root => {
  let cancelled = false
  await assert.rejects(acquireCodexClockBaselines(root, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(codexClockBaselineMaximumBytes + 1)) },
    cancel() { cancelled = true }
  }))), /size bound/)
  assert.equal(cancelled, true)
  assert.deepEqual(await readdir(root), [])
}))

for (const version of ["0.5.10", "0.5.11", "0.6.0", "1.0.0"]) {
  test(`${version} cannot skip unavailable historical clock transition bytes`, async () => {
    if (process.platform === "win32") return
    let calls = 0
    await assert.rejects(verifyCodexClockRelease({ version, releaseDirectory: "/unavailable" }, async () => {
      calls++
      return new Response("unavailable", { status: 503 })
    }), /download failed \(503\)/)
    assert.equal(calls, 1)
  })
}
