import { Data, Effect } from "effect"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { extname } from "node:path"
import { loadNodeRedactionPolicy } from "./redactionPolicy.ts"

export const localRedactionTestFileLimit = 16 * 1024 * 1024

type Format = "text" | "json" | "jsonl"
export class LocalRedactionTestError extends Data.TaggedError("LocalRedactionTestError")<{
  readonly reason: "read" | "limit" | "encoding"
  readonly message: string
}> {}

const fileError = () => new LocalRedactionTestError({ reason: "read", message: "Unable to read the local test file." })

// File acquisition is bounded before and during the read. Nonblocking open
// allows a non-regular input to be rejected without waiting on a pipe or device.
const readLocalFile = (path: string) => Effect.acquireUseRelease(
  Effect.tryPromise({ try: () => open(path, constants.O_RDONLY | constants.O_NONBLOCK), catch: fileError }),
  file => Effect.tryPromise({
    try: async () => {
      const info = await file.stat()
      if (!info.isFile()) throw fileError()
      if (info.size > localRedactionTestFileLimit) throw new LocalRedactionTestError({
        reason: "limit", message: "The local test file exceeds the 16 MiB limit."
      })
      const bytes = Buffer.alloc(Math.min(info.size + 1, localRedactionTestFileLimit + 1))
      let count = 0
      while (count < bytes.length) {
        const read = await file.read(bytes, count, bytes.length - count, count)
        if (read.bytesRead === 0) break
        count += read.bytesRead
      }
      // A growing file is not silently truncated into an apparently complete test.
      const after = await file.stat()
      if (count !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || count > localRedactionTestFileLimit) throw new LocalRedactionTestError({
        reason: "limit", message: "The local test file changed or exceeded its size limit."
      })
      try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count)) }
      catch { throw new LocalRedactionTestError({ reason: "encoding", message: "The local test file must contain valid UTF-8." }) }
    },
    catch: cause => cause instanceof LocalRedactionTestError ? cause : fileError()
  }),
  file => Effect.promise(() => file.close().catch(() => {}))
)

const inferFormat = (path: string): Format => {
  const extension = extname(path).toLowerCase()
  return extension === ".json" ? "json" : extension === ".jsonl" || extension === ".ndjson" ? "jsonl" : "text"
}

export const testLocalRedactionFile = Effect.fn("Redaction.testLocalFile")(function*(input: {
  readonly file: string
  readonly format?: Format
  readonly config?: string
  readonly environment?: NodeJS.ProcessEnv
}) {
  const policy = yield* loadNodeRedactionPolicy({ mode: "test",
    ...(input.config === undefined ? {} : { configFile: input.config }),
    ...(input.environment === undefined ? {} : { environment: input.environment }) })
  const content = yield* readLocalFile(input.file)
  return yield* policy.prepareFile({ content, format: input.format ?? inferFormat(input.file) })
})
