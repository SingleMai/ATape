import {
  CLIAuthenticationError,
  CLIAuthenticationGateway,
  CLIAuthenticationInteraction,
  CLICredentialStore,
  CLICredentialStoreError,
  CLIInteractionError,
  type CLIPollResult
} from "@atape/application"
import {
  CLIDeviceAuthorization as CLIDeviceAuthorizationSchema,
  CLICredentialFileVersion,
  IssuedCLICredential as IssuedCLICredentialSchema,
  StoredCLICredential as StoredCLICredentialSchema,
  normalizeInstanceOrigin,
  type InstanceMetadata,
  type StoredCLICredential
} from "@atape/domain"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import type { Stats } from "node:fs"
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink
} from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { Effect, Layer, Schema } from "effect"

const MaximumAuthenticationBodyBytes = 64 * 1024
const MaximumCredentialFileBytes = 16 * 1024

const WireInstanceMetadata = Schema.Struct({
  protocol: Schema.Literal("atape.instance.v1"),
  instance_origin: Schema.String,
  web_origin: Schema.String,
  api_origin: Schema.String,
  protocols: Schema.Array(Schema.String),
  release_version: Schema.String,
  auth_epoch: Schema.Literal("auth-v1"),
  minimum_cli_version: Schema.String
})

const WireDeviceAuthorization = Schema.Struct({
  protocol: Schema.Literal("atape.cli-authorization.v1"),
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number
})

const WireIssuedCredential = Schema.Struct({
  token_type: Schema.Literal("Bearer"),
  credential: Schema.String,
  credential_id: Schema.String,
  capability_version: Schema.Literal("atape-cli.v1"),
  created_at: Schema.String,
  user: Schema.Struct({ id: Schema.String, display_name: Schema.String })
})

const WirePending = Schema.Struct({
  status: Schema.Literal("authorization_pending"),
  retry_after: Schema.Number
})

const WireProblem = Schema.Struct({
  status: Schema.Number,
  code: Schema.String
})

export type NodeAuthenticationLayerOptions = {
  readonly atapeHome: string
  readonly credentialDirectory: string
  readonly fetch?: typeof globalThis.fetch
  readonly platform?: NodeJS.Platform
  readonly stderr?: Pick<NodeJS.WriteStream, "write">
}

export const makeNodeAuthenticationLayer = (options: NodeAuthenticationLayerOptions) => Layer.mergeAll(
  makeHTTPAuthenticationGatewayLayer(options.fetch ?? globalThis.fetch),
  makeCredentialStoreLayer(options.atapeHome, options.credentialDirectory),
  makeCLIAuthenticationInteractionLayer(options.platform ?? process.platform, options.stderr ?? process.stderr)
)

