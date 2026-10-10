import { constants } from "node:fs"
import { mkdir, open } from "node:fs/promises"
import { dirname } from "node:path"
import { performance } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"

// The lock file is stable coordination storage, never evidence of ownership.
// SQLite holds OS exclusion until release or process exit, including SIGKILL.
// Separate handles also exclude concurrent owners in the same Node process.
export const acquireProcessLock = async (path: string, waitMs = 0): Promise<(() => void) | undefined> => {
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error("Invalid process lock wait budget.")
  const deadline = performance.now() + waitMs
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try {
    if (!(await file.stat()).isFile()) throw new Error("Invalid process lock file.")
  } finally { await file.close() }
  const database = new DatabaseSync(path)
  let acquired = false
  try {
    database.exec("PRAGMA busy_timeout=0")
    while (true) {
      try {
        database.exec("BEGIN EXCLUSIVE")
        if (!database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='atape_process_lock'").get()) {
          // A rollback-only transaction leaves a new database empty. Beginning
          // its next transaction then allocates a page, which fails on a full
          // disk even when the caller only needs exclusion to inspect state.
          // Initialize once while owned, preserving legacy empty lock inodes.
          database.exec("CREATE TABLE atape_process_lock(id INTEGER PRIMARY KEY); COMMIT")
          // COMMIT released exclusion. Reacquire through the same bounded loop;
          // neither initialization nor an existing file establishes ownership.
          continue
        }
        acquired = true
        let released = false
        return () => {
          if (released) return
          released = true
          try { database.exec("ROLLBACK") } finally { database.close() }
        }
      } catch (cause) {
        if (!busy(cause)) throw cause
        const remaining = deadline - performance.now()
        if (remaining <= 0) return undefined
        await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)))
        if (performance.now() >= deadline) return undefined
      }
    }
  } finally { if (!acquired) database.close() }
}

const busy = (cause: unknown) => typeof cause === "object" && cause !== null && "errcode" in cause &&
  [5, 6].includes(Number(cause.errcode))
