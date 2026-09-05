import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { loadReleaseContract } from "./release-contract.mjs"

const execute = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const release = await loadReleaseContract(repositoryRoot)

if (process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("npm release publication is restricted to the GitHub Actions release workflow.")
}

for (const package_ of release.packages) {
  const artifact = join(release.releaseDirectory, package_.artifactName)
  const integrity = `sha512-${createHash("sha512").update(await readFile(artifact)).digest("base64")}`
  const publishedIntegrity = await readPublishedIntegrity(package_.name, package_.version)
  if (publishedIntegrity !== undefined) {
    if (publishedIntegrity !== integrity) {
      throw new Error(`${package_.name}@${package_.version} already exists with different tarball integrity.`)
    }
    process.stdout.write(`Already published ${package_.name}@${package_.version}; integrity matches.\n`)
    continue
  }

  const result = await execute("npm", [
    "publish", artifact,
    "--access", "public",
    "--provenance",
    "--registry", "https://registry.npmjs.org/"
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024
  })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
}

async function readPublishedIntegrity(name, version) {
  try {
    const result = await execute("npm", [
      "view", `${name}@${version}`, "dist.integrity", "--json",
      "--registry", "https://registry.npmjs.org/"
    ], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    })
    const value = JSON.parse(result.stdout)
    if (typeof value !== "string" || !value.startsWith("sha512-")) {
      throw new Error(`npm returned invalid integrity metadata for ${name}@${version}.`)
    }
    return value
  } catch (cause) {
    const stderr = cause && typeof cause === "object" && "stderr" in cause ? String(cause.stderr) : ""
    if (stderr.includes("E404")) return undefined
    throw cause
  }
}
