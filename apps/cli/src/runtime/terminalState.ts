import { Effect } from "effect"
import { spawn } from "node:child_process"

const stty = (args: ReadonlyArray<string>) => new Promise<string>((resolve, reject) => {
  const child = spawn("/bin/stty", [...args], { stdio: [0, "pipe", "pipe"] })
  let output = "", overflow = false
  child.stdout!.on("data", value => { output += String(value); if (output.length > 4096) { overflow = true; child.kill("SIGKILL") } })
  child.stderr!.resume()
  const timeout = setTimeout(() => { child.kill("SIGKILL") }, 2000)
  child.once("error", error => { clearTimeout(timeout); reject(error) })
  child.once("close", code => { clearTimeout(timeout); code === 0 && !overflow ? resolve(output.trim()) : reject(new Error("Unable to preserve the terminal state.")) })
})

/** Place outside the entire Adapter Scope so restoration follows child and monitor joins. */
export const withTerminalState = <A, E, R>(program: Effect.Effect<A, E, R>): Effect.Effect<A, E | Error, R> => Effect.acquireUseRelease(
  Effect.tryPromise({ try: async () => {
    if (!process.stdin.isTTY || !["darwin", "linux"].includes(process.platform)) throw new Error("Starting a session requires an interactive macOS or Linux terminal.")
    const token = await stty(["-g"])
    if (!token || token.length > 4096 || /[\s\0]/.test(token)) throw new Error("Unable to preserve the terminal state.")
    process.stdin.pause()
    return token
  }, catch: cause => cause instanceof Error ? cause : new Error(String(cause)) }),
  () => program,
  token => Effect.promise(() => stty([token])).pipe(Effect.asVoid)
)
