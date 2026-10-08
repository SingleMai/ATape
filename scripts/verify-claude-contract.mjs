import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

export const requiredTest = "TestHTTPAuthenticationAndAuthorizationContract/native_Claude_Collector"
export function verifyClaudeResult(events) {
  if (!events.some(event => event.Action === "pass" && event.Test === requiredTest &&
    event.Package === "github.com/SingleMai/ATape/server/internal/adapters/httpapi")) {
    throw new Error(`Required Claude contract did not pass (missing or skipped): ${requiredTest}`)
  }
}

async function run() {
  if (process.argv.length !== 2) throw new Error("Use verify-claude-contract.mjs")
  const child = spawn("go", ["test", "./internal/adapters/httpapi", "-run",
    "^TestHTTPAuthenticationAndAuthorizationContract$/^native_Claude_Collector$", "-count=1", "-json", "-timeout=20m"], {
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
  const interrupt = () => child.kill("SIGINT"), terminate = () => child.kill("SIGTERM")
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate)
  try {
    const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done) })
    if (code !== 0 || malformed) throw new Error(`Go Claude contract failed (exit ${code}).`)
    verifyClaudeResult(events)
    console.log("Required Claude/PostgreSQL/authenticated installed-Collector contract passed.")
  } finally {
    lines.close()
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate)
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(error.message); process.exitCode = 1 })
}
