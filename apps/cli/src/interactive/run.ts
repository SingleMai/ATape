import { createElement } from "react"
import { render } from "ink"
import { Effect, ManagedRuntime } from "effect"
import type { ParsedCLI } from "../commands.ts"
import { makeNodeClientLayer, defaultNodeClientPaths } from "../runtime/clientLayers.ts"
import { ExperiencePresenter } from "./presenter.ts"
import { ExperienceView } from "./view.ts"
import { cliVersion } from "../version.ts"
import { restartInstalledCLI } from "../runtime/restartCLI.ts"

export const runInteractiveExperience = async (cli: ParsedCLI) => {
  const runtime = ManagedRuntime.make(makeNodeClientLayer(defaultNodeClientPaths()))
  let renderer: ReturnType<typeof render> | undefined
  let restart = false
  const presenter = new ExperiencePresenter((effect, signal) => runtime.runPromise(effect, { signal }), requested => {
    restart = Boolean(requested)
    renderer?.unmount()
  }, {
    path: cli.positionals[0] === "setup" ? cli.positionals[1] ?? process.cwd() : process.cwd(),
    setup: cli.positionals[0] === "setup", environment: process.env, version: cliVersion,
    ...(cli.options.instance ? { instance: cli.options.instance } : {}),
    ...(cli.options.noBrowser ? { noBrowser: true } : {})
  })
  const stop = () => presenter.close()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  try {
    renderer = render(createElement(ExperienceView, { presenter }), {
      exitOnCtrlC: false, alternateScreen: true, maxFps: 15
    })
    presenter.start()
    await renderer.waitUntilExit()
  } finally {
    presenter.close()
    renderer?.cleanup()
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
    await runtime.dispose()
  }
  if (restart) process.exitCode = await Effect.runPromise(restartInstalledCLI(process.argv[1]!, process.argv.slice(2), process.env))
}
