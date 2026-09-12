// Disposable PTY fixture preparation/cleanup. Never imported by the executable.
import { Effect } from "effect"
import { applyToolChange, installAdapter, planToolChange, stopManagedCollector } from "@atape/application"
import { defaultNodeClientPaths, makeNodeClientLayer } from "../clientLayers.ts"

await Effect.runPromise(Effect.gen(function*() {
  if (process.argv[2] === "stop") {
    yield* stopManagedCollector()
  } else {
    const source = process.argv[2]
    if (!source) throw new Error("A disposable integration fixture is required")
    yield* installAdapter(source)
    if (process.argv[3] === "enabled") yield* planToolChange(["smoke"]).pipe(Effect.flatMap(applyToolChange))
  }
}).pipe(Effect.provide(makeNodeClientLayer(defaultNodeClientPaths()))))
