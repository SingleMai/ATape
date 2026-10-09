import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { CLIInputError } from "../commandInput.ts"
import { delegateAdmittedLoginStartup, delegateManagedRuntime } from "./runtimeLauncher.ts"
import { managedStateContract, runtimeEntry, runtimeSelectionFile, selectRuntime } from "./runtimeSelection.ts"
import { acquireUpdateWorker } from "./updateOwnership.ts"

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const fixture = async (source?: string) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "atape-runtime-launcher-")))
  temporaryDirectories.push(home)
  const bootstrap = join(home, "bootstrap.js")
  await writeFile(bootstrap, 'console.log("bootstrap")')
  const entry = runtimeEntry(home, "1.2.3")
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(join(dirname(dirname(entry)), "package.json"), JSON.stringify({ name: "@atape/cli", version: "1.2.3", type: "module" }))
  await writeFile(entry, source ?? `import { writeFileSync } from "node:fs";
writeFileSync(process.env.LAUNCHER_TEST_OUTPUT, JSON.stringify({
  args: process.argv.slice(2), home: process.env.ATAPE_HOME, bootstrap: process.env.ATAPE_BOOTSTRAP_ENTRY,
  marker: process.env.LAUNCHER_TEST_MARKER, cwd: process.cwd()
})); process.exitCode = 7;`)
  await selectRuntime(home, { protocol: "atape.runtime.v1", stateContract: managedStateContract, version: "1.2.3",
    bootstrapEntry: bootstrap, adapters: [] })
  const output = join(home, "output.json")
  const environment = { ...process.env, ATAPE_HOME: home, ATAPE_RUNTIME_DIRECT: "0",
    LAUNCHER_TEST_OUTPUT: output, LAUNCHER_TEST_MARKER: "retained environment" }
  return { home, bootstrap, entry, output, environment }
}

