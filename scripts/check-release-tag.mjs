import { fileURLToPath } from "node:url"
import { loadReleaseContract } from "./release-contract.mjs"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const release = await loadReleaseContract(repositoryRoot)
const tag = process.argv[2]

if (tag === undefined) throw new Error(`Expected release tag ${release.tag}.`)
if (tag !== release.tag) {
  throw new Error(`Release tag ${tag} does not match package version ${release.version}; expected ${release.tag}.`)
}
process.stdout.write(`Release metadata matches ${release.tag}.\n`)