export const makeHTTPAuthenticationGatewayLayer = (fetchImplementation: typeof globalThis.fetch) => Layer.succeed(
  CLIAuthenticationGateway,
  CLIAuthenticationGateway.of({
    discover: (instanceOrigin) => request(fetchImplementation, `${instanceOrigin}/api/v1/instance`, {
      method: "GET",
      headers: { Accept: "application/json" }
    }).pipe(
      Effect.flatMap((response) => requireStatus(response, 200, "Instance discovery")),
      Effect.flatMap((response) => decodeBody(WireInstanceMetadata, response.body, "Instance discovery")),
      Effect.map((wire): InstanceMetadata => ({
        protocol: wire.protocol,
        instanceOrigin: wire.instance_origin,
        webOrigin: wire.web_origin,
        apiOrigin: wire.api_origin,
        protocols: wire.protocols,
        releaseVersion: wire.release_version,
        authEpoch: wire.auth_epoch,
        minimumCliVersion: wire.minimum_cli_version
      }))
    ),
    createDeviceAuthorization: (metadata) => request(fetchImplementation, `${metadata.apiOrigin}/api/v1/auth/cli/device-grants`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}"
    }).pipe(
      Effect.flatMap((response) => requireStatus(response, 201, "CLI authorization")),
      Effect.flatMap((response) => decodeBody(WireDeviceAuthorization, response.body, "CLI authorization")),
      Effect.map((wire) => ({
        protocol: wire.protocol,
        deviceCode: wire.device_code,
        userCode: wire.user_code,
        verificationUri: wire.verification_uri,
        verificationUriComplete: wire.verification_uri_complete,
        expiresInSeconds: wire.expires_in,
        intervalSeconds: wire.interval
      })),
      Effect.flatMap((authorization) => decodeValue(
        CLIDeviceAuthorizationSchema,
        authorization,
        "The Instance returned an invalid CLI authorization."
      ))
    ),
    pollDeviceAuthorization: (metadata, deviceCode) => request(
      fetchImplementation,
      `${metadata.apiOrigin}/api/v1/auth/cli/token`,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify({ device_code: deviceCode }) }
    ).pipe(
      Effect.flatMap((response): Effect.Effect<CLIPollResult, CLIAuthenticationError> => {
        if (response.status === 202) {
          return decodeBody(WirePending, response.body, "CLI authorization poll").pipe(
            Effect.flatMap((pending) => Number.isInteger(pending.retry_after) && pending.retry_after > 0
              ? Effect.succeed({ _tag: "Pending" as const, retryAfterSeconds: pending.retry_after })
              : Effect.fail(decodeFailure("The Instance returned an invalid polling interval.")))
          )
        }
        if (response.status === 200) {
          return decodeBody(WireIssuedCredential, response.body, "CLI credential grant").pipe(
            Effect.map((wire) => ({
              tokenType: wire.token_type,
              credential: wire.credential,
              credentialId: wire.credential_id,
              capabilityVersion: wire.capability_version,
              createdAt: wire.created_at,
              user: { id: wire.user.id, displayName: wire.user.display_name }
            })),
            Effect.flatMap((credential) => decodeValue(
              IssuedCLICredentialSchema,
              credential,
              "The Instance returned an invalid CLI credential grant."
            )),
            Effect.map((credential) => ({ _tag: "Authorized" as const, credential }))
          )
        }
        return responseFailure(response, "CLI authorization poll")
      })
    ),
    revokeCredential: (credential) => request(
      fetchImplementation,
      `${credential.apiOrigin}/api/v1/auth/cli/credentials/current`,
      {
        method: "DELETE",
        headers: { Accept: "application/json", Authorization: `Bearer ${credential.credential}` }
      }
    ).pipe(
      Effect.flatMap((response) => response.status === 204
        ? Effect.void
        : responseFailure(response, "CLI credential revocation"))
    )
  })
)

export const makeCredentialStoreLayer = (atapeHome: string, credentialDirectory: string) => Layer.succeed(
  CLICredentialStore,
  CLICredentialStore.of({
    read: (instanceOrigin) => readCredential(atapeHome, credentialDirectory, instanceOrigin),
    replace: ({ expectedCredentialId, credential }) => withCredentialLock(
      atapeHome,
      credentialDirectory,
      credential.instanceOrigin,
      Effect.gen(function*() {
        const current = yield* readCredential(atapeHome, credentialDirectory, credential.instanceOrigin)
        if (current?.credentialId !== expectedCredentialId) {
          return yield* storeError("conflict", "The CLI credential changed in another process.")
        }
        yield* persistCredential(credentialDirectory, credential)
      })
    ),
    remove: ({ instanceOrigin, expectedCredentialId }) => withCredentialLock(
      atapeHome,
      credentialDirectory,
      instanceOrigin,
      Effect.gen(function*() {
        const current = yield* readCredential(atapeHome, credentialDirectory, instanceOrigin)
        if (current === undefined) return false
        if (current.credentialId !== expectedCredentialId) return false
        const path = credentialPath(credentialDirectory, instanceOrigin)
        yield* Effect.tryPromise({
          try: async () => {
            await unlink(path)
            await syncDirectory(credentialDirectory)
          },
          catch: () => storeError("io", "Could not remove the local CLI credential.")
        })
        return true
      })
    )
  })
)

export const makeCLIAuthenticationInteractionLayer = (
  platform: NodeJS.Platform,
  stderr: Pick<NodeJS.WriteStream, "write">
) => Layer.succeed(CLIAuthenticationInteraction, CLIAuthenticationInteraction.of({
  presentChallenge: (challenge) => Effect.try({
    try: () => {
      stderr.write([
        `Sign in to ${challenge.instanceOrigin}`,
        `Open: ${challenge.verificationUri}`,
        `Code: ${challenge.userCode}`,
        "Waiting for browser approval…",
        ""
      ].join("\n"))
    },
    catch: () => new CLIInteractionError({ message: "Could not display the CLI authorization challenge." })
  }).pipe(Effect.asVoid),
  openBrowser: (uri) => Effect.promise(() => launchBrowser(platform, uri)).pipe(
    Effect.tap((opened) => opened
      ? Effect.void
      : Effect.sync(() => { stderr.write("Could not open a browser automatically; use the URL and code above.\n") }))
  )
}))

