import { CaptureJournals, CaptureJournalError } from "@atape/application"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { openCaptureJournal } from "./captureJournal.ts"
import { withCollectorInstallation } from "./collectorLayers.ts"
import { CaptureInstallation, captureFailure, captureInstallationPath, capturePathState, captureRoot, ensureCaptureDirectory,
  readCaptureInstallation, readCaptureMetadata, writeCaptureMetadata } from "./captureBinding.ts"

const AccountBinding = Schema.Struct({ protocol: Schema.Literal("atape.capture-account.v1"),
  instanceOrigin: Schema.String, userId: Schema.String, installationId: Schema.String, phase: Schema.Literals(["initializing", "ready"]) })

/** Versioned local bootstrap, serialized with the existing Collector state lock.
 * A ready marker never grants permission to recreate a missing database. */
export const makeCaptureJournalsLayer = (stateFile: string) => Layer.succeed(CaptureJournals, CaptureJournals.of({
  open: (account, limits) => withCollectorInstallation(stateFile, installationId => Effect.gen(function*() {
    const binding = { ...account, installationId }
    for (const value of Object.values(binding)) if (!value.trim() || value.includes("\0") || Buffer.byteLength(value) > 500)
      return yield* captureFailure("binding", "Collector capture identity exceeds its bounds.")
    const validOrigin = yield* Effect.try({ try: () => {
      const url = new URL(account.instanceOrigin)
      return url.origin === account.instanceOrigin && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
    }, catch: () => captureFailure("binding", "Collector capture instance origin is invalid.") })
    if (!validOrigin) return yield* captureFailure("binding", "Collector capture instance origin must be canonical.")
    const root = captureRoot(stateFile), installationPath = captureInstallationPath(stateFile)
    let installation = yield* readCaptureInstallation(stateFile)
    if (installation === null) {
      installation = { protocol: "atape.capture-installation.v1", installationId, phase: "initializing", accounts: [] } satisfies typeof CaptureInstallation.Type
      yield* writeCaptureMetadata(installationPath, installation, true)
    }
    if (installation.installationId !== installationId) return yield* captureFailure("binding", "Collector capture installation changed.")
    yield* ensureCaptureDirectory(root, installation.phase === "initializing")
    if (installation.phase === "initializing") {
      installation = { ...installation, phase: "ready" }
      yield* writeCaptureMetadata(installationPath, installation)
    }
    const key = createHash("sha256").update(JSON.stringify([account.instanceOrigin, account.userId])).digest("hex")
    const path = join(root, `${key}.sqlite`), markerPath = join(root, `${key}.binding.json`)
    let registered = installation.accounts.find(account => account.key === key)
    let marker = yield* readCaptureMetadata(markerPath, AccountBinding)
    if (registered === undefined) {
      if (marker !== null) return yield* captureFailure("corrupt", "Collector capture account is absent from its installation registry.")
      for (const candidate of [path, `${path}-wal`, `${path}-shm`]) if ((yield* capturePathState(candidate)) !== null)
        return yield* captureFailure("missing", "Unregistered Collector capture storage already exists.")
      if (installation.accounts.length >= 32) return yield* captureFailure("capacity", "Collector capture installation supports at most 32 accounts.")
      registered = { key, phase: "initializing" }
      installation = { ...installation, accounts: [...installation.accounts, registered] }
      yield* writeCaptureMetadata(installationPath, installation)
    }
    if (registered.phase === "ready" && marker?.phase !== "ready")
      return yield* captureFailure("missing", "Established Collector capture account binding is missing or incomplete; restore its existing state.")
    if (marker === null) {
      for (const candidate of [path, `${path}-wal`, `${path}-shm`]) if ((yield* capturePathState(candidate)) !== null)
        return yield* captureFailure("missing", "Collector capture journal exists without its account binding.")
      marker = { protocol: "atape.capture-account.v1", ...binding, phase: "initializing" } satisfies typeof AccountBinding.Type
      yield* writeCaptureMetadata(markerPath, marker, true)
    }
    if (marker.instanceOrigin !== account.instanceOrigin || marker.userId !== account.userId || marker.installationId !== installationId)
      return yield* captureFailure("binding", "Collector capture account binding changed.")
    if (marker.phase === "initializing") {
      const exists = (yield* capturePathState(path)) !== null
      if (!exists && ((yield* capturePathState(`${path}-wal`)) !== null || (yield* capturePathState(`${path}-shm`)) !== null))
        return yield* captureFailure("corrupt", "Incomplete Collector capture storage has orphaned SQLite files.")
      // No caller has received this journal yet. Validate and close before the
      // ready marker; restart can finish only this never-exposed initialization.
      yield* Effect.scoped(openCaptureJournal({ path, mode: exists ? "open" : "create", binding, limits }).pipe(Effect.asVoid))
      yield* writeCaptureMetadata(markerPath, { ...marker, phase: "ready" })
    }
    const journal = yield* openCaptureJournal({ path, mode: "open", binding, limits })
    if (registered.phase === "initializing") yield* writeCaptureMetadata(installationPath, {
      ...installation, accounts: installation.accounts.map(account => account.key === key ? { ...account, phase: "ready" } : account)
    })
    return journal
  })).pipe(Effect.mapError(error => error instanceof CaptureJournalError ? error : captureFailure(
    error.reason === "conflict" ? "binding" : error.reason === "decode" ? "corrupt" : "io", error.message)))
}))