describe("managed executable bootstrap delegation", () => {
  it.each(["--version", "--help"])("delegates %s with arguments, cwd, environment and exit status intact", async flag => {
    const client = await fixture()
    const counts = ["SIGINT", "SIGTERM", "SIGHUP"].map(signal => process.listenerCount(signal))
    const args = [flag, "--lang", "zh-CN"]
    expect(await delegateManagedRuntime(client.bootstrap, args, client.environment)).toBe(7)
    expect(JSON.parse(await readFile(client.output, "utf8"))).toEqual({ args, home: client.home,
      bootstrap: client.bootstrap, marker: "retained environment", cwd: process.cwd() })
    expect(["SIGINT", "SIGTERM", "SIGHUP"].map(signal => process.listenerCount(signal))).toEqual(counts)
  })

  it("does not recursively delegate a launch already using the selected executable", async () => {
    const client = await fixture()
    expect(await delegateManagedRuntime(client.entry, ["--version"], client.environment)).toBeUndefined()
    await expect(readFile(client.output)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("uses the original executable when no managed selection exists", async () => {
    const client = await fixture()
    await selectRuntime(client.home, undefined)
    expect(await delegateManagedRuntime(client.bootstrap, ["--version"], client.environment)).toBeUndefined()
  })

  it.each(["--help", "--version"])("keeps %s read-only and on the newly installed CLI with v1 metadata and an old updater lock", async flag => {
    const client = await fixture()
    const current = runtimeSelectionFile(client.home)
    const pointer = { ...JSON.parse(await readFile(current, "utf8")), stateContract: "atape.client.v3-capture.v1" }
    await writeFile(current, JSON.stringify(pointer))
    const release = await acquireUpdateWorker(client.home)
    try {
      expect(await delegateManagedRuntime(client.bootstrap, [flag], client.environment)).toBeUndefined()
      expect(JSON.parse(await readFile(current, "utf8"))).toEqual(pointer)
      await expect(readFile(client.output)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(readFile(join(client.home, "updates", "manual-state-upgrade.json"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally { release?.() }
  })

  it("delegates admitted login startup only to a runtime declaring the protocol", async () => {
    const client = await fixture()
    const args = ["__login-start", "--startup-token", "e859003d-90b4-44f6-ae5a-c14aa3c8ede7"]
    expect(await delegateManagedRuntime(client.bootstrap, args, client.environment)).toBeUndefined()
    expect(await delegateAdmittedLoginStartup(client.bootstrap, args, client.environment)).toBeUndefined()
    await expect(readFile(client.output)).rejects.toMatchObject({ code: "ENOENT" })
    await writeFile(join(dirname(dirname(client.entry)), "package.json"), JSON.stringify({ name: "@atape/cli", version: "1.2.3", type: "module",
      atapeRuntime: { loginStartupProtocol: "atape.login-startup.v1" } }))
    expect(await delegateAdmittedLoginStartup(client.bootstrap, args, client.environment)).toBe(7)
    expect(JSON.parse(await readFile(client.output, "utf8"))).toMatchObject({ args, bootstrap: client.bootstrap })
    expect(await delegateAdmittedLoginStartup(client.entry, args, client.environment)).toBeUndefined()
  })

  it("rejects public argument errors before inspecting a malformed managed selection", async () => {
    const client = await fixture()
    await writeFile(runtimeSelectionFile(client.home), "malformed")
    await expect(delegateManagedRuntime(client.bootstrap, ["--version", "extra"], client.environment)).rejects.toBeInstanceOf(CLIInputError)
    await expect(delegateManagedRuntime(client.bootstrap, ["--version"], client.environment)).rejects.toThrow()
  })

  it("leaves direct launches, internal collection and unsupported interactive launches to the caller", async () => {
    const client = await fixture()
    await writeFile(runtimeSelectionFile(client.home), "malformed")
    expect(await delegateManagedRuntime(client.bootstrap, ["--version"], { ...client.environment, ATAPE_RUNTIME_DIRECT: "1" })).toBeUndefined()
    expect(await delegateManagedRuntime(client.bootstrap, ["redaction-test", "sample.jsonl"], client.environment)).toBeUndefined()
    expect(await delegateManagedRuntime(client.bootstrap, ["redaction-test", "--help"], client.environment)).toBeUndefined()
    expect(await delegateManagedRuntime(client.bootstrap, ["__collector-daemon", "--daemon-token", "test-token"], client.environment)).toBeUndefined()
    expect(await delegateManagedRuntime(client.bootstrap, ["__automatic-update", "--update-token", "00000000-0000-4000-8000-000000000000"], client.environment)).toBeUndefined()
    expect(await delegateManagedRuntime(client.bootstrap, [], { ...client.environment, CI: "true" })).toBeUndefined()
    await expect(readFile(client.output)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.skipIf(process.platform === "win32")("relays a parent termination signal and returns the child's exit code", async () => {
    const client = await fixture(`import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { writeFileSync(process.env.LAUNCHER_TEST_OUTPUT, "relayed"); process.exit(23) });
writeFileSync(process.env.LAUNCHER_TEST_OUTPUT + ".ready", String(process.pid));
setInterval(() => {}, 1000);`)
    const parent = join(client.home, "parent.mjs")
    await writeFile(parent, `import { delegateManagedRuntime } from ${JSON.stringify(new URL("./runtimeLauncher.ts", import.meta.url).href)};
process.exitCode = await delegateManagedRuntime(process.env.LAUNCHER_TEST_BOOTSTRAP, ["--version"], process.env) ?? 99;`)
    const child = spawn(process.execPath, [parent], { env: { ...client.environment, LAUNCHER_TEST_BOOTSTRAP: client.bootstrap }, stdio: "ignore" })
    const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject) })
    let managedPID: number | undefined
    try {
      await expect.poll(() => readFile(`${client.output}.ready`, "utf8").catch(() => ""), { timeout: 5_000 }).not.toBe("")
      managedPID = Number(await readFile(`${client.output}.ready`, "utf8"))
      child.kill("SIGTERM")
      expect(await exited).toBe(23)
      expect(await readFile(client.output, "utf8")).toBe("relayed")
    } finally {
      child.kill("SIGKILL")
      if (managedPID) { try { process.kill(managedPID, "SIGKILL") } catch {} }
      await exited
    }
  }, 10_000)
})
