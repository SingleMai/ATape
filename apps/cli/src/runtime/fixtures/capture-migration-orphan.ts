// Test executable: IPC parks an owned authority without production crash hooks.
import { fork } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { Effect } from "effect"
import { acquireCaptureMigrationWriteAuthority, guardCaptureMigrationWrite, migrationError, type CaptureMigrationAttempt } from "../captureMigrationAdmission.ts"
import { runtimeContext } from "../runtimeAdmission.ts"

const [mode, payloadFile] = process.argv.slice(2)
const payload = JSON.parse(await readFile(payloadFile!, "utf8")) as { home: string; attempt: CaptureMigrationAttempt; socket: string; proofFile: string }
if (mode === "parent") {
  const child = fork(process.argv[1]!, ["child", payloadFile!], { stdio: ["ignore", "ignore", "inherit", "ipc"] })
  child.once("message", () => process.stdout.write(`${JSON.stringify({ childPid: child.pid })}\n`))
  await new Promise<void>((resolve, reject) => { child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Apply fixture exited ${code}`))) })
} else if (mode === "child") {
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const authority = yield* acquireCaptureMigrationWriteAuthority(runtimeContext(payload.home), payload.attempt)
    yield* Effect.acquireUseRelease(Effect.promise(() => new Promise<ReturnType<typeof createServer>>(resolve => {
      const server = createServer(socket => {
        socket.once("data", () => {
          void Effect.runPromise(guardCaptureMigrationWrite(authority, Effect.tryPromise({ try: () => writeFile(payload.proofFile, "unexpected old commit"), catch: migrationError }), migrationError).pipe(
            Effect.match({ onFailure: error => ({ reason: error.reason }), onSuccess: () => ({ reason: "unexpected-success" }) })
          )).then(result => socket.end(`${JSON.stringify(result)}\n`))
        })
      })
      server.listen(payload.socket, () => { process.send?.({ owned: true }); resolve(server) })
    })), server => Effect.promise(() => new Promise<void>(resolve => {
      server.once("connection", socket => socket.once("close", () => resolve()))
    })), server => Effect.promise(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))))
  })))
} else throw new Error("Unknown migration orphan fixture mode.")
