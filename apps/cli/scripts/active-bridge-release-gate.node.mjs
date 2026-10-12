import assert from "node:assert/strict"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { acquireActiveBridgeBaselines, activeBridgeBaselineMaximumBytes, verifyActiveBridgeRelease } from "./active-bridge-release-gate.mjs"

const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), "atape-baseline-gate-test-"))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test("older releases do not download or execute the .11 transition", async () => {
  const result = await verifyActiveBridgeRelease({ version: "0.5.10", releaseDirectory: "/unavailable" }, async () => { throw new Error("must not fetch") })
  assert.deepEqual(result, { required: false, reason: "older-release" })
})

test("the baseline caller pins public URLs, no credentials, deadline and exact integrity", async () => fixture(async root => {
  let calls = 0
  await assert.rejects(acquireActiveBridgeBaselines(root, async (url, options) => {
    calls++
    assert.equal(url, "https://registry.npmjs.org/@atape/cli/-/cli-0.5.10.tgz")
    assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit")
    assert.ok(options.signal instanceof AbortSignal)
    return new Response("a rebuilt or tampered lookalike package")
  }), /fixed published integrity/)
  assert.equal(calls, 1)
  assert.deepEqual(await readdir(root), [])
}))

test("unavailable historical bytes fail instead of skipping the transition", async () => fixture(async root => {
  let cancelled = false
  await assert.rejects(acquireActiveBridgeBaselines(root, async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 503 })), /download failed \(503\)/)
  assert.equal(cancelled, true)
  assert.deepEqual(await readdir(root), [])
}))

test("declared oversized archives are cancelled before reading or publishing", async () => fixture(async root => {
  let cancelled = false
  await assert.rejects(acquireActiveBridgeBaselines(root, async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), {
    headers: { "content-length": String(activeBridgeBaselineMaximumBytes + 1) }
  })), /size bound/)
  assert.equal(cancelled, true)
  assert.deepEqual(await readdir(root), [])
}))

test("streamed archives have a byte bound even without Content-Length", async () => fixture(async root => {
  let cancelled = false
  await assert.rejects(acquireActiveBridgeBaselines(root, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(activeBridgeBaselineMaximumBytes + 1)) },
    cancel() { cancelled = true }
  }))), /size bound/)
  assert.equal(cancelled, true)
  assert.deepEqual(await readdir(root), [])
}))

for (const version of ["0.5.11", "0.6.0", "1.0.0"]) {
  test(`${version} cannot skip unavailable historical active bridge transition bytes`, async () => {
    if (process.platform === "win32") return
    let calls = 0
    await assert.rejects(verifyActiveBridgeRelease({ version, releaseDirectory: "/unavailable", releaseChannel: "legacy-bridge" }, async () => {
      calls++
      return new Response("unavailable", { status: 503 })
    }), /download failed \(503\)/)
    assert.equal(calls, 1)
  })
}

for (const releaseChannel of [undefined, "inferred", "target-owned"]) {
  test(`unsupported implicit bridge acceptance rejects channel ${releaseChannel}`, async () => {
    let calls = 0
    await assert.rejects(verifyActiveBridgeRelease({ version: "0.5.12", releaseDirectory: "/unavailable", releaseChannel }, async () => {
      calls++; throw new Error("must not fetch")
    }), releaseChannel === "target-owned" ? /retained real bridge artifacts/ : /explicit release channel/)
    assert.equal(calls, 0)
  })
}
