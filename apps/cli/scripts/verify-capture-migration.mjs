import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { compileCaptureFixtureEntry, prepareManagedCaptureFixture, journalVersion, captureV2 } from "../src/runtime/fixtures/managed-capture-update.ts"

const execute = promisify(execFile)
const json = async path => JSON.parse(await readFile(path, "utf8"))
const absent = path => assert.rejects(readFile(path), cause => cause.code === "ENOENT")
const rows = async path => (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(value => JSON.parse(value))

// The source is an explicitly controlled, compiled migration-aware v1 bridge.
// All preflight/apply work executes the untouched npm-installed candidate. This
// does not claim historical 0.5.3 delivery or use a fabricated target receipt.
export async function verifyCaptureMigration(donorPackage, fixtureDirectory) {
  await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 })
  const root = await realpath(fixtureDirectory), manifest = await json(join(donorPackage, "package.json"))
  assert.equal(manifest.atapeRuntime?.captureMigrationProtocol, "atape.capture-migration.v1")
  assert.equal(manifest.atapeRuntime?.stateContract, captureV2)
  const sourceEntry = join(root, "controlled-source.mjs")
  await compileCaptureFixtureEntry(sourceEntry, "coordinator", "0.0.1")
  const completed = await prepareManagedCaptureFixture(join(root, "completed"), donorPackage, sourceEntry)
  const configuration = await readFile(completed.paths.configFile, "utf8")
  const desired = await readFile(`${completed.paths.collectorProcessFile}.desired.json`, "utf8")
  assert.equal(journalVersion(completed.journalPath), 7)
  assert.deepEqual(await completed.invoke("activate"), { activated: true })
  assert.equal(journalVersion(completed.journalPath), 8)
  assert.deepEqual(await json(join(completed.paths.atapeHome, "updates", "runtime.json")), completed.target)
  assert.equal(await readFile(completed.paths.configFile, "utf8"), configuration)
  assert.equal(await readFile(`${completed.paths.collectorProcessFile}.desired.json`, "utf8"), desired)
  const control = await json(join(completed.paths.atapeHome, "updates", "control.json"))
  assert.equal(control.phase, "completed")
  assert.equal(control.forwardOnly, true)
  assert.deepEqual(control.floor, { minimumRuntimeVersion: manifest.version, captureStateContract: captureV2 })
  const ledger = await json(join(completed.paths.atapeHome, "updates", "capture-migration.json"))
  assert.equal(ledger.phase, "completed")
  assert.equal(ledger.receipt.protocol, "atape.capture-migration-receipt.v1")
  assert.equal(ledger.receipt.outerKey, control.key)
  const executed = await rows(completed.entryTrace)
  for (const command of ["__capture-migration-preflight", "__capture-migration-apply"])
    assert.ok(executed.some(row => row.entry === completed.targetEntry && row.args[0] === command), `Installed target must execute ${command}`)
  assert.deepEqual(await readFile(completed.targetEntry), await readFile(join(donorPackage, "dist", "atape.js")))
  await absent(completed.paths.collectorProcessFile)
  await absent(completed.networkFile)

  const receiptBytes = await readFile(join(completed.paths.atapeHome, "updates", "capture-migration.json"), "utf8")
  await assert.rejects(execute(process.execPath, [completed.targetEntry, "__capture-migration-preflight", randomUUID(), randomUUID()], {
    cwd: completed.root, env: completed.environment, timeout: 20_000, encoding: "utf8"
  }), cause => cause.code === 1)
  assert.equal(await readFile(join(completed.paths.atapeHome, "updates", "capture-migration.json"), "utf8"), receiptBytes)
  assert.equal(journalVersion(completed.journalPath), 8)

  const interrupted = await prepareManagedCaptureFixture(join(root, "interrupted"), donorPackage, sourceEntry)
  const stopped = await readFile(`${interrupted.paths.collectorProcessFile}.desired.json`, "utf8")
  assert.equal((await interrupted.invoke("interrupt-after-fence")).interrupted, "interrupt-after-fence")
  assert.equal(journalVersion(interrupted.journalPath), 7)
  await assert.rejects(interrupted.invoke("write"), cause => cause.code === 1)
  await writeFile(interrupted.paths.configFile, `${JSON.stringify({ ...await json(interrupted.paths.configFile), autoUpdateEnabled: false })}\n`)
  assert.deepEqual(await interrupted.invoke("recover"), { recovered: true })
  assert.equal(journalVersion(interrupted.journalPath), 8)
  assert.equal((await json(interrupted.paths.configFile)).autoUpdateEnabled, false)
  assert.equal(await readFile(`${interrupted.paths.collectorProcessFile}.desired.json`, "utf8"), stopped)
  assert.equal((await json(join(interrupted.paths.atapeHome, "updates", "control.json"))).phase, "recovered")
  assert.deepEqual(await interrupted.invoke("recover"), { recovered: false })
  await absent(interrupted.paths.collectorProcessFile)
  await absent(interrupted.networkFile)
  await writeFile(join(root, "acceptance.json"), `${JSON.stringify({ targetVersion: manifest.version,
    source: "controlled compiled migration-aware capture-v1 bridge", target: "untouched npm-installed candidate",
    journal: "controlled real SQLite v7 to v8", stopPreserved: true, automaticOffRecovery: true,
    historical053Delivery: false })}\n`)
  process.stdout.write("Verified npm-installed capture-v2 target: actual private preflight/apply, SQL7→8, Stop preservation, old-writer refusal and automatic-off recovery (controlled capable v1 source; no historical 0.5.3 delivery claim)\n")
}
