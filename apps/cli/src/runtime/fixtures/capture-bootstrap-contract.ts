// Independent first-open processes exercise the same Collector installation lock.
import { readFileSync } from "node:fs"
import { Effect } from "effect"
import { CaptureJournals, type CaptureBinding, type CaptureJournalLimits, type CaptureScope } from "@atape/application"
import { makeCaptureJournalsLayer } from "../captureBootstrap.ts"
const input = JSON.parse(readFileSync(0, "utf8")) as { stateFile: string; account: Pick<CaptureBinding, "instanceOrigin" | "userId">; limits: CaptureJournalLimits; scope: CaptureScope }
const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const factory = yield* CaptureJournals, journal = yield* factory.open(input.account, input.limits)
  const owner = yield* journal.claim(input.scope)
  return { installationId: journal.binding.installationId, epoch: owner.epoch }
})).pipe(Effect.provide(makeCaptureJournalsLayer(input.stateFile))))
process.stdout.write(JSON.stringify(result))
