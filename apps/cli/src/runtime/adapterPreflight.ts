import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"

type Entry = { readonly adapterId: string; readonly entry: string }
const Result = Schema.Struct({ token: Schema.String, result: Schema.Literals(["ready", "factory", "import"]),
  adapterId: Schema.optionalKey(Schema.String) })

const importer = `
const { parentPort, workerData: entries } = require("node:worker_threads");
setInterval(() => {}, 60000);
(async () => {
  for (const { adapterId, entry } of entries) {
    let imported;
    try { imported = await import(entry); }
    catch { parentPort.postMessage({ result: "import", adapterId }); return; }
    if (typeof imported.createAtapeAdapter !== "function") {
      parentPort.postMessage({ result: "factory", adapterId }); return;
    }
  }
  parentPort.postMessage({ result: "ready" });
})().catch(() => process.exit(1));
`

// Kept inline because both the npm CLI and copied updater are single bundles.
// The child supervisor never runs foreign code: it can terminate a blocked
// import thread even after the owning updater is killed and IPC disconnects.
// An acknowledgement makes the result observable before the child can exit.
const probe = `
import { Worker } from "node:worker_threads";
const { entries, token } = JSON.parse(process.argv[1]);
const worker = new Worker(${JSON.stringify(importer)}, { eval: true, workerData: entries, execArgv: [] });
let terminating = false, reported = false;
const stop = () => {
  if (terminating) return;
  terminating = true;
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 1000);
  worker.terminate().finally(() => process.exit(1));
};
process.on("disconnect", stop);
process.on("SIGTERM", stop);
if (!process.connected) stop();
process.on("message", message => { if (message?.token === token) process.exit(0); });
setTimeout(stop, 10000);
worker.once("error", stop);
worker.once("exit", () => { if (!terminating && !reported) stop(); });
worker.once("message", async result => {
  if (terminating) return;
  reported = true;
  await worker.terminate();
  if (terminating || !process.connected) { process.exit(1); return; }
  process.send({ token, ...result }, error => { if (error) process.exit(1); });
});
`

// The parent retains package leases until actual exit, including interruption.
// Foreign stdout/stderr are ignored, so inherited descendant pipes cannot keep
// the completion wait open. This is process isolation, not a code sandbox.
export const validateAdapterImports = (entries: ReadonlyArray<Entry>): Effect.Effect<void, Error> =>
  entries.length === 0 ? Effect.void : Effect.callback<void, Error>(resume => {
    const cancellation = new AbortController()
    const task = runProbe(entries, cancellation.signal)
    task.then(() => resume(Effect.void), cause => resume(Effect.fail(cause instanceof Error ? cause : new Error(String(cause)))))
    return Effect.promise(async () => { cancellation.abort(); await task.catch(() => {}) })
  })

const runProbe = (entries: ReadonlyArray<Entry>, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const token = randomUUID()
  const child = spawn(process.execPath, ["--input-type=module", "--eval", probe, JSON.stringify({ entries, token })], {
    env: process.env, stdio: ["ignore", "ignore", "ignore", "ipc"]
  })
  let result: typeof Result.Type | undefined
  let stopped: Error | undefined
  let force: ReturnType<typeof setTimeout> | undefined
  let completed = false
  const stop = (reason: Error) => {
    if (completed || stopped) return
    stopped = reason
    child.kill("SIGTERM")
    force = setTimeout(() => child.kill("SIGKILL"), 1_000)
  }
  const abort = () => stop(new Error("Adapter preflight cancelled."))
  const deadline = setTimeout(() => stop(new Error("Adapter import preflight exceeded its 10-second deadline.")), 10_000)
  const finish = (error?: Error) => {
    if (completed) return
    completed = true
    clearTimeout(deadline)
    clearTimeout(force)
    signal.removeEventListener("abort", abort)
    if (child.connected) child.disconnect()
    if (error) reject(error)
    else resolve()
  }
  child.on("message", message => {
    if (completed || stopped || result) return
    const decoded = Schema.decodeUnknownOption(Result)(message)
    if (decoded._tag !== "Some" || decoded.value.token !== token) return
    result = decoded.value
    if (result.result !== "ready" && !entries.some(entry => entry.adapterId === result?.adapterId)) {
      stop(new Error("Adapter preflight returned an invalid result."))
      return
    }
    child.send({ token }, error => { if (error) stop(new Error("Adapter preflight could not acknowledge completion.")) })
  })
  child.on("error", cause => {
    if (child.pid === undefined) finish(cause)
    else stop(cause)
  })
  child.once("exit", code => {
    if (stopped) finish(stopped)
    else if (code !== 0 || result === undefined) finish(new Error("Adapter preflight exited before confirming its export checks."))
    else if (result.result === "factory") finish(new Error(`Installed Adapter ${result.adapterId} does not export createAtapeAdapter(context).`))
    else if (result.result === "import") finish(new Error(`Installed Adapter ${result.adapterId} could not be imported during preflight.`))
    else finish()
  })
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
})
