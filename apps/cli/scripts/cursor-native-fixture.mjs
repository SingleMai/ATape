#!/usr/bin/env node
// Synthetic external Cursor Test Adapter. It knows native facts only and never
// imports ATape or reads/writes ATAPE_HOME or creation receipts.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const version = "2026.10.01-e373342"
if (process.argv.slice(2).join(" ") === "--disable-auto-update --version") {
  process.stdout.write(`${version}\n`)
  process.exit(0)
}
const controlFile = process.env.CURSOR_FIXTURE_CONTROL
assert.ok(controlFile, "The synthetic Cursor requires its disposable control file")
const control = JSON.parse(readFileSync(controlFile, "utf8"))
const args = process.argv.slice(2), index = args.indexOf("--new-session-id")
assert.ok(index >= 0)
const sourceId = args[index + 1]
assert.match(sourceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
assert.deepEqual(args, ["--disable-auto-update", "--new-session-id", sourceId, "--", "--literal 中文 CursorStartNeedle"])
assert.ok(!args.some(arg => ["--resume", "--continue", "--workspace", "--add-dir", "--worktree", "--worker", "--data-dir"].includes(arg)))
for (const name of ["NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV"]) assert.equal(process.env[name], undefined)
const cwd = realpathSync(process.cwd())
const root = realpathSync(process.env.CURSOR_DATA_DIR)
assert.equal(realpathSync(process.env.CURSOR_CONFIG_DIR), root)
assert.equal(root, resolve(process.env.CURSOR_DATA_DIR))
assert.equal(cwd, control.cwd)
assert.equal(process.stdin.isTTY, true)
assert.equal(process.stdout.isTTY, true)
const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
assert.ok(slug)
const bucket = join(root, "chats", createHash("md5").update(cwd).digest("hex"))
mkdirSync(bucket, { recursive: true })
mkdirSync(join(bucket, sourceId)) // Native exclusive claim: never silently resume.
const directory = join(root, "projects", slug, "agent-transcripts", sourceId)
const file = join(directory, `${sourceId}.jsonl`)
if (control.mode !== "cancel" && control.mode !== "failed") {
  mkdirSync(directory, { recursive: true })
  writeFileSync(file, control.rows.map(row => JSON.stringify(row) + "\n").join(""))
}
// Deliberately leave raw mode changed on exit. The shipped Host, rather than
// the fixture, must restore the exact caller terminal state.
process.stdin.setRawMode(true)
process.stdin.resume()
let input = ""
let exiting = false
const finish = code => {
  if (exiting) return
  exiting = true
  writeFileSync(control.exitedFile, JSON.stringify({ pid: process.pid, exitCode: code }))
  process.exit(code)
}
process.on("SIGTERM", () => finish(143))
process.on("SIGINT", () => finish(130))
process.stdin.on("data", bytes => {
  input += bytes.toString("utf8")
  if (input.includes("finish\n")) finish(control.mode === "failed" || control.mode === "confirmed-failed" ? 7 : 0)
})
const readyTemporary = `${control.readyFile}.tmp`
writeFileSync(readyTemporary, JSON.stringify({ sourceId, file, pid: process.pid, parentPid: process.ppid, cwd, args, root, synthetic: true }), { mode: 0o600 })
renameSync(readyTemporary, control.readyFile)
process.stdout.write(`Synthetic Cursor ready ${sourceId}\r\n`)
