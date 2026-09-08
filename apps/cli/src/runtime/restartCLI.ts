import { Effect } from "effect"
import { spawn } from "node:child_process"

// Called by the Composition Root only after Ink restores the terminal and the
// old runtime is disposed. Preserve the invocation, cwd and ATAPE_HOME.
export const restartInstalledCLI = (entry: string, args: string[], environment: NodeJS.ProcessEnv) => Effect.tryPromise({
  try: signal => new Promise<number>((resolve, reject) => {
    // Ink removes its listeners but may leave an in-flight stdin read. The old
    // process stays alive while the child runs and must relinquish input first.
    process.stdin.pause()
    const child = spawn(process.execPath, [entry, ...args], { env: environment, stdio: "inherit", signal })
    const interrupt = () => { child.kill("SIGINT") }
    const terminate = () => { child.kill("SIGTERM") }
    process.on("SIGINT", interrupt)
    process.on("SIGTERM", terminate)
    const cleanup = () => {
      process.removeListener("SIGINT", interrupt)
      process.removeListener("SIGTERM", terminate)
    }
    child.once("error", error => { cleanup(); reject(error) })
    child.once("exit", (code, exitSignal) => { cleanup(); resolve(code ?? (exitSignal === "SIGINT" ? 130 : 1)) })
  }),
  catch: () => new Error("ATape was updated, but could not reopen. Run atape again with the same ATAPE_HOME.")
})
