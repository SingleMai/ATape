// Controlled migration-aware v1 bridge used only by integration/package tests.
// The target private entries remain the real compiled distributable CLI.
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Effect } from "effect"
import { CaptureJournals } from "@atape/application"
import { createCaptureMigrationCoordinator } from "../captureMigration.ts"
import { activateManagedCaptureUpdate, recoverManagedCaptureUpdate, type PreparedCaptureUpdate } from "../managedCaptureUpdates.ts"
import { acquireUpdateWorker } from "../managedUpdates.ts"
import { createUpdateControl, type UpdateRuntimeSelection } from "../updateControl.ts"
import { applyRuntimeSelection } from "../runtimeSelection.ts"
import { makeCaptureJournalsLayer } from "../captureBootstrap.ts"
import { runtimeContext } from "../runtimeAdmission.ts"
import type { NodeClientPaths } from "../clientPaths.ts"
import { updateTargetProtocol, type ClientConfig, type TargetReleaseBundle } from "@atape/domain"
import { atomicJSON } from "../runtimeFiles.ts"
import { acquireTargetUpdateExecution, advanceTargetUpdate, beginTargetUpdate, finishTargetUpdate, readTargetUpdateHandoff,
  writeTargetUpdateReceipt } from "../targetUpdate.ts"
import { join } from "node:path"

const [operation, payloadFile] = process.argv.slice(2)
const payload = JSON.parse(await readFile(payloadFile!, "utf8")) as {
  paths: NodeClientPaths; source: UpdateRuntimeSelection; candidate: PreparedCaptureUpdate;
  account: { instanceOrigin: string; userId: string }; limits: { unitBytes: number; targetBytes: number; pendingBytes: number;
    metadataEntries: number; unitsPerTarget: number; recordsPerTarget: number }
}
const { paths, source, candidate } = payload
const config = () => readFile(paths.configFile, "utf8").then(bytes => JSON.parse(bytes) as ClientConfig)
const release = await acquireUpdateWorker(paths.atapeHome)
if (!release) throw new Error("Another updater owns the isolated fixture.")
try {
  const signal = AbortSignal.timeout(40_000)
  if (operation?.startsWith("target-owned-")) {
    let job = await readTargetUpdateHandoff(paths.atapeHome)
    if (!job) {
      const bundle: TargetReleaseBundle = { protocol: "atape.release-bundle.v3", version: candidate.bundle.version,
        captureStateContract: candidate.bundle.captureStateContract, updateControlProtocol: candidate.bundle.updateControlProtocol,
        updateTargetProtocol, fromCaptureStateContracts: candidate.bundle.migration.fromCaptureStateContracts,
        packages: candidate.bundle.packages }
      job = await beginTargetUpdate(paths, { bundle, bootstrapEntry: source.bootstrapEntry, automatic: true })
      job = await advanceTargetUpdate(job, "prepared", randomUUID())
      job = await advanceTargetUpdate(job, "activating", job.preparedKey!)
    }
    const executionRelease = await acquireTargetUpdateExecution(paths.atapeHome)
    if (!executionRelease) throw new Error("Another target owns the isolated fixture.")
    let settled = false
    try {
      if (operation === "target-owned-activate") {
        await activateManagedCaptureUpdate(paths, source.bootstrapEntry, source, candidate, true, process.env, signal, job)
        settled = true
        process.stdout.write('{"activated":true}\n')
      } else if (operation === "target-owned-recover") {
        settled = await recoverManagedCaptureUpdate(paths, source.bootstrapEntry, process.env, job)
        process.stdout.write(`${JSON.stringify({ recovered: settled })}\n`)
      } else {
        const migration = createCaptureMigrationCoordinator(paths, process.env), control = createUpdateControl(paths.atapeHome)
        const candidateConfig = applyRuntimeSelection(await config(), candidate.selection)
        const proof = await migration.preflight({ bundle: candidate.bundle, target: candidate.selection,
          source: { version: source.version, captureStateContract: source.captureStateContract }, candidateConfig, wanted: false }, signal)
        const outer = { key: randomUUID(), target: candidate.selection }
        await migration.saveTargetAuthorization(proof, outer, job, { candidateConfig, wanted: false }, signal)
        if (operation !== "target-owned-interrupt-before-handoff") {
          await control.handoffTarget({ key: outer.key, previous: source, next: candidate.selection })
          if (operation === "target-owned-interrupt-after-authorization") {
            // Reconstruct the durable crash window: authorization was synced,
            // but removal of the exact earlier intent did not reach storage.
            // Both records are produced by the real caller Interface.
            const intentFile = join(paths.atapeHome, "updates", "target-capture-intents", `${job.id}.json`)
            const intent = JSON.parse(await readFile(intentFile, "utf8"))
            await migration.consumeTargetAuthorization(job, signal)
            await atomicJSON(intentFile, intent)
          }
        }
        process.stdout.write(`${JSON.stringify({ interrupted: operation, outerKey: outer.key, jobId: job.id })}\n`)
      }
    } finally { executionRelease() }
    if (settled) await finishTargetUpdate(job, await writeTargetUpdateReceipt(job, "recover", { status: "completed", internalPending: false }))
  } else if (operation === "activate" || operation === "activate-manual") {
    await activateManagedCaptureUpdate(paths, source.bootstrapEntry, source, candidate, operation === "activate", process.env, signal)
    process.stdout.write('{"activated":true}\n')
  } else if (operation === "recover") {
    process.stdout.write(`${JSON.stringify({ recovered: await recoverManagedCaptureUpdate(paths, source.bootstrapEntry, process.env) })}\n`)
  } else if (operation === "interrupt-before-fence" || operation === "interrupt-after-fence") {
    // Deliberately stop between public durable operations. No ledger/receipt is
    // fabricated, and no target migration entry is substituted.
    const migration = createCaptureMigrationCoordinator(paths, process.env), control = createUpdateControl(paths.atapeHome)
    const candidateConfig = applyRuntimeSelection(await config(), candidate.selection)
    const proof = await migration.preflight({ bundle: candidate.bundle, target: candidate.selection, candidateConfig, wanted: false }, signal)
    const ticket = await control.prepare({ previous: source, next: candidate.selection })
    const outer = { key: ticket.key, target: candidate.selection }
    await migration.authorize(proof, outer, { candidateConfig, wanted: false }, signal)
    if (operation === "interrupt-after-fence") { await control.begin(ticket); await control.fence(ticket) }
    process.stdout.write(`${JSON.stringify({ interrupted: operation, outerKey: ticket.key })}\n`)
  } else if (operation === "write") {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const journals = yield* CaptureJournals, journal = yield* journals.open(payload.account, payload.limits)
      const owner = yield* journal.claim({ projectId: "project", adapterId: "claude", sourceSessionId: "session", originKey: "fixture-root" })
      return { checkpoint: owner.checkpoint, epoch: owner.epoch }
    })).pipe(Effect.provide(makeCaptureJournalsLayer(paths.collectorStateFile, runtimeContext(paths.atapeHome)))))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } else throw new Error("Unknown isolated fixture operation.")
} finally { release() }
