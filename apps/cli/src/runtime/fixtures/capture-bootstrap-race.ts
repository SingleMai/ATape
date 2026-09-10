import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { Effect } from "effect"
import { CaptureJournals } from "@atape/application"
import { makeCaptureJournalsLayer } from "../captureBootstrap.ts"

let input = ""
for await (const chunk of process.stdin) input += chunk
const { stateFile, account, limits } = JSON.parse(input)
const program = Effect.scoped(CaptureJournals.use(factory => factory.open(account, limits).pipe(Effect.map(journal => journal.binding))))
  .pipe(Effect.provide(makeCaptureJournalsLayer(stateFile)))
let pause!: () => void, resume!: () => void, stopped = false
const paused = new Promise<void>(resolve => { pause = resolve }), resumed = new Promise<void>(resolve => { resume = resolve })
const original = fs.lstat
fs.lstat = (async (...args: Parameters<typeof original>) => {
  try { return await original(...args) } catch (cause) {
    if (!stopped && args[0] === `${stateFile}.lock.sqlite`) {
      stopped = true; pause(); await resumed
    }
    throw cause
  }
}) as typeof original
syncBuiltinESMExports()
try {
  const first = Effect.runPromise(program)
  await paused
  const second = await Effect.runPromise(program)
  resume()
  assert.equal((await first).installationId, second.installationId)
  process.stdout.write(JSON.stringify({ installationId: second.installationId, preserved: true }))
} finally { resume(); fs.lstat = original; syncBuiltinESMExports() }
