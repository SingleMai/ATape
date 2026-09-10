import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { build } from "esbuild"

// Official Node 24 bookworm OCI index, with both linux/amd64 and arm64 images.
const image = "node@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2"
const execute = promisify(execFile)
const run = (args) => execute("docker", args, { encoding: "utf8", timeout: 180000, maxBuffer: 1024 * 1024 })
const root = await mkdtemp(join(tmpdir(), "atape-capture-disk-"))
let container
try {
  await build({ entryPoints: [fileURLToPath(new URL("../src/runtime/fixtures/capture-disk-contract.ts", import.meta.url))],
    outfile: join(root, "contract.mjs"), bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent" })
  container = (await run(["create", "--network", "none", "--memory", "512m", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--tmpfs", "/disk:rw,size=16m,mode=0700",
    image, "node", "/contract.mjs", "orchestrate"])).stdout.trim()
  assert.match(container, /^[a-f0-9]{64}$/)
  // Copy only the bundled contract: no host mounts, socket or credentials.
  await run(["cp", join(root, "contract.mjs"), `${container}:/contract.mjs`])
  const output = await run(["start", "--attach", container])
  assert.equal((await run(["inspect", "--format", "{{.State.ExitCode}}", container])).stdout.trim(), "0")
  process.stdout.write(output.stdout)
} finally {
  try { if (container) await run(["rm", "--force", container]) }
  finally { await rm(root, { recursive: true, force: true }) }
}