type HTTPResult = {
  readonly status: number
  readonly retryAfterSeconds?: number
  readonly body?: unknown
}

const jsonHeaders = { Accept: "application/json", "Content-Type": "application/json" } as const

const request = (
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  init: RequestInit
): Effect.Effect<HTTPResult, CLIAuthenticationError> => Effect.tryPromise({
  try: async (signal) => {
    const response = await fetchImplementation(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    })
    const bodyBytes = response.status === 204 ? new Uint8Array() : await readBoundedBody(response)
    let body: unknown = undefined
    if (bodyBytes.byteLength > 0) {
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
      if (!contentType.includes("application/json") && !contentType.includes("application/problem+json")) {
        throw new InvalidResponse("The server response was not JSON.")
      }
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes)) as unknown
      } catch {
        throw new InvalidResponse("The server response contained invalid JSON.")
      }
    }
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"))
    return {
      status: response.status,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      ...(body === undefined ? {} : { body })
    }
  },
  catch: (cause) => cause instanceof InvalidResponse
    ? decodeFailure(cause.message)
    : new CLIAuthenticationError({
      reason: "transport",
      message: "Could not reach the ATape Instance."
    })
})

const requireStatus = (
  response: HTTPResult,
  expected: number,
  operation: string
): Effect.Effect<HTTPResult, CLIAuthenticationError> => response.status === expected
  ? Effect.succeed(response)
  : responseFailure(response, operation)

const responseFailure = <A = never>(
  response: HTTPResult,
  operation: string
): Effect.Effect<A, CLIAuthenticationError> => decodeProblem(response).pipe(
  Effect.flatMap((problem) => {
    const retry = response.retryAfterSeconds
    switch (problem.code) {
      case "access_denied":
        return Effect.fail(new CLIAuthenticationError({
          reason: "authorization_denied", message: "The CLI authorization was denied."
        }))
      case "expired_token":
      case "login_expired":
        return Effect.fail(new CLIAuthenticationError({
          reason: "authorization_expired", message: "The CLI authorization expired."
        }))
      case "grant_consumed":
      case "invalid_device_code":
        return Effect.fail(new CLIAuthenticationError({
          reason: "authorization_consumed", message: "The CLI authorization can no longer be used."
        }))
      case "slow_down":
        return Effect.fail(new CLIAuthenticationError({
          reason: "slow_down",
          message: "The Instance asked the CLI to slow down polling.",
          ...(retry === undefined ? {} : { retryAfterSeconds: retry })
        }))
      case "unsupported_protocol_version":
        return Effect.fail(new CLIAuthenticationError({
          reason: "incompatible_instance", message: "The ATape Instance uses an incompatible protocol."
        }))
      case "service_unavailable":
      case "provider_unavailable":
        return Effect.fail(new CLIAuthenticationError({
          reason: "unavailable",
          message: `${operation} is temporarily unavailable.`,
          ...(retry === undefined ? {} : { retryAfterSeconds: retry })
        }))
      default:
        return Effect.fail(new CLIAuthenticationError({
          reason: response.status >= 500 ? "unavailable" : "decode",
          message: `${operation} was rejected by the Instance.`
        }))
    }
  })
)

const decodeProblem = (response: HTTPResult) => decodeValue(
  WireProblem,
  response.body,
  "The Instance returned an invalid error response."
)

const decodeBody = <A, I>(
  schema: Schema.Codec<A, I>,
  body: unknown,
  operation: string
) => decodeValue(schema, body, `${operation} returned an invalid response.`)

const decodeValue = <A, I>(schema: Schema.Codec<A, I>, value: unknown, message: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => decodeFailure(message))
  )

const decodeFailure = (message: string) => new CLIAuthenticationError({ reason: "decode", message })

class InvalidResponse extends Error {}

