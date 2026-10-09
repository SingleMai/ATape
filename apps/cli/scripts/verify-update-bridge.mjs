import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
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
  await writeFile(join(target, "dist", "atape.js"), `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(proofFile)}, JSON.stringify({ entry: process.argv[1], bootstrap: process.env.ATAPE_BOOTSTRAP_ENTRY }));
console.log(${JSON.stringify(`ATape ${next}`)});
`)
  await writeFile(join(target, "package.json"), JSON.stringify({ ...manifest, version: next }))
  await mkdir(join(home, "updates"), { recursive: true })
  const pointerFile = join(home, "updates", "runtime.json")
  await writeFile(pointerFile, `${JSON.stringify({ protocol: "atape.update-control.v1", captureStateContract: manifest.atapeRuntime.stateContract,
    version: next, bootstrapEntry: bootstrap, bootstrapIdentity: sha256(bootstrapBytes), adapters: [] })}\n`)
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
  assert.deepEqual(JSON.parse(await readFile(proofFile, "utf8")), { entry: join(target, "dist", "atape.js"), bootstrap })
  assert.equal(await readFile(legacyFile, "utf8"), encodedLegacy)
  assert.equal(await readFile(configFile, "utf8"), config)
  assert.deepEqual(await readFile(bootstrap), bootstrapBytes)
  process.stdout.write("Verified genuine published 0.5.4 bootstrap → packaged v2 bridge → independent control-selected executable (controlled target, no migration/publication claim)\n")
}
