import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { loadReleaseContract } from "./release-contract.mjs"

const execute = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const release = await loadReleaseContract(repositoryRoot)
const tag = process.argv[2]

if (tag === undefined) throw new Error(`Expected release tag ${release.tag}.`)
if (tag !== release.tag) {
  throw new Error(`Release tag ${tag} does not match package version ${release.version}; expected ${release.tag}.`)
}
const verified = await execute(process.execPath, [
  "scripts/verify-auth-release-gates.mjs", "--mode", "release"
], { cwd: repositoryRoot, encoding: "utf8" })
process.stdout.write(verified.stdout)
process.stdout.write(`Release metadata and staging evidence match ${release.tag}.\n`)