const readBoundedBody = async (response: Response): Promise<Uint8Array> => {
  const declared = response.headers.get("content-length")
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MaximumAuthenticationBodyBytes)) {
    await response.body?.cancel().catch(() => undefined)
    throw new InvalidResponse("The server response was too large.")
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MaximumAuthenticationBodyBytes) {
        await reader.cancel().catch(() => undefined)
        throw new InvalidResponse("The server response was too large.")
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

const parseRetryAfter = (value: string | null): number | undefined => {
  if (value === null || !/^\d+$/.test(value)) return undefined
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined
}

const credentialPath = (credentialDirectory: string, instanceOrigin: string) => join(
  credentialDirectory,
  `${createHash("sha256").update(instanceOrigin, "utf8").digest("hex")}.json`
)

const readCredential = (
  atapeHome: string,
  credentialDirectory: string,
  instanceOrigin: string
): Effect.Effect<StoredCLICredential | undefined, CLICredentialStoreError> => Effect.gen(function*() {
  yield* ensureCredentialDirectories(atapeHome, credentialDirectory)
  const path = credentialPath(credentialDirectory, instanceOrigin)
  const bytes = yield* Effect.tryPromise({
    try: async () => {
      let metadata
      try {
        metadata = await lstat(path)
      } catch (cause) {
        if (hasCode(cause, "ENOENT")) return undefined
        throw cause
      }
      assertPrivateCredentialFile(metadata)
      if (metadata.size > MaximumCredentialFileBytes) throw new UnsafeCredentialFile()
      const handle = await open(path, constants.O_RDONLY | noFollowFlag())
      try {
        return await handle.readFile()
      } finally {
        await handle.close()
      }
    },
    catch: (cause) => cause instanceof UnsafeCredentialFile
      ? storeError("unsafe", "The CLI credential file has unsafe ownership, mode, or type.")
      : storeError("io", "Could not read the local CLI credential.")
  })
  if (bytes === undefined) return undefined
  const value = yield* Effect.try({
    try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    catch: () => storeError("decode", "The local CLI credential file is invalid.")
  })
  const decoded = yield* Schema.decodeUnknownEffect(StoredCLICredentialSchema)(value).pipe(
    Effect.mapError(() => storeError("decode", "The local CLI credential file is invalid."))
  )
  if (decoded.instanceOrigin !== instanceOrigin) {
    return yield* storeError("decode", "The local CLI credential does not match its Instance.")
  }
  const normalizedInstance = normalizeInstanceOrigin(decoded.instanceOrigin, { allowLoopbackHttp: true })
  const normalizedAPI = normalizeInstanceOrigin(decoded.apiOrigin, { allowLoopbackHttp: true })
  if (normalizedInstance !== decoded.instanceOrigin || normalizedAPI !== decoded.apiOrigin ||
    (decoded.instanceOrigin.startsWith("https:") && !decoded.apiOrigin.startsWith("https:")) ||
    (decoded.instanceOrigin.startsWith("http:") && !decoded.apiOrigin.startsWith("http:"))) {
    return yield* storeError("decode", "The local CLI credential contains an invalid Instance topology.")
  }
  return decoded
})

const persistCredential = (
  credentialDirectory: string,
  credential: StoredCLICredential
): Effect.Effect<void, CLICredentialStoreError> => Schema.decodeUnknownEffect(StoredCLICredentialSchema)(credential).pipe(
  Effect.mapError(() => storeError("decode", "ATape refused to persist an invalid CLI credential.")),
  Effect.flatMap((validated) => Effect.tryPromise({
    try: async () => {
      const target = credentialPath(credentialDirectory, validated.instanceOrigin)
      const temporary = join(credentialDirectory, `.${randomUUID()}.credential.tmp`)
      let handle
      try {
        handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
          0o600
        )
        await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8")
        await handle.sync()
        await handle.close()
        handle = undefined
        await rename(temporary, target)
        await syncDirectory(credentialDirectory)
      } finally {
        await handle?.close().catch(() => undefined)
        await rm(temporary, { force: true }).catch(() => undefined)
      }
    },
    catch: () => storeError("io", "Could not save the local CLI credential.")
  }))
)

