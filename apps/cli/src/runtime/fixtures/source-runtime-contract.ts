import { AdapterRuntimes } from "@atape/application"
import { Effect } from "effect"
import { makeNodeClientLayer } from "../clientLayers.ts"

const input = JSON.parse(process.argv[2]!)
const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const runtime = yield* AdapterRuntimes.use(runtimes => runtimes.open(input.project, input.adapter))
  if (!("sourceCapture" in runtime)) throw new Error("source capability missing")
  const view = yield* runtime.sourceCapture.open({ sourceId: input.sourceId, rawEnabled: false, limits: input.limits, projection: input.projection })
  let events = 0, rawFrames = 0
  for (;;) {
    const page = yield* view.read()
    for (const frame of page.frames) { events += frame.events.length; if (frame.raw !== undefined) rawFrames++ }
    if (page.done) break
  }
  return { events, rawFrames }
})).pipe(Effect.provide(makeNodeClientLayer(input.paths, {}))))
process.stdout.write(JSON.stringify(result))
