import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

// This is an installed Host contract with a synthetic external Cursor process.
// It deliberately does not claim authenticated Cursor native acceptance.
export const requiredTest = "TestHTTPAuthenticationAndAuthorizationContract/controlled_Cursor_start_and_capture"
export function verifyCursorResult(events) {
  if (!events.some(event => event.Action === "pass" && event.Test === requiredTest &&
    event.Package === "github.com/SingleMai/ATape/server/internal/adapters/httpapi")) {
    throw new Error(`Required controlled Cursor contract did not pass (missing or skipped): ${requiredTest}`)
  }
}

async function run() {
  if (process.argv.length !== 2) throw new Error("Use verify-cursor-contract.mjs")
  const child = spawn("go", ["test", "./internal/adapters/httpapi", "-run",
    "^TestHTTPAuthenticationAndAuthorizationContract$/^controlled_Cursor_start_and_capture$", "-count=1", "-json", "-timeout=15m"], {
    cwd: fileURLToPath(new URL("../server", import.meta.url)),
    env: { ...process.env, ATAPE_INTEGRATION_TESTS: "1", TESTCONTAINERS_RYUK_DISABLED: "true" },
    stdio: ["ignore", "pipe", "inherit"]
  })
  const events = []
  let malformed = false
  const lines = createInterface({ input: child.stdout })
  lines.on("line", line => {
    try {
      const event = JSON.parse(line)
      if (event.Output) process.stdout.write(event.Output)
      if (event.Test === requiredTest) events.push(event)
    } catch { malformed = true; process.stderr.write(`${line}\n`) }
  })
  const interrupt = () => child.kill("SIGINT")
  const terminate = () => child.kill("SIGTERM")
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate)
  try {
    const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done) })
    if (code !== 0 || malformed) throw new Error(`Controlled Cursor Adapter contract failed (exit ${code}).`)
    verifyCursorResult(events)
    console.log("Required controlled Cursor start/capture/PostgreSQL/installed-CLI contract passed (synthetic native fixture).")
  } finally {
    lines.close()
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(error.message); process.exitCode = 1 })
}