const ensureCredentialDirectories = (
  atapeHome: string,
  credentialDirectory: string
): Effect.Effect<void, CLICredentialStoreError> => Effect.tryPromise({
  try: async () => {
    const home = resolve(atapeHome)
    const credentials = resolve(credentialDirectory)
    const child = relative(home, credentials)
    if (child === "" || child.startsWith(`..${sep}`) || child === ".." || child.split(sep).length !== 1) {
      throw new UnsafeCredentialFile()
    }
    await ensurePrivateDirectory(home)
    await ensurePrivateDirectory(credentials)
  },
  catch: (cause) => cause instanceof UnsafeCredentialFile
    ? storeError("unsafe", "ATAPE_HOME or its credential directory has unsafe ownership, mode, or type.")
    : storeError("io", "Could not prepare the local credential directory.")
})

const ensurePrivateDirectory = async (path: string) => {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (cause) {
    if (!hasCode(cause, "EEXIST")) throw cause
  }
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !ownedByCurrentUser(metadata.uid) ||
    (metadata.mode & 0o777) !== 0o700) {
    throw new UnsafeCredentialFile()
  }
}

const assertPrivateCredentialFile = (metadata: Stats) => {
  if (metadata.isSymbolicLink() || !metadata.isFile() || !ownedByCurrentUser(metadata.uid) ||
    (metadata.mode & 0o777) !== 0o600) {
    throw new UnsafeCredentialFile()
  }
}

const ownedByCurrentUser = (uid: number): boolean => process.getuid === undefined || uid === process.getuid()

class UnsafeCredentialFile extends Error {}

const withCredentialLock = <A, E, R>(
  atapeHome: string,
  credentialDirectory: string,
  instanceOrigin: string,
  use: Effect.Effect<A, E, R>
): Effect.Effect<A, E | CLICredentialStoreError, R> => Effect.acquireUseRelease(
  acquireCredentialLock(atapeHome, credentialDirectory, instanceOrigin),
  () => use,
  (lock) => Effect.promise(async () => {
    await lock.close().catch(() => undefined)
    await rm(lock.path, { force: true }).catch(() => undefined)
  })
)

const acquireCredentialLock = (
  atapeHome: string,
  credentialDirectory: string,
  instanceOrigin: string
) => Effect.gen(function*() {
  yield* ensureCredentialDirectories(atapeHome, credentialDirectory)
  return yield* Effect.tryPromise({
    try: async () => {
      const path = `${credentialPath(credentialDirectory, instanceOrigin)}.lock`
      const deadline = Date.now() + 5_000
      while (true) {
        try {
          const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600)
          try {
            await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`)
            await handle.sync()
            return { path, close: () => handle.close() }
          } catch (cause) {
            await handle.close().catch(() => undefined)
            await unlink(path).catch(() => undefined)
            throw cause
          }
        } catch (cause) {
          if (!hasCode(cause, "EEXIST")) throw cause
          if (await staleLock(path)) {
            await unlink(path)
            continue
          }
          if (Date.now() >= deadline) throw cause
          await new Promise((done) => setTimeout(done, 50))
        }
      }
    },
    catch: (cause) => storeError(
      "io",
      hasCode(cause, "EEXIST")
        ? "Another ATape CLI process is updating this credential."
        : "Could not lock the local CLI credential."
    )
  })
})

const staleLock = async (path: string) => {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown }
    if (typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0) {
      try {
        process.kill(value.pid, 0)
        return false
      } catch (cause) {
        return hasCode(cause, "ESRCH")
      }
    }
  } catch {
    // A new lock can briefly be empty. It is removed only after aging out.
  }
  try {
    return Date.now() - (await stat(path)).mtimeMs > 30_000
  } catch (cause) {
    return hasCode(cause, "ENOENT")
  }
}

const syncDirectory = async (path: string) => {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const noFollowFlag = () => typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0

const launchBrowser = (platform: NodeJS.Platform, uri: string): Promise<boolean> => new Promise((resolveResult) => {
  const command = platform === "darwin"
    ? { file: "open", args: [uri] }
    : platform === "win32"
    ? { file: "rundll32", args: ["url.dll,FileProtocolHandler", uri] }
    : { file: "xdg-open", args: [uri] }
  const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" })
  let settled = false
  const settle = (value: boolean) => {
    if (settled) return
    settled = true
    if (value) child.unref()
    resolveResult(value)
  }
  child.once("spawn", () => settle(true))
  child.once("error", () => settle(false))
})

const storeError = (reason: CLICredentialStoreError["reason"], message: string) =>
  new CLICredentialStoreError({ reason, message })

const hasCode = (cause: unknown, code: string): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause && cause.code === code
