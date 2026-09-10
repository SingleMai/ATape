import { CaptureJournalError } from "@atape/application"
import { constants } from "node:fs"
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"

export const CaptureInstallation = Schema.Struct({ protocol: Schema.Literal("atape.capture-installation.v1"),
  installationId: Schema.String, phase: Schema.Literals(["initializing", "ready"]),
  accounts: Schema.Array(Schema.Struct({ key: Schema.String, phase: Schema.Literals(["initializing", "ready"]) })) })
export const captureRoot = (stateFile: string) => `${stateFile}.captures`
export const captureInstallationPath = (stateFile: string) => `${stateFile}.capture-installation.json`
export const captureFailure = (reason: CaptureJournalError["reason"], message: string) => new CaptureJournalError({ reason, message })
const missing = (cause: unknown) => typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
export const capturePathState = (path: string) => Effect.tryPromise({
  try: () => lstat(path).catch(cause => { if (missing(cause)) return null; throw cause }),
  catch: () => captureFailure("io", "Could not inspect Collector capture state.")
})
export const readCaptureMetadata = <A>(path: string, schema: Schema.ConstraintDecoder<A>) => Effect.gen(function*() {
  const stat = yield* capturePathState(path)
  if (stat === null) return null
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return yield* captureFailure("corrupt", "Collector capture binding is not bounded regular metadata.")
  const value = yield* Effect.tryPromise({
    try: async () => {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const bytes = Buffer.alloc(4097), read = await file.read(bytes, 0, bytes.length, 0)
        if (read.bytesRead > 4096) throw new Error("metadata bound")
        return JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8")) as unknown
      } finally { await file.close() }
    }, catch: () => captureFailure("corrupt", "Collector capture binding could not be decoded.")
  })
  return yield* Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => captureFailure("corrupt", "Collector capture binding has an unsupported format.")))
})
export const readCaptureInstallation = (stateFile: string) => Effect.gen(function*() {
  const metadata = yield* readCaptureMetadata(captureInstallationPath(stateFile), CaptureInstallation)
  if (metadata === null && (yield* capturePathState(captureRoot(stateFile))) !== null)
    return yield* captureFailure("missing", "Collector capture storage exists without its installation binding.")
  if (metadata !== null && (metadata.accounts.length > 32 || new Set(metadata.accounts.map(account => account.key)).size !== metadata.accounts.length ||
    metadata.accounts.some(account => !/^[a-f0-9]{64}$/.test(account.key))))
    return yield* captureFailure("corrupt", "Collector capture account registry is invalid.")
  return metadata
})
export const writeCaptureMetadata = (path: string, value: unknown, createOnly = false) => Effect.tryPromise({
  try: async () => {
    const bytes = Buffer.from(JSON.stringify(value) + "\n")
    if (bytes.length > 4096) throw new Error("metadata bound")
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, "wx", 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      if (createOnly) await link(temporary, path)
      else await rename(temporary, path)
      const directory = await open(dirname(path), "r")
      try { await directory.sync() } finally { await directory.close() }
    } finally { await rm(temporary, { force: true }) }
  }, catch: () => captureFailure("io", "Could not durably bind Collector capture state.")
})
export const ensureCaptureDirectory = (path: string, initialize: boolean) => Effect.gen(function*() {
  let stat = yield* capturePathState(path)
  if (stat === null && initialize) {
    yield* Effect.tryPromise({ try: () => mkdir(path, { mode: 0o700 }), catch: () => captureFailure("io", "Could not initialize Collector capture storage.") })
    stat = yield* capturePathState(path)
  }
  if (stat === null) return yield* captureFailure("missing", "Established Collector capture storage is missing; restore its existing state.")
  if (!stat.isDirectory() || stat.isSymbolicLink()) return yield* captureFailure("binding", "Collector capture storage must be a regular directory.")
})
