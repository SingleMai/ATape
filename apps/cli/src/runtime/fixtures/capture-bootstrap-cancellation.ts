import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { Effect, Fiber } from "effect"
import { CaptureJournals } from "@atape/application"
import { makeCaptureJournalsLayer } from "../captureBootstrap.ts"

let input = ""
for await (const chunk of process.stdin) input += chunk
const { stateFile, account, limits } = JSON.parse(input)
const program = Effect.scoped(CaptureJournals.use(factory => factory.open(account, limits).pipe(Effect.map(journal => journal.binding))))
  .pipe(Effect.provide(makeCaptureJournalsLayer(stateFile)))
const original = fs.open
let stopped = false, allocated: string | undefined, interrupted = false, secondFinished = false
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const paused = deferred(), resume = deferred()
// Fault injection lives in this isolated process and operates at the real OS
// dependency: pause the first identity fsync while callers interrupt and reopen.
fs.open = async (...args: Parameters<typeof original>) => {
  const handle = await original(...args), path = args[0]
  if (!stopped && typeof path === "string" && path.startsWith(stateFile + ".") && path.endsWith(".tmp") && !path.includes(".capture")) {
    stopped = true
    const sync = handle.sync.bind(handle)
    handle.sync = async () => {
      allocated = JSON.parse(await fs.readFile(path, "utf8")).installationId
      paused.resolve(); await resume.promise; await sync()
    }
  }
  return handle
}
syncBuiltinESMExports()
try {
  const first = Effect.runFork(program)
  await paused.promise
  const interruption = Effect.runPromise(Fiber.interrupt(first)).then(() => { interrupted = true })
  const second = Effect.runPromise(program).then(value => { secondFinished = true; return value })
  await new Promise(resolve => setTimeout(resolve, 150))
  const during = { interrupted, secondFinished }
  resume.resolve(); await interruption
  const binding = await second, stored = JSON.parse(await fs.readFile(stateFile, "utf8"))
  assert.deepEqual(during, { interrupted: false, secondFinished: false })
  assert.equal(binding.installationId, allocated)
  assert.equal(stored.installationId, allocated)
  process.stdout.write(JSON.stringify({ installationId: allocated, preserved: true }))
} finally {
  resume.resolve(); fs.open = original; syncBuiltinESMExports()
}
