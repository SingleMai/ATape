import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
const publishedV2Digest = "5dc42929c2aab6080830b6c52d1d7e3d7a81320bfccdd318a1c054d1357020ce"

// Genuine historical bootstrap bytes + the exact installed candidate bridge.
// The final executable is a controlled protocol fixture: this proves dispatch,
// not a new published release, package acquisition or a data migration.
export async function verifyUpdateBridge(donorPackage, fixtureDirectory) {
  await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 })
  const root = await realpath(fixtureDirectory), home = join(root, "home")
  const manifest = JSON.parse(await readFile(join(donorPackage, "package.json"), "utf8"))
  assert.equal(manifest.atapeRuntime?.updateControlProtocol, "atape.update-control.v1")
  assert.equal(manifest.atapeRuntime?.stateContract, "atape.client.v3-capture.v2")
  const tarball = join(root, "published-0.5.4.tgz")
  let bytes
  if (process.env.ATAPE_VERIFY_V2_BOOTSTRAP_TARBALL) bytes = await readFile(process.env.ATAPE_VERIFY_V2_BOOTSTRAP_TARBALL)
  else {
    const response = await fetch("https://registry.npmjs.org/@atape/cli/-/cli-0.5.4.tgz", {
      redirect: "error", signal: AbortSignal.timeout(20_000)
    })
    assert.ok(response.ok, "Historical bootstrap tarball must be publicly retrievable")
    assert.ok(response.body, "Historical bootstrap tarball must have a body")
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      assert.ok(size <= 1024 * 1024, "Historical bootstrap tarball exceeds the pinned artifact size budget")
      chunks.push(chunk)
    }
    bytes = Buffer.concat(chunks)
  }
  assert.equal(sha256(bytes), publishedV2Digest, "Historical 0.5.4 tarball bytes must be unmodified")
  await writeFile(tarball, bytes)
  const install = join(root, "bootstrap")
  await execute("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", install, tarball], {
    cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024
  })
  const bootstrap = join(install, "node_modules", "@atape", "cli", "dist", "atape.js")
  const bootstrapBytes = await readFile(bootstrap)
  const bridge = join(home, "releases", manifest.version, "node_modules", "@atape", "cli")
  await cp(donorPackage, bridge, { recursive: true })
  const legacy = { protocol: "atape.runtime.v1", stateContract: manifest.atapeRuntime.stateContract,
    version: manifest.version, bootstrapEntry: bootstrap, bootstrapIdentity: sha256(bootstrapBytes), adapters: [] }
  const legacyFile = join(home, "releases", "current.json"), encodedLegacy = `${JSON.stringify(legacy)}\n`
  await writeFile(legacyFile, encodedLegacy)
  const [major, minor, patch] = manifest.version.split(".").map(Number), next = `${major}.${minor}.${patch + 1}`
  const target = join(home, "releases", next, "node_modules", "@atape", "cli")
  await mkdir(join(target, "dist"), { recursive: true })
  const proofFile = join(root, "target-dispatch.json")
  const opaqueContract = "atape.capture.future-fixture.v9"
  const targetMarker = "ATAPE_CONTROLLED_OPAQUE_TTY_TARGET"
  await writeFile(join(target, "dist", "atape.js"), `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(proofFile)}, JSON.stringify({ entry: process.argv[1], bootstrap: process.env.ATAPE_BOOTSTRAP_ENTRY,
  args: process.argv.slice(2), tty: Boolean(process.stdin.isTTY && process.stdout.isTTY) }));
console.log(process.argv.includes("--version") ? ${JSON.stringify(`ATape ${next}`)} : ${JSON.stringify(targetMarker)});
`)
  await writeFile(join(target, "package.json"), JSON.stringify({ ...manifest, version: next,
    atapeRuntime: { ...manifest.atapeRuntime, stateContract: opaqueContract } }))
  await mkdir(join(home, "updates"), { recursive: true })
  const pointerFile = join(home, "updates", "runtime.json")
  const selection = { protocol: "atape.update-control.v1", captureStateContract: opaqueContract,
    version: next, bootstrapEntry: bootstrap, bootstrapIdentity: sha256(bootstrapBytes), adapters: [] }
  await writeFile(pointerFile, `${JSON.stringify(selection)}\n`)
  const configFile = join(home, "config", "client.json")
  await mkdir(dirname(configFile), { recursive: true })
  const config = `${JSON.stringify({ version: 3, projects: [], adapters: [], toolsConfigured: true,
    enabledAdapterIds: [], autoUpdateEnabled: false, autoStartEnabled: false })}\n`
  await writeFile(configFile, config)
  const result = await execute(process.execPath, [bootstrap, "--version"], {
    cwd: root, env: { ...process.env, ATAPE_HOME: home, ATAPE_CONFIG_FILE: configFile, ATAPE_RUNTIME_DIRECT: "0",
      ATAPE_LANG: "en", NODE_OPTIONS: "" }, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024
  })
  assert.equal(result.stdout.trim(), `ATape ${next}`)
  assert.deepEqual(JSON.parse(await readFile(proofFile, "utf8")), { entry: join(target, "dist", "atape.js"), bootstrap,
    args: ["--version"], tty: false })

  // The packaged bridge must delegate before interpreting any historical v2
  // migration receipt. The target is deliberately only an opaque dispatcher.
  const receiptFile = join(home, "updates", "manual-state-upgrade.json")
  const invalidReceipt = "invalid manual receipt: delegation must not decode this\n"
  await writeFile(receiptFile, invalidReceipt, { mode: 0o600 })
  const environment = { ...process.env, ATAPE_HOME: home, ATAPE_CONFIG_FILE: configFile, ATAPE_BOOTSTRAP_ENTRY: bootstrap,
    ATAPE_RUNTIME_DIRECT: "0", ATAPE_LANG: "en", NODE_OPTIONS: "", CI: "", CONTINUOUS_INTEGRATION: "", BUILD_NUMBER: "" }
  const candidate = join(bridge, "dist", "atape.js")
  const delegatedTTY = await terminal(candidate, root, environment)
  assert.equal(delegatedTTY.exitCode, 0, delegatedTTY.output)
  assert.equal(delegatedTTY.output.trim(), targetMarker)
  assert.equal(delegatedTTY.terminalRestored, true)
  assert.deepEqual(JSON.parse(await readFile(proofFile, "utf8")), { entry: join(target, "dist", "atape.js"), bootstrap,
    args: [], tty: true })
  assert.equal(await readFile(receiptFile, "utf8"), invalidReceipt)

  // A fixture-completed same-contract floor represents a later admitted reader.
  // An old direct entry may still print help/version, but cannot enter the UI.
  const nextSelection = { ...selection, captureStateContract: manifest.atapeRuntime.stateContract }
  await writeFile(join(target, "package.json"), JSON.stringify({ ...manifest, version: next }))
  await writeFile(pointerFile, `${JSON.stringify(nextSelection)}\n`)
  const controlFile = join(home, "updates", "control.json")
  const controlBytes = `${JSON.stringify({ protocol: "atape.update-control.v1", key: randomUUID(), phase: "completed",
    target: nextSelection, forwardOnly: true,
    floor: { minimumRuntimeVersion: next, captureStateContract: manifest.atapeRuntime.stateContract } })}\n`
  await writeFile(controlFile, controlBytes)
  // Replacing metadata cannot turn this already-built candidate into next V.
  await writeFile(join(bridge, "package.json"), JSON.stringify({ ...manifest, version: next }))
  const direct = { ...environment, ATAPE_RUNTIME_DIRECT: "1" }
  const refusedTTY = await terminal(candidate, root, direct)
  assert.equal(refusedTTY.exitCode, 1, refusedTTY.output)
  assert.match(refusedTTY.output.trim(), /^ATape[^\r\n]*: This runtime is below the durable recovery boundary\.$/)
  assert.doesNotMatch(refusedTTY.output, /\x1b|Your Projects|Upgrade now|ATAPE_CONTROLLED_OPAQUE_TTY_TARGET/)
  assert.equal(refusedTTY.terminalRestored, true)
  // Missing independent routing metadata does not authorize an old bridge to
  // mutate historical configuration before checking the surviving floor.
  await rm(pointerFile)
  const missingPointerTTY = await terminal(candidate, root, direct)
  assert.equal(missingPointerTTY.exitCode, 1, missingPointerTTY.output)
  assert.match(missingPointerTTY.output.trim(), /^ATape[^\r\n]*: This runtime is below the durable recovery boundary\.$/)
  assert.doesNotMatch(missingPointerTTY.output, /\x1b|Your Projects|Upgrade now|manual state upgrade/)
  assert.equal(missingPointerTTY.terminalRestored, true)
  assert.equal(await readFile(configFile, "utf8"), config)
  assert.equal(await readFile(receiptFile, "utf8"), invalidReceipt)
  await writeFile(pointerFile, `${JSON.stringify(nextSelection)}\n`)
  assert.equal((await execute(process.execPath, [candidate, "--version"], { cwd: root, env: direct, encoding: "utf8", timeout: 30_000 })).stdout.trim(),
    `ATape ${manifest.version}`)
  assert.match((await execute(process.execPath, [candidate, "--help"], { cwd: root, env: direct, encoding: "utf8", timeout: 30_000 })).stdout,
    /^ATape CLI/m)
  assert.equal(await readFile(controlFile, "utf8"), controlBytes)
  assert.equal(await readFile(receiptFile, "utf8"), invalidReceipt)
  assert.equal(await readFile(legacyFile, "utf8"), encodedLegacy)
  assert.equal(await readFile(configFile, "utf8"), config)
  assert.deepEqual(await readFile(bootstrap), bootstrapBytes)
  process.stdout.write("Verified genuine published 0.5.4 bootstrap → packaged v2 bridge → opaque control-selected executable, plus real-TTY delegation and compiled-identity reader-floor refusal (controlled target, no migration/publication claim)\n")
}

async function terminal(entry, root, environment) {
  const result = await execute("python3", [fileURLToPath(new URL("verify-update-bridge-terminal.py", import.meta.url)), process.execPath, entry, root], {
    cwd: root, env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024
  })
  return JSON.parse(result.stdout)
}
