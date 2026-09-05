import { execFile } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const releaseDirectory = fileURLToPath(new URL("../../../release", import.meta.url))

await mkdir(releaseDirectory, { recursive: true })
const result = await execute("npm", ["pack", "--pack-destination", releaseDirectory], {
  cwd: packageRoot,
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024
})
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
