import { spawn } from "node:child_process"
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { createCreationReceiptAdmission } from "./creationReceiptAdmission.ts"
import { acquireProcessLock } from "./processLock.ts"

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
const fixture = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "atape-creation-admission-"))); homes.push(home)
  return { home, path: join(home, "updates", "creation-receipts.lock.sqlite"), admission: createCreationReceiptAdmission(home) }
}

describe("pending creation-proof OS admission through its caller Interface", () => {
  it("permits multiple shared owners and requires every owner to release before a bounded fence", async () => {
    const f = await fixture(), first = await f.admission.acquirePending(), second = await f.admission.acquirePending()
    const before = await stat(f.path), bytes = await readFile(f.path)
    try {
      expect(await f.admission.tryAcquireFence()).toBeUndefined()
      first(); first()
      expect(await f.admission.tryAcquireFence()).toBeUndefined()
      expect((await stat(f.path)).ino).toBe(before.ino)
      expect(await readFile(f.path)).toEqual(bytes)
    } finally { first(); second() }
    const fence = await f.admission.tryAcquireFence()
    try {
      expect(fence).toBeTypeOf("function")
      await expect(f.admission.acquirePending()).rejects.toMatchObject({ reason: "busy" })
      expect(await readFile(f.path)).toEqual(bytes)
    } finally { fence?.(); fence?.() }
    const resumed = await f.admission.acquirePending(); resumed()
    expect(await readFile(f.path)).toEqual(bytes)
  })

  it("reuses the persistent process-lock table without rewriting its initialized file", async () => {
    const f = await fixture(), initialize = await acquireProcessLock(f.path)
    initialize?.()
    const bytes = await readFile(f.path), before = await stat(f.path)
    for (let attempt = 0; attempt < 5; attempt++) {
      const pending = await f.admission.acquirePending(); pending()
      const fence = await f.admission.tryAcquireFence(); fence?.()
      expect(await readFile(f.path)).toEqual(bytes)
      expect((await stat(f.path)).ino).toBe(before.ino)
    }
  })

  it("releases orphaned shared ownership on process death without treating pending metadata as ownership", async () => {
    const f = await fixture(), marker = join(f.home, "ready")
    const module = fileURLToPath(new URL("./creationReceiptAdmission.ts", import.meta.url))
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
import { createCreationReceiptAdmission } from ${JSON.stringify(module)};
import { writeFile } from "node:fs/promises";
const release = await createCreationReceiptAdmission(${JSON.stringify(f.home)}).acquirePending();
await writeFile(${JSON.stringify(marker)}, "ready");
setInterval(() => {}, 1000);
`], { stdio: "ignore" })
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
    try {
      await expect.poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 3_000 }).toBe("ready")
      await writeFile(join(f.home, "pending.json"), JSON.stringify({ state: "pending" }))
      expect(await f.admission.tryAcquireFence()).toBeUndefined()
      child.kill("SIGKILL"); await exited
      const fence = await f.admission.tryAcquireFence()
      expect(fence).toBeTypeOf("function"); fence?.()
      expect(JSON.parse(await readFile(join(f.home, "pending.json"), "utf8"))).toEqual({ state: "pending" })
    } finally { child.kill("SIGKILL"); await exited }
  })

  it("does not initialize a legacy empty coordination file while its owner is exclusive", async () => {
    const f = await fixture(), marker = join(f.home, "ready")
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir(${JSON.stringify(join(f.home, "updates"))}, { mode: 0o700 });
const database = new DatabaseSync(${JSON.stringify(f.path)}); database.exec("BEGIN EXCLUSIVE");
await writeFile(${JSON.stringify(marker)}, "ready"); setInterval(() => {}, 1000);
`], { stdio: "ignore" })
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
    try {
      await expect.poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 3_000 }).toBe("ready")
      await chmod(f.path, 0o600)
      const before = await stat(f.path)
      await expect(f.admission.acquirePending()).rejects.toMatchObject({ reason: "busy" })
      expect(await f.admission.tryAcquireFence()).toBeUndefined()
      expect(await readFile(f.path)).toEqual(Buffer.alloc(0))
      child.kill("SIGKILL"); await exited
      const pending = await f.admission.acquirePending()
      try { expect((await stat(f.path)).ino).toBe(before.ino); expect((await stat(f.path)).size).toBeGreaterThan(0) }
      finally { pending() }
    } finally { child.kill("SIGKILL"); await exited }
  })

  it("rejects symlink or exposed coordination storage", async () => {
    const f = await fixture(), release = await f.admission.acquirePending(); release()
    await chmod(f.path, 0o644)
    await expect(f.admission.acquirePending()).rejects.toMatchObject({ reason: "storage" })
    await expect(f.admission.tryAcquireFence()).rejects.toMatchObject({ reason: "storage" })
    await rm(f.path); await symlink(join(f.home, "elsewhere"), f.path)
    await expect(f.admission.acquirePending()).rejects.toMatchObject({ reason: "storage" })
  })

  it("fails closed when changed journal mode would let an exclusive writer pass shared readers", async () => {
    const f = await fixture(), release = await f.admission.acquirePending(); release()
    const database = new DatabaseSync(f.path)
    try { database.exec("PRAGMA journal_mode=WAL") } finally { database.close() }
    await expect(f.admission.acquirePending()).rejects.toMatchObject({ reason: "storage" })
    await expect(f.admission.tryAcquireFence()).rejects.toMatchObject({ reason: "storage" })
  })
})
