import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

// Private filesystem primitives shared by the legacy bridge and update control.
// They do not interpret a capture contract or choose a recovery outcome.
export const runtimeSelectionFile = (home: string) => join(home, "releases", "current.json")
export const runtimeEntry = (home: string, version: string) => join(home, "releases", version, "node_modules", "@atape", "cli", "dist", "atape.js")
export const updateDirectory = (home: string) => join(home, "updates")
export const missing = (cause: unknown) => typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"

export const readBoundedJSON = async (path: string, limit = 256 * 1024): Promise<unknown> => {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error("Invalid managed update metadata.")
  const handle = await open(path, "r")
  try {
    const bytes = Buffer.alloc(limit + 1)
    const read = await handle.read(bytes, 0, bytes.length, 0)
    if (read.bytesRead > limit) throw new Error("Managed update metadata exceeds its limit.")
    return JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8")) as unknown
  } finally { await handle.close() }
}

export const atomicJSON = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, "wx", 0o600)
    try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
    const directory = await open(dirname(path), "r")
    try { await directory.sync() } finally { await directory.close() }
  } finally { await rm(temporary, { force: true }).catch(() => {}) }
}
