import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { acquireProcessLock } from "./processLock.ts"

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "atape-process-lock-"))
  temporaryDirectories.push(root)
  return { root, path: join(root, "owner.lock.sqlite") }
}

describe("OS-held process exclusion", () => {
  it("excludes same-process contenders, bounds waiting, and releases idempotently", async () => {
    const { path } = await fixture(), release = (await acquireProcessLock(path))!
    try {
      expect(await acquireProcessLock(path)).toBeUndefined()
      const started = performance.now()
      expect(await acquireProcessLock(path, 100)).toBeUndefined()
      expect(performance.now() - started).toBeGreaterThanOrEqual(90)
      expect(performance.now() - started).toBeLessThan(500)
    } finally { release(); release() }
    const reacquired = await acquireProcessLock(path)
    expect(reacquired).toBeTypeOf("function")
    reacquired?.()
  })

  it("admits a bounded waiter after release without replacing coordination storage", async () => {
    const { path } = await fixture(), release = (await acquireProcessLock(path))!
    const before = await stat(path)
    const pending = acquireProcessLock(path, 1_000)
    setTimeout(release, 50)
    const acquired = await pending
    try {
      expect(acquired).toBeTypeOf("function")
      expect((await stat(path)).ino).toBe(before.ino)
    } finally { acquired?.(); release() }
  })

  it("preserves a legacy empty lock while its process owns exclusion, then initializes the same file after release", async () => {
    const { root, path } = await fixture(), marker = join(root, "ready")
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
import { DatabaseSync } from "node:sqlite";
import { writeFile } from "node:fs/promises";
const database = new DatabaseSync(${JSON.stringify(path)});
database.exec("BEGIN EXCLUSIVE");
process.once("message", () => {
  database.exec("ROLLBACK");
  database.close();
  process.disconnect();
});
await writeFile(${JSON.stringify(marker)}, "ready");
`], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
    let release: (() => void) | undefined
    let releaseTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await expect.poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 3_000 }).toBe("ready")
      const before = await stat(path)
      expect(before.size).toBe(0)
      expect(await acquireProcessLock(path)).toBeUndefined()
      expect((await stat(path)).ino).toBe(before.ino)
      expect(await readFile(path)).toEqual(Buffer.alloc(0))
      const pending = acquireProcessLock(path, 1_000)
      releaseTimer = setTimeout(() => child.send("release", () => {}), 50)
      release = await pending
      expect(release).toBeTypeOf("function")
      const initialized = await stat(path)
      expect(initialized.ino).toBe(before.ino)
      expect(initialized.size).toBeGreaterThan(0)
    } finally { clearTimeout(releaseTimer); release?.(); child.kill("SIGKILL"); await exited }
  })

  it("keeps initialized coordination bytes unchanged across repeated acquisitions and releases", async () => {
    const { path } = await fixture()
    const release = await acquireProcessLock(path)
    expect(release).toBeTypeOf("function")
    release?.()
    const bytes = await readFile(path), before = await stat(path)
    expect(bytes.byteLength).toBeGreaterThan(0)
    for (let attempt = 0; attempt < 5; attempt++) {
      const held = await acquireProcessLock(path)
      try {
        expect(held).toBeTypeOf("function")
        expect((await stat(path)).ino).toBe(before.ino)
        expect(await readFile(path)).toEqual(bytes)
      } finally { held?.() }
      expect(await readFile(path)).toEqual(bytes)
    }
  })

  it("releases a killed process's exclusion immediately without stale-PID or age recovery", async () => {
    const { root, path } = await fixture(), marker = join(root, "ready")
    const module = fileURLToPath(new URL("./processLock.ts", import.meta.url))
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
import { acquireProcessLock } from ${JSON.stringify(module)};
import { writeFile } from "node:fs/promises";
const release = await acquireProcessLock(${JSON.stringify(path)});
if (!release) process.exit(2);
await writeFile(${JSON.stringify(marker)}, "ready");
setInterval(() => {}, 1000);
`], { stdio: "ignore" })
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
    try {
      await expect.poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 3_000 }).toBe("ready")
      const before = await stat(path)
      expect(await acquireProcessLock(path)).toBeUndefined()
      child.kill("SIGKILL")
      await exited
      const release = await acquireProcessLock(path)
      try {
        expect(release).toBeTypeOf("function")
        expect((await stat(path)).ino).toBe(before.ino)
      } finally { release?.() }
    } finally { child.kill("SIGKILL"); await exited }
  })
})
