// Controlled migration-aware v1 bridge used only by integration/package tests.
// The target private entries remain the real compiled distributable CLI.
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
import type { ClientConfig } from "@atape/domain"

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
  if (operation === "activate" || operation === "activate-manual") {
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
