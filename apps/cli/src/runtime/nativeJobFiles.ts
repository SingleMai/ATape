import { constants } from "node:fs"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"

// Private native-job filesystem and descriptor safety shared by login and update
// wake registration. Policy and native manager lifetimes remain in their Modules.
export const makeNativeJobFiles = <E>(failure: (reason: "identity" | "state", message: string) => E, label: string) => {
  const missing = (cause: unknown) => typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
  const cleanText = (value: string) => {
    if (/[\x00-\x1f\x7f]/.test(value)) throw failure("identity", `ATape ${label} paths and public environment values cannot contain control characters.`)
    return value
  }
  const readBundle = async (file: string, maximumBundleBytes = 16 * 1024 * 1024) => {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size <= 0 || before.size > maximumBundleBytes || (before.mode & 0o022) !== 0) throw failure("identity", `The ATape ${label} bundle has unsafe type, size or permissions.`)
      const bundle = await boundedText(handle, maximumBundleBytes)
      const after = await handle.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || Buffer.byteLength(bundle) !== after.size) throw failure("state", `The ATape installation changed while preparing ${label}. Retry shortly.`)
      return bundle
    } finally { await handle.close() }
  }
  const readRegistration = async (location: { readonly base: string; readonly file: string }, uid: number | undefined) => {
    let directory = location.base
    for (const component of ["", ...dirname(location.file).slice(location.base.length + 1).split("/")]) {
      directory = join(directory, component)
      try {
        const info = await lstat(directory)
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022) !== 0) throw failure("identity", `The ${label} registration directory has unsafe ownership or permissions.`)
      } catch (cause) { if (missing(cause)) return undefined; throw cause }
    }
    return readPrivateFile(location.file, uid)
  }
  const privateDirectoryPresent = async (directory: string, uid: number | undefined) => {
    try {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0) throw failure("identity", `ATape ${label} metadata directory must be private and owned.`)
      return true
    } catch (cause) { if (missing(cause)) return false; throw cause }
  }
  const readPrivateFile = async (file: string, uid: number | undefined, limit = 256 * 1024): Promise<string | undefined> => {
    try {
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.size > limit) {
        throw failure("identity", `ATape ${label} files must be private, owned regular files.`)
      }
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const actual = await handle.stat()
        if (!actual.isFile() || actual.uid !== uid || (actual.mode & 0o077) !== 0 || actual.size > limit) throw failure("identity", `Unsafe ATape ${label} file.`)
        return await boundedText(handle, limit)
      } finally { await handle.close() }
    } catch (cause) { if (missing(cause)) return undefined; throw cause }
  }
  const boundedText = async (handle: Awaited<ReturnType<typeof open>>, limit: number) => {
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > limit) throw failure("state", `ATape ${label} state exceeds its size limit.`)
    return bytes.subarray(0, length).toString("utf8")
  }
  const secureDirectory = async (directory: string, uid: number | undefined, privateMode: boolean) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & (privateMode ? 0o077 : 0o022)) !== 0) {
      throw failure("identity", `ATape ${label} directories have unsafe ownership or permissions.`)
    }
  }
  const secureDirectoryTree = async (base: string, directory: string, uid: number | undefined) => {
    await secureDirectory(base, uid, false)
    const relative = directory.slice(base.length + 1).split("/")
    let current = base
    for (const component of relative) { current = join(current, component); await secureDirectory(current, uid, false) }
  }
  const writeOwned = async (file: string, content: string, uid: number | undefined, limit = 256 * 1024) => {
    if (Buffer.byteLength(content) > limit) throw failure("state", `ATape ${label} context is too large to persist safely.`)
    await readPrivateFile(file, uid, limit)
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, "wx", 0o600)
      try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
      await rename(temporary, file)
      const directory = await open(dirname(file), "r")
      try { await directory.sync() } finally { await directory.close() }
    } finally { await rm(temporary, { force: true }) }
  }
  const xml = (value: string) => cleanText(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")
  const unitQuote = (value: string, argument = false) => `"${cleanText(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", () => argument ? "$$" : "$")}"`
  // WorkingDirectory is a scalar path, not an ExecStart/Environment word list:
  // systemd keeps quotes and backslashes literally. The final /. protects a
  // trailing space or backslash in the home from line trimming/continuation.
  const unitDirectory = (value: string) => `${cleanText(value).replaceAll("%", "%%")}/.`
  return { cleanText, readBundle, readRegistration, privateDirectoryPresent, readPrivateFile, secureDirectory, secureDirectoryTree, writeOwned, xml, unitQuote, unitDirectory }
}
