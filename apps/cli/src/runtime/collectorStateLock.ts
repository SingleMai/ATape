import { CollectorStateError } from "@atape/application"
import { lstat, mkdir, open, readFile, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"

const hasCode = (cause: unknown, code: string): cause is NodeJS.ErrnoException => cause instanceof Error && "code" in cause && cause.code === code
const exists = async (path: string) => lstat(path).catch(cause => { if (hasCode(cause, "ENOENT")) return null; throw cause })
const busy = (cause: unknown) => typeof cause === "object" && cause !== null && "errcode" in cause && [5, 6].includes(Number(cause.errcode))

/** The SQLite writer lock serializes both current state writers and legacy-lock
 * cleanup. OS process exit releases it; there is no stale SQL lock to unlink.
 * A filesystem Promise cannot be canceled, so the complete critical section
 * remains uninterruptible until its actual writes settle. */
export const withCollectorStateLock = <A, E, R>(stateFile: string, work: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(acquire(stateFile), () => work.pipe(Effect.uninterruptible), lock => Effect.promise(lock.close))

const acquire = (stateFile: string) => Effect.tryPromise({
  try: async () => {
    await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 })
    const coordinationPath = `${stateFile}.lock.sqlite`
    let existing = await exists(coordinationPath)
    if (existing === null) {
      if (await exists(`${stateFile}.capture-installation.json`) || await exists(`${stateFile}.captures`)) {
        // Another first opener may have established both since our first lstat.
        existing = await exists(coordinationPath)
        if (existing === null) throw new Error("Collector coordination state is missing while captures exist; restore its existing state.")
      }
      if (existing === null) {
        try { const file = await open(coordinationPath, "wx", 0o600); await file.close() }
        catch (cause) { if (!hasCode(cause, "EEXIST")) throw cause }
        existing = await exists(coordinationPath)
      }
    }
    if (!existing?.isFile() || existing.isSymbolicLink()) throw new Error("Collector coordination state is not a regular file.")
    const db = new DatabaseSync(coordinationPath)
    let held = false
    try {
      db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL")
      const deadline = Date.now() + 5000
      for (;;) {
        try { db.exec("BEGIN IMMEDIATE"); held = true; break }
        catch (cause) {
          if (!busy(cause) || Date.now() >= deadline) throw cause
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      }
      const version = db.prepare("PRAGMA user_version").get()?.user_version
      if (version !== 0 && version !== 1) throw new Error("Unsupported Collector coordination format.")
      db.exec("PRAGMA user_version=1")
      // Retain the old file gate for an already-running legacy Collector. Only
      // one current writer can inspect/remove a stale legacy lock at a time.
      const lockPath = `${stateFile}.lock`
      for (;;) {
        try {
          const file = await open(lockPath, "wx", 0o600)
          try { await file.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await file.sync() }
          catch (cause) { await file.close(); await rm(lockPath, { force: true }); throw cause }
          return { close: async () => {
            try { await file.close(); await rm(lockPath, { force: true }) }
            finally { try { db.exec("COMMIT") } finally { db.close() } }
          } }
        } catch (cause) {
          if (!hasCode(cause, "EEXIST")) throw cause
          if (await stale(lockPath)) { await rm(lockPath, { force: true }); continue }
          if (Date.now() >= deadline) throw cause
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      }
    } catch (cause) {
      try { if (held && db.isTransaction) db.exec("ROLLBACK") } finally { db.close() }
      throw cause
    }
  }, catch: cause => new CollectorStateError({ reason: "io", message: `Could not lock Collector state: ${cause instanceof Error ? cause.message : "storage unavailable"}` })
})
const stale = async (path: string) => {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown }
    if (typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0) {
      try { process.kill(value.pid, 0); return false } catch (cause) { return hasCode(cause, "ESRCH") }
    }
  } catch { /* A legacy writer may still be writing its PID. */ }
  try { return Date.now() - (await stat(path)).mtimeMs > 30_000 } catch (cause) { return hasCode(cause, "ENOENT") }
}
