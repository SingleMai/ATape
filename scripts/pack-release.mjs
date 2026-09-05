import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { loadReleaseContract } from "./release-contract.mjs"

const execute = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const release = await loadReleaseContract(repositoryRoot)
const releaseDirectory = release.releaseDirectory
const artifacts = release.packages.map((package_) => join(releaseDirectory, package_.artifactName))

await mkdir(releaseDirectory, { recursive: true })
await Promise.all([...artifacts, join(releaseDirectory, "SHA256SUMS")].map((path) => rm(path, { force: true })))
await run("pnpm", ["--filter", "@atape/cli", "pack:release"])
await run("pnpm", ["--filter", "@atape/adapter-codex", "pack:release"])

const checksums = []
for (const path of [...artifacts].sort()) {
  const metadata = await stat(path)
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`Release artifact is missing or empty: ${path}`)
  const digest = createHash("sha256").update(await readFile(path)).digest("hex")
  checksums.push(`${digest}  ${path.slice(releaseDirectory.length + 1)}`)
}
await writeFile(join(releaseDirectory, "SHA256SUMS"), `${checksums.join("\n")}\n`, { mode: 0o644 })
process.stdout.write(`Created ${artifacts.length} release artifacts and SHA256SUMS in ${releaseDirectory}\n`)

async function run(file, arguments_) {
  const result = await execute(file, arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
}
