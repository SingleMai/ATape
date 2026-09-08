import { GitAttributionError, GitSourceBinding, GitSourceBindings, type GitBindingScope } from "@atape/application"
import { Effect, Layer, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { link, mkdir, open, rm } from "node:fs/promises"
import { join } from "node:path"

const MaxBindingBytes = 32 * 1024
const decode = Schema.decodeUnknownSync(GitSourceBinding)

export const makeGitSourceBindingsLayer = (directory: string) => {
  const pathFor = (scope: GitBindingScope, sourceId: string) => join(directory,
    createHash("sha256").update(JSON.stringify([
      scope.instanceOrigin, scope.userId, scope.id, scope.createdAt, scope.adapterId, sourceId
    ])).digest("hex") + ".json")
  return Layer.succeed(GitSourceBindings, GitSourceBindings.of({
    read: (scope, sourceId) => bindingIO(() => readBinding(pathFor(scope, sourceId))),
    remember: (scope, sourceId, binding) => bindingIO(async () => {
      const path = pathFor(scope, sourceId)
      const bytes = JSON.stringify(decode(binding)) + "\n"
      if (Buffer.byteLength(bytes) > MaxBindingBytes) throw new Error("Binding too large")
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = join(directory, `.binding-${randomUUID()}.tmp`)
      try {
        const handle = await open(temporary, "wx", 0o600)
        try { await handle.writeFile(bytes); await handle.sync() }
        finally { await handle.close() }
        try { await link(temporary, path) }
        catch (cause) { if (!hasCode(cause, "EEXIST")) throw cause }
        const parent = await open(directory, constants.O_RDONLY)
        try { await parent.sync() } finally { await parent.close() }
        const winner = await readBinding(path)
        if (!winner) throw new Error("Binding disappeared")
        return winner
      } finally { await rm(temporary, { force: true }) }
    })
  }))
}

const readBinding = async (path: string): Promise<GitSourceBinding | undefined> => {
  let handle
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (cause) { if (hasCode(cause, "ENOENT")) return undefined; throw cause }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MaxBindingBytes) throw new Error("Invalid binding file")
    // A bounded read also handles a concurrently enlarged/corrupt local file.
    const bytes = Buffer.alloc(MaxBindingBytes + 1)
    let size = 0
    while (size < bytes.length) {
      const next = await handle.read(bytes, size, bytes.length - size, size)
      if (next.bytesRead === 0) break
      size += next.bytesRead
    }
    if (size > MaxBindingBytes) throw new Error("Binding too large")
    return decode(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))))
  } finally { await handle.close() }
}
const hasCode = (cause: unknown, code: string) => cause instanceof Error && "code" in cause && cause.code === code
const bindingIO = <A>(run: () => Promise<A>) => Effect.tryPromise({
  try: run,
  catch: () => new GitAttributionError({ reason: "io", message: "Could not read or preserve local Git source attribution. Existing evidence was not replaced." })
})
