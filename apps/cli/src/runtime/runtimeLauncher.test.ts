import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { CLIInputError } from "../commandInput.ts"
import { delegateAdmittedLoginStartup, delegateManagedRuntime } from "./runtimeLauncher.ts"
import { managedStateContract, runtimeEntry, runtimeSelectionFile, selectRuntime } from "./runtimeSelection.ts"
import { acquireUpdateWorker } from "./updateOwnership.ts"
import { createUpdateControl, updateControlProtocol, type UpdateRuntimeSelection } from "./updateControl.ts"

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
  await writeFile(join(dirname(dirname(entry)), "package.json"), JSON.stringify({ name: "@atape/cli", version: "1.2.3", type: "module",
    atapeRuntime: { stateContract: managedStateContract } }))
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

const independentGeneration = async (client: Awaited<ReturnType<typeof fixture>>, version: string, source?: string, completed = true) => {
  const entry = runtimeEntry(client.home, version)
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(join(dirname(dirname(entry)), "package.json"), JSON.stringify({ name: "@atape/cli", version, type: "module",
    atapeRuntime: { stateContract: managedStateContract, updateControlProtocol, loginStartupProtocol: "atape.login-startup.v1" } }))
  await writeFile(entry, source ?? `import { writeFileSync } from "node:fs";
writeFileSync(process.env.LAUNCHER_TEST_OUTPUT, JSON.stringify({ version: ${JSON.stringify(version)},
  args: process.argv.slice(2), bootstrap: process.env.ATAPE_BOOTSTRAP_ENTRY, marker: process.env.LAUNCHER_TEST_MARKER })); process.exitCode = 11;`)
  const selected: UpdateRuntimeSelection = { protocol: updateControlProtocol, version, captureStateContract: managedStateContract,
    bootstrapEntry: client.bootstrap, bootstrapIdentity: createHash("sha256").update(await readFile(client.bootstrap)).digest("hex"), adapters: [] }
  const control = createUpdateControl(client.home)
  const ticket = await control.prepare({ next: selected })
  await control.begin(ticket)
  if (completed) await control.complete(ticket)
  return { selected, entry }
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

  it("delegates public and admitted login launches to independent selection while leaving the bridge intact", async () => {
    const client = await fixture()
    const anchor = await readFile(runtimeSelectionFile(client.home), "utf8")
    const next = await independentGeneration(client, "1.2.4")
    expect(await delegateManagedRuntime(client.bootstrap, ["--version"], client.environment)).toBe(11)
    expect(JSON.parse(await readFile(client.output, "utf8"))).toEqual({ version: "1.2.4", args: ["--version"],
      bootstrap: client.bootstrap, marker: "retained environment" })
    expect(await delegateManagedRuntime(next.entry, ["--help"], client.environment)).toBeUndefined()
    const args = ["__login-start", "--startup-token", "e859003d-90b4-44f6-ae5a-c14aa3c8ede7"]
    expect(await delegateAdmittedLoginStartup(client.bootstrap, args, client.environment)).toBe(11)
    expect(JSON.parse(await readFile(client.output, "utf8"))).toMatchObject({ version: "1.2.4", args })
    expect(await readFile(runtimeSelectionFile(client.home), "utf8")).toBe(anchor)
    await writeFile(join(client.home, "updates", "pending.json"), "{}")
    expect(await delegateManagedRuntime(client.bootstrap, ["--version"], client.environment)).toBe(11)
  })

  it("a legacy bootstrap can enter the v2 bridge and reach the independently selected next executable", async () => {
    const launcher = new URL("./runtimeLauncher.ts", import.meta.url).href
    const client = await fixture(`import { delegateManagedRuntime } from ${JSON.stringify(launcher)};
process.env.LAUNCHER_TEST_MARKER += ":bridge";
process.exitCode = await delegateManagedRuntime(import.meta.filename, process.argv.slice(2), process.env) ?? 91;`)
    // This controlled launcher models the historical current.json routing. The
    // published-package acceptance separately exercises genuine old npm bytes.
    await writeFile(client.bootstrap, `import { readFileSync } from "node:fs";
import { join } from "node:path"; import { spawnSync } from "node:child_process";
const selected = JSON.parse(readFileSync(join(process.env.ATAPE_HOME, "releases", "current.json"), "utf8"));
if (selected.stateContract !== "atape.client.v3-capture.v2") throw new Error("legacy bootstrap refused contract");
const entry = join(process.env.ATAPE_HOME, "releases", selected.version, "node_modules", "@atape", "cli", "dist", "atape.js");
process.exitCode = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {stdio:"inherit", env:{...process.env,
ATAPE_BOOTSTRAP_ENTRY:selected.bootstrapEntry, LAUNCHER_TEST_MARKER:process.env.LAUNCHER_TEST_MARKER+":legacy"}}).status ?? 92;`)
    await independentGeneration(client, "1.2.4")
    const anchor = await readFile(runtimeSelectionFile(client.home), "utf8")
    const child = spawn(process.execPath, [client.bootstrap, "--version"], { env: client.environment, stdio: "ignore" })
    const exited = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject) })
    expect(exited).toBe(11)
    expect(JSON.parse(await readFile(client.output, "utf8"))).toEqual({ version: "1.2.4", args: ["--version"],
      bootstrap: client.bootstrap, marker: "retained environment:legacy:bridge" })
    expect(await readFile(runtimeSelectionFile(client.home), "utf8")).toBe(anchor)
  }, 10_000)

  it("rejects corrupt independent metadata before executing the valid legacy bridge", async () => {
    const client = await fixture()
    await independentGeneration(client, "1.2.4")
    await writeFile(join(client.home, "updates", "runtime.json"), '{"protocol":"unknown"}')
    await expect(delegateManagedRuntime(client.bootstrap, ["--help"], client.environment)).rejects.toThrow()
    await expect(readFile(client.output)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("lets eligible interactive and admitted login coordinators recover before validating a missing pending target", async () => {
    const client = await fixture()
    const pending = await independentGeneration(client, "1.2.4", undefined, false)
    await rm(pending.entry)
    const input = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
    const output = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true })
    try {
      const environment = { ...client.environment, TERM: "xterm", CI: "", CONTINUOUS_INTEGRATION: "", BUILD_NUMBER: "" }
      expect(await delegateManagedRuntime(client.bootstrap, [], environment)).toBeUndefined()
      const args = ["__login-start", "--startup-token", "e859003d-90b4-44f6-ae5a-c14aa3c8ede7"]
      expect(await delegateAdmittedLoginStartup(client.bootstrap, args, environment)).toBeUndefined()
      for (const flag of ["--help", "--version"]) {
        await expect(delegateManagedRuntime(client.bootstrap, [flag], environment)).rejects.toThrow()
      }
      expect(await createUpdateControl(client.home).recoveryPending()).toBe(true)
      expect(await createUpdateControl(client.home).readSelection()).toEqual(pending.selected)
      await expect(readFile(client.output)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      if (input) Object.defineProperty(process.stdin, "isTTY", input)
      else Reflect.deleteProperty(process.stdin, "isTTY")
      if (output) Object.defineProperty(process.stdout, "isTTY", output)
      else Reflect.deleteProperty(process.stdout, "isTTY")
    }
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
