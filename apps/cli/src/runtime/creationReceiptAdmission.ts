import { Schema } from "effect"
import { constants } from "node:fs"
import { lstat, mkdir, open, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { acquireProcessLock } from "./processLock.ts"
import { updateDirectory } from "./runtimeFiles.ts"

export class CreationReceiptAdmissionError extends Schema.TaggedError<CreationReceiptAdmissionError>()("CreationReceiptAdmissionError", {
  reason: Schema.Literals(["busy", "storage"]),
  message: Schema.String
}) {}

const busy = (cause: unknown) => typeof cause === "object" && cause !== null && "errcode" in cause &&
  [5, 6].includes(Number(cause.errcode))
const fail = (reason: CreationReceiptAdmissionError["reason"], message: string): never => {
  throw new CreationReceiptAdmissionError({ reason, message })
}
const requireRollbackJournal = (database: DatabaseSync) => {
  if (database.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete")
    fail("storage", "Creation-proof coordination must retain rollback-journal OS exclusion.")
}

/** A pending native-session proof owns a shared OS lease, not a receipt file.
 * Callers acquire either kind of lease inside the short runtime writer barrier.
 * The shared lease alone survives across the interactive session. Process death
 * releases it, and exclusive acquisition never waits for a human to finish. */
export const createCreationReceiptAdmission = (home: string) => {
  const directory = updateDirectory(home), path = join(directory, "creation-receipts.lock.sqlite")
  const validateFile = async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const parent = await lstat(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink() || await realpath(directory) !== resolve(directory) ||
      parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0)
      fail("storage", "Creation-proof coordination must remain in private owned update storage.")
    const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
        fail("storage", "Creation-proof coordination must use a private owned file.")
    } finally { await file.close() }
  }
  const acquirePending = async (): Promise<() => void> => {
    try {
      await validateFile()
      // processLock owns one-time persistent initialization. Once initialized,
      // these read transactions neither rewrite storage nor allocate lock pages
      // on a full disk. A legacy empty file is initialized only while exclusive.
      for (let attempt = 0; attempt < 2; attempt++) {
        const database = new DatabaseSync(path)
        let retained = false
        try {
          database.exec("PRAGMA busy_timeout=0; BEGIN")
          requireRollbackJournal(database)
          if (database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='atape_process_lock'").get()) {
            // BEGIN alone is deferred. This real read establishes SQLite's
            // shared OS lock, including when the coordination table is empty.
            database.prepare("SELECT id FROM atape_process_lock LIMIT 1").get()
            retained = true
            let released = false
            return () => {
              if (released) return
              released = true
              try { database.exec("ROLLBACK") } finally { database.close() }
            }
          }
          database.exec("ROLLBACK")
        } finally { if (!retained) database.close() }
        const initialize = await acquireProcessLock(path) ?? fail("busy", "Creation-proof coordination is currently exclusive.")
        initialize()
      }
      return fail("storage", "Could not initialize creation-proof coordination.")
    } catch (cause) {
      if (cause instanceof CreationReceiptAdmissionError) throw cause
      if (busy(cause)) return fail("busy", "Creation-proof coordination is currently exclusive.")
      return fail("storage", "Could not acquire creation-proof coordination.")
    }
  }
  return {
    acquirePending,
    tryAcquireFence: async (): Promise<(() => void) | undefined> => {
      try {
        await validateFile()
        const database = new DatabaseSync(path)
        try { requireRollbackJournal(database) } finally { database.close() }
        return await acquireProcessLock(path)
      }
      catch (cause) {
        if (cause instanceof CreationReceiptAdmissionError) throw cause
        if (busy(cause)) return undefined
        return fail("storage", "Could not inspect pending creation-proof ownership.")
      }
    }
  }
}
