// HTTP/PostgreSQL test binding. This is not a shipped CLI or scripting Interface.
// Start uses the installed executable; bounded upgrade cycles use the source Host.
import { Effect, Layer, Schema } from "effect"
import { installAdapter, upgradeAdapters, runCollector, startManagedCollector, stopManagedCollector, inspectManagedCollector } from "@atape/application"
import { defaultNodeClientPaths, makeNodeClientLayer } from "../clientLayers.ts"
import { makeNodeCollectorDaemonLayer } from "../collectorDaemonLayers.ts"

const chunks: Buffer[] = []
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
const input = Schema.decodeUnknownSync(Schema.Struct({
  entry: Schema.String,
  phase: Schema.Literals(["start", "stop", "inspect", "install", "upgrade", "cycle"]),
  argument: Schema.optional(Schema.String),
  concurrency: Schema.optional(Schema.Number)
}))(JSON.parse(Buffer.concat(chunks).toString("utf8")))
const paths = defaultNodeClientPaths()
const result = await Effect.runPromise(Effect.gen(function*() {
  switch (input.phase) {
    case "start": return yield* startManagedCollector({ intervalMs: 10000, concurrency: input.concurrency ?? 1 })
    case "stop": return { stopped: yield* stopManagedCollector() }
    case "inspect": return yield* inspectManagedCollector()
    case "install": return yield* installAdapter(input.argument!)
    case "upgrade": return { adapters: yield* upgradeAdapters(input.argument!) }
    case "cycle": return yield* runCollector({ once: true, projectId: input.argument! })
  }
}).pipe(Effect.provide(Layer.merge(makeNodeClientLayer(paths), makeNodeCollectorDaemonLayer(paths, input.entry)))))
process.stdout.write(JSON.stringify(result))
