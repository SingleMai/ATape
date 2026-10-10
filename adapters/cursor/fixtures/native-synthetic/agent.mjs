#!/usr/bin/env node
// External synthetic native process Test Adapter: native files only, no ATape state.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const control = JSON.parse(readFileSync(process.env.CURSOR_TEST_CONTROL, "utf8"))
const args = process.argv.slice(2)
if (args.join(" ") === "--disable-auto-update --version") {
  process.stdout.write((control.version ?? "2026.10.01-e373342") + "\n"); process.exit(0)
}
const id = args[2]
assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
assert.deepEqual(args, ["--disable-auto-update", "--new-session-id", id, ...(control.prompt === undefined ? [] : ["--", control.prompt])])
for (const key of ["NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV"]) assert.equal(process.env[key], undefined)
const cwd = realpathSync(process.cwd()), root = realpathSync(process.env.CURSOR_DATA_DIR)
assert.equal(realpathSync(process.env.CURSOR_CONFIG_DIR), root)
assert.equal(cwd, control.cwd)
const bucket = join(root, "chats", createHash("md5").update(cwd).digest("hex"))
mkdirSync(bucket, { recursive: true }); mkdirSync(join(bucket, id))
const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")
const directory = join(root, "projects", control.mode === "wrong-location" ? "wrong-workspace" : slug, "agent-transcripts", id)
const file = join(directory, id + ".jsonl")
const rows = () => control.rows.map(row => JSON.stringify(row) + "\n").join("")
if (!["empty", "failed"].includes(control.mode)) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(file, control.mode === "partial" ? rows() + '{"role":' : control.mode === "malformed" ? '{"role":\n' : rows())
}
writeFileSync(control.ready, JSON.stringify({ id, pid: process.pid, file, args, cwd, root }))
const finish = code => { writeFileSync(control.exited, JSON.stringify({ pid: process.pid, code })); process.exit(code) }
process.on("SIGTERM", () => finish(143))
if (!control.hold) finish(control.mode === "failed" ? 7 : 0)
let previous = ""
setInterval(() => {
  if (!existsSync(control.command)) return
  const command = readFileSync(control.command, "utf8")
  if (command === previous) return
  previous = command
  if (command === "complete") writeFileSync(file, rows())
  if (command === "finish") finish(control.exitCode ?? 0)
}, 20)
