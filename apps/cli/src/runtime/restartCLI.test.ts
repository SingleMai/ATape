import { Effect } from "effect"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { restartInstalledCLI } from "./restartCLI.ts"

it("opens the replaced executable with the original arguments and environment and returns its exit status", async () => {
  const root = await mkdtemp(join(tmpdir(), "atape-restart-"))
  try {
    const entry = join(root, "atape.cjs"), output = join(root, "invocation.json")
    await writeFile(entry, `require("node:fs").writeFileSync(process.env.RESTART_TEST_OUTPUT, JSON.stringify({
      args: process.argv.slice(2), home: process.env.ATAPE_HOME, cwd: process.cwd()
    })); process.exitCode = 7;`)
    const args = ["setup", "/projects/项目 space", "--no-browser"]
    const interrupts = process.listenerCount("SIGINT"), terminations = process.listenerCount("SIGTERM")
    expect(await Effect.runPromise(restartInstalledCLI(entry, args, { ...process.env,
      ATAPE_HOME: root, RESTART_TEST_OUTPUT: output }))).toBe(7)
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ args, home: root, cwd: process.cwd() })
    expect(process.listenerCount("SIGINT")).toBe(interrupts)
    expect(process.listenerCount("SIGTERM")).toBe(terminations)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.skipIf(process.platform === "win32")("hands keyboard input to the new process after Ink exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "atape-restart-terminal-"))
  try {
    const parent = join(root, "parent.mjs"), child = join(root, "child.mjs")
    await writeFile(parent, `
import React from ${JSON.stringify(import.meta.resolve("react"))};
import { render, Text, useInput } from ${JSON.stringify(import.meta.resolve("ink"))};
import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
import { restartInstalledCLI } from ${JSON.stringify(new URL("./restartCLI.ts", import.meta.url).href)};
let renderer;
function View() { useInput(() => renderer.unmount()); return React.createElement(Text, null, "PARENT_READY") }
renderer = render(React.createElement(View), { alternateScreen: true, exitOnCtrlC: false });
await renderer.waitUntilExit(); renderer.cleanup();
process.exitCode = await Effect.runPromise(restartInstalledCLI(process.argv[2], [], process.env));
`)
    await writeFile(child, `
process.stdin.setRawMode(true); process.stdin.resume(); console.log("CHILD_READY");
process.stdin.on("data", data => {
  console.log("INPUT:" + data.toString());
  if (data.toString() === "q") { process.stdin.setRawMode(false); process.exit(0) }
});
`)
    await promisify(execFile)("python3", [fileURLToPath(new URL("../../scripts/verify-restart.py", import.meta.url)), process.execPath, parent, child], { timeout: 15_000 })
  } finally { await rm(root, { recursive: true, force: true }) }
}, 20_000)
