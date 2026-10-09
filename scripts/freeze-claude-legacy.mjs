import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { freezeClaudeArtifact } from "./freeze-claude-artifact.mjs"
export { ClaudeLegacyFreezeError } from "./freeze-claude-artifact.mjs"

export const legacyClaudeRevision = "f6093535e92acfee47170b53c7dec7244fccf8c7"

/** Preserve the legacy gate's pinned public Interface. */
export const freezeClaudeLegacy = (options = {}) => freezeClaudeArtifact({ ...options, revision: legacyClaudeRevision })

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--directory") {
    console.error("Use node scripts/freeze-claude-legacy.mjs --directory /absolute/artifact-directory")
    process.exitCode = 1
  } else freezeClaudeLegacy({ directory: process.argv[3] }).then(result => console.log(JSON.stringify(result.metadata))).catch(error => {
    console.error(`${error.name}[${error.reason}]: ${error.message}`); process.exitCode = 1
  })
}
