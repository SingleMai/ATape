import { execFile } from "node:child_process"

// Abort requests termination; only process completion settles the operation.
// In particular, AbortError must not release the installation lock early.
export const executeOwnedProcess = (file: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, timeout: number) =>
  new Promise<string>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    let stopped: Error | undefined
    let force: ReturnType<typeof setTimeout> | undefined
    const child = execFile(file, args, { env, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      clearTimeout(deadline)
      clearTimeout(force)
      signal.removeEventListener("abort", abort)
      if (stopped || error) reject(stopped ?? error)
      else resolve(stdout)
    })
    const stop = (reason: Error) => {
      if (stopped) return
      stopped = reason
      child.kill("SIGTERM")
      force = setTimeout(() => child.kill("SIGKILL"), 1_000)
    }
    const abort = () => stop(new Error("Upgrade cancelled"))
    const deadline = setTimeout(() => stop(new Error("Upgrade process timed out")), timeout)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
