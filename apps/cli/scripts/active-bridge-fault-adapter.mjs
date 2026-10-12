import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import promises from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

// External fault injection for the genuine installed acceptance processes.
// Production executables and their persisted bytes are never rewritten. Every
// pause follows a real synced boundary or the release of its SQLite barrier.
export const installActiveBridgeFaultAdapter = (root, distributionFile) => {
  const home = join(root, "home"), updates = join(home, "updates"), state = join(home, "state")
  const marker = join(root, "fault-observed.json")
  const read = file => {
    try { return JSON.parse(readFileSync(file, "utf8")) }
    catch (cause) { if (cause.code === "ENOENT") return undefined; throw cause }
  }
  const observe = (point, path) => {
    if (existsSync(marker)) return
    const distribution = read(distributionFile), fault = distribution.fault
    if (fault?.point !== point || !distribution.feature) return
    const control = read(join(updates, "control.json")), pointer = read(join(updates, "runtime.json"))
    const handoff = read(join(updates, "target-update.json")), ledger = read(join(updates, "capture-migration.json"))
    if (!control || control.phase !== "completed" || !control.forwardOnly ||
      control.target.version !== distribution.feature.version || handoff?.phase !== "activating") return
    const isTarget = process.argv[2] === "__update-target" && process.argv.at(-1) === "activate"
    const isApply = process.argv[2] === "__capture-migration-apply"
    const requirementMatches = ledger?.required?.requirement?.outerKey === control.key
    if (point === "control-synced" && (!isTarget || path !== updates || pointer?.version === control.target.version)) return
    if (point === "first-private-ledger" && (!isTarget || path !== updates || !requirementMatches || ledger.phase !== "authorized")) return
    if (point === "before-readiness" && (!isTarget || path !== state || !requirementMatches || ledger.phase !== "completed" ||
      read(join(state, "collector-process.json.maintenance.json"))?.phase !== "starting")) return
    if (point === "orphan-apply" && (!isApply || !requirementMatches || ledger.phase !== "applying" || ledger.progress.length === 0)) return
    const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex")
    writeFileSync(marker, JSON.stringify({ point, pid: process.pid, parentPid: process.ppid, args: process.argv.slice(2),
      entrySha256: hash(process.argv[1]), controlKey: control.key, controlPhase: control.phase,
      pointerVersion: pointer?.version, targetVersion: control.target.version,
      ...(requirementMatches ? { privatePhase: ledger.phase, attempt: ledger.attempt, progress: ledger.progress.length } : {}) }) + "\n",
    { flag: "wx", mode: 0o600 })
    process.kill(process.pid, "SIGSTOP")
  }
  const open = promises.open
  promises.open = async function(path, ...args) {
    const handle = await Reflect.apply(open, this, [path, ...args]), sync = handle.sync.bind(handle)
    handle.sync = async () => {
      await sync()
      if (path === updates) { observe("control-synced", path); observe("first-private-ledger", path) }
      if (path === state) observe("before-readiness", path)
    }
    return handle
  }
  const exec = DatabaseSync.prototype.exec
  DatabaseSync.prototype.exec = function(sql) {
    const result = Reflect.apply(exec, this, [sql])
    // The migration child still owns its independent apply lease, but the
    // short data barrier has released. A queued genuine old worker can then
    // supersede an attempt without acquiring the orphan's write authority.
    if (sql === "ROLLBACK") observe("orphan-apply")
    return result
  }
  syncBuiltinESMExports()
}
