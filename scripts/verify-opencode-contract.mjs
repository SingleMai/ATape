import { requiredTest as codeBuddyRequiredTest, verifyCodeBuddyResult } from "./verify-codebuddy-contract.mjs"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

export const requiredTest = "TestHTTPAuthenticationAndAuthorizationContract/native_OpenCode_Collector"
export function verifyOpenCodeResult(events) {
  if (!events.some(event => event.Action === "pass" && event.Test === requiredTest &&
    event.Package === "github.com/SingleMai/ATape/server/internal/adapters/httpapi")) {
    throw new Error(`Required OpenCode contract did not pass (missing or skipped): ${requiredTest}`)
  }
}

async function run() {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== "--all") || args.length > 1) throw new Error("Use verify-opencode-contract.mjs [--all]")
  const packages = args.includes("--all")
    ? ["./internal/adapters/postgres", "./internal/adapters/httpapi", "./internal/authentication", "./internal/authcutover", "./internal/team"]
    : ["./internal/adapters/httpapi", "-run", "^TestHTTPAuthenticationAndAuthorizationContract$/^native_OpenCode_Collector$"]
  const child = spawn("go", ["test", ...packages, "-count=1", "-json"], {
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
      if (event.Test === requiredTest || event.Test === codeBuddyRequiredTest) events.push(event)
    } catch { malformed = true; process.stderr.write(`${line}\n`) }
  })
  const interrupt = () => child.kill("SIGINT")
  const terminate = () => child.kill("SIGTERM")
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate)
  try {
    const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done) })
    if (code !== 0 || malformed) throw new Error(`Go Adapter contracts failed (exit ${code}).`)
    verifyOpenCodeResult(events)
    if (args.includes("--all")) verifyCodeBuddyResult(events)
    console.log(args.includes("--all")
      ? "Required OpenCode and CodeBuddy/PostgreSQL/installed-daemon contracts passed."
      : "Required OpenCode/PostgreSQL/installed-daemon contract passed.")
  } finally {
    lines.close()
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(error.message); process.exitCode = 1 })
}
