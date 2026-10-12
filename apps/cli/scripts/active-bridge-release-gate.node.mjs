import assert from "node:assert/strict"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { acquireActiveBridgeBaselines, acquireRetainedActiveBridgeRelease, activeBridgeBaselineMaximumBytes, verifyActiveBridgeRelease } from "./active-bridge-release-gate.mjs"

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

for (const releaseChannel of [undefined, "inferred"]) {
  test(`unsupported implicit bridge acceptance rejects channel ${releaseChannel}`, async () => {
    let calls = 0
    await assert.rejects(verifyActiveBridgeRelease({ version: "0.5.12", releaseDirectory: "/unavailable", releaseChannel }, async () => {
      calls++; throw new Error("must not fetch")
    }), /explicit release channel/)
    assert.equal(calls, 0)
  })
}

test("POSIX target-owned acceptance requires genuine retained bridge artifacts", { skip: process.platform === "win32" }, async () => {
  let calls = 0
  await assert.rejects(verifyActiveBridgeRelease({ version: "0.5.12", releaseDirectory: "/unavailable", releaseChannel: "target-owned" }, async () => {
    calls++; throw new Error("must not fetch")
  }), /retained real bridge artifacts/)
  assert.equal(calls, 0)
})

test("native Windows target-owned caller reports no POSIX runtime before acquiring bridge artifacts", { skip: process.platform !== "win32" }, async () => {
  let calls = 0
  const result = await verifyActiveBridgeRelease({ version: "0.5.12", releaseDirectory: "/unavailable", releaseChannel: "target-owned" }, async () => {
    calls++; throw new Error("must not fetch")
  })
  assert.deepEqual(result, { required: false, reason: "no-posix-managed-runtime" })
  assert.equal(calls, 0)
})

test("retained bridge acquisition pins .11 public bytes independently of candidate and tags", async () => fixture(async root => {
  let calls = 0
  await assert.rejects(acquireRetainedActiveBridgeRelease(root, async (url, options) => {
    calls++
    assert.equal(url, "https://registry.npmjs.org/@atape/cli/-/cli-0.5.11.tgz")
    assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit")
    assert.ok(options.signal instanceof AbortSignal)
    return new Response("a rebuilt bridge is not a historical npm archive")
  }), /@atape\/cli@0\.5\.11 archive does not match its fixed published integrity/)
  assert.equal(calls, 1)
  assert.deepEqual(await readdir(root), [])
}))

test("unavailable retained bridge bytes fail closed without a synthetic feature descriptor", async () => fixture(async root => {
  let cancelled = false
  await assert.rejects(acquireRetainedActiveBridgeRelease(root, async () => new Response(new ReadableStream({
    cancel() { cancelled = true }
  }), { status: 404 })), /@atape\/cli@0\.5\.11 download failed \(404\)/)
  assert.equal(cancelled, true)
  assert.deepEqual(await readdir(root), [])
}))

test("retained bridge acquisition preserves the bounded stream contract", async () => fixture(async root => {
  let cancelled = false
  await assert.rejects(acquireRetainedActiveBridgeRelease(root, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(activeBridgeBaselineMaximumBytes + 1)) },
    cancel() { cancelled = true }
  }))), /size bound/)
  assert.equal(cancelled, true)
  assert.deepEqual(await readdir(root), [])
}))

test("reusing retained bridge files rejects relabeling and rechecks published integrity before every installed case", async () => fixture(async root => {
  if (process.platform === "win32") return
  await assert.rejects(verifyActiveBridgeRelease({ version: "0.5.12", releaseChannel: "target-owned", releaseDirectory: "/unavailable",
    bridgeRelease: { version: "0.5.12", directory: root }, baselineArchives: { cli: "/unavailable", codex: "/unavailable", claude: "/unavailable" }
  }, async () => { throw new Error("Reused archives must not be downloaded again") }), /genuine retained 0\.5\.11 bridge version/)
  await writeFile(join(root, "atape-cli-0.5.11.tgz"), "changed after acquisition")
  await assert.rejects(verifyActiveBridgeRelease({ version: "0.5.12", releaseChannel: "target-owned", releaseDirectory: "/unavailable",
    bridgeRelease: { version: "0.5.11", directory: root }, baselineArchives: { cli: "/unavailable", codex: "/unavailable", claude: "/unavailable" }
  }, async () => { throw new Error("Reused archives must not be downloaded again") }), /Retained @atape\/cli@0\.5\.11 archive does not match/)
}))

test("reusing .10 archives cannot bypass the installed caller's genuine historical integrity proof", async () => fixture(async root => {
  if (process.platform === "win32") return
  const cli = join(root, "cli.tgz")
  await writeFile(cli, "a substituted historical archive")
  await assert.rejects(verifyActiveBridgeRelease({ version: "0.5.12", releaseChannel: "legacy-bridge", releaseDirectory: "/unavailable",
    baselineArchives: { cli, codex: "/unavailable", claude: "/unavailable" }
  }, async () => { throw new Error("Reused archives must not be downloaded again") }), /Requires the exact npm-published @atape\/cli@0\.5\.10 archive/)
}))
