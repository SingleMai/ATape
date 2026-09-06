import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { loadReleaseContract } from "./release-contract.mjs"

const execute = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const modeIndex = process.argv.indexOf("--mode")
const mode = modeIndex === -1 ? "ci" : process.argv[modeIndex + 1]
if (mode !== "ci" && mode !== "release") throw new Error("--mode must be ci or release.")

const release = await loadReleaseContract(repositoryRoot)
const rootManifest = await readJSON("package.json")
const gates = await readJSON("specs/auth-v1-release-gates.json")
requireExactKeys(gates, ["protocol", "releaseVersion", "authEpoch", "attestation", "gates"], "release gates")
requireValue(gates.protocol === "atape.auth-release-gates.v1", "Release gates use an unsupported protocol.")
requireValue(gates.releaseVersion === release.version && gates.authEpoch === release.authEpoch,
  "Release gates do not match the canonical artifact identity.")
requireValue(Array.isArray(gates.gates) && gates.gates.length === 10, "Release gates must contain exactly gates 1 through 10.")

const requiredManualChecks = new Set()
for (let index = 0; index < gates.gates.length; index += 1) {
  const gate = gates.gates[index]
  requireExactKeys(gate, ["id", "name", "kind", "commands", "evidence", "manualRequirements"], `gate ${index + 1}`)
  requireValue(gate.id === index + 1, `Gate position ${index + 1} must have id ${index + 1}.`)
  requireValue(["automated", "mixed", "manual"].includes(gate.kind), `Gate ${gate.id} has an invalid kind.`)
  requireValue(Array.isArray(gate.commands) && gate.commands.length > 0, `Gate ${gate.id} must name executable commands.`)
  for (const command of gate.commands) {
    requireValue(typeof rootManifest.scripts?.[command] === "string", `Gate ${gate.id} references unknown package script ${command}.`)
  }
  requireValue(Array.isArray(gate.evidence) && gate.evidence.length > 0, `Gate ${gate.id} must index evidence.`)
  for (const evidence of gate.evidence) {
    requireExactKeys(evidence, ["path", "contains"], `gate ${gate.id} evidence`)
    const content = await readFile(join(repositoryRoot, evidence.path), "utf8")
    requireValue(content.includes(evidence.contains), `${evidence.path} no longer contains gate ${gate.id} marker ${evidence.contains}.`)
  }
  requireValue(Array.isArray(gate.manualRequirements), `Gate ${gate.id} manual requirements must be an array.`)
  requireValue(gate.kind === "automated" ? gate.manualRequirements.length === 0 : gate.manualRequirements.length > 0,
    `Gate ${gate.id} kind and manual requirements disagree.`)
  for (const check of gate.manualRequirements) {
    requireValue(typeof check === "string" && check.length > 0 && !requiredManualChecks.has(check),
      `Manual check ${check} is empty or duplicated.`)
    requiredManualChecks.add(check)
  }
}

const attestation = await readJSON(gates.attestation)
verifyAttestationShape(attestation, release, requiredManualChecks)
if (mode === "release") await verifyCompletedAttestation(attestation, gates.attestation)

process.stdout.write(mode === "release"
  ? `Verified completed ${release.tag} Authentication release gates.\n`
  : `Verified ${release.tag} Authentication gate index; staging attestation is ${attestation.status}.\n`)

function verifyAttestationShape(attestation, releaseContract, requiredChecks) {
  requireExactKeys(attestation, [
    "protocol", "releaseVersion", "authEpoch", "status", "testedCommit", "completedAt", "operator",
    "imageDigests", "backupRestoreId", "checks"
  ], "staging attestation")
  requireValue(attestation.protocol === "atape.auth-staging-attestation.v1", "Staging attestation uses an unsupported protocol.")
  requireValue(attestation.releaseVersion === releaseContract.version && attestation.authEpoch === releaseContract.authEpoch,
    "Staging attestation does not match the canonical artifact identity.")
  requireValue(["pending", "completed"].includes(attestation.status), "Staging attestation status must be pending or completed.")
  requireExactKeys(attestation.imageDigests, ["server", "web"], "staging image digests")
  requireValue(Array.isArray(attestation.checks), "Staging checks must be an array.")
  const seen = new Set()
  for (const check of attestation.checks) {
    requireExactKeys(check, ["id", "status", "evidenceUrl"], "staging check")
    requireValue(requiredChecks.has(check.id) && !seen.has(check.id), `Unexpected or duplicate staging check ${check.id}.`)
    requireValue(["pending", "passed"].includes(check.status), `Staging check ${check.id} has an invalid status.`)
    seen.add(check.id)
  }
  requireValue(seen.size === requiredChecks.size, "Staging attestation does not cover every manual release requirement.")
}

async function verifyCompletedAttestation(attestation, relativePath) {
  requireValue(attestation.status === "completed", "Release is blocked until the staging attestation is completed.")
  requireValue(/^[0-9a-f]{40}$/.test(attestation.testedCommit ?? ""), "Completed attestation requires a full tested commit SHA.")
  requireValue(typeof attestation.completedAt === "string" && !Number.isNaN(Date.parse(attestation.completedAt)),
    "Completed attestation requires an ISO completion timestamp.")
  requireValue(typeof attestation.operator === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(attestation.operator),
    "Completed attestation requires a non-secret operator handle.")
  requireValue(typeof attestation.backupRestoreId === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(attestation.backupRestoreId),
    "Completed attestation requires a non-secret backup/restore evidence ID.")
  for (const [artifact, digest] of Object.entries(attestation.imageDigests)) {
    requireValue(/^sha256:[0-9a-f]{64}$/.test(digest ?? ""), `Completed attestation requires the ${artifact} image digest.`)
  }
  for (const check of attestation.checks) {
    requireValue(check.status === "passed", `Release is blocked by staging check ${check.id}.`)
    requireValue(typeof check.evidenceUrl === "string" && /^https:\/\//.test(check.evidenceUrl),
      `Staging check ${check.id} requires an HTTPS evidence URL.`)
  }
  await runGit(["merge-base", "--is-ancestor", attestation.testedCommit, "HEAD"],
    "The tested commit is not an ancestor of the release commit.")
  const { stdout } = await runGit(["diff", "--name-only", attestation.testedCommit, "HEAD"])
  const changed = stdout.trim() === "" ? [] : stdout.trim().split("\n")
  requireValue(changed.every((path) => path === relativePath),
    `Files changed after staging validation: ${changed.filter((path) => path !== relativePath).join(", ")}.`)
}

async function readJSON(relativePath) {
  return JSON.parse(await readFile(join(repositoryRoot, relativePath), "utf8"))
}

async function runGit(arguments_, message) {
  try {
    return await execute("git", arguments_, { cwd: repositoryRoot, encoding: "utf8" })
  } catch (cause) {
    throw new Error(message ?? `git ${arguments_.join(" ")} failed.`, { cause })
  }
}

function requireExactKeys(value, expected, label) {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`)
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  requireValue(keys.length === wanted.length && keys.every((key, index) => key === wanted[index]),
    `${label} must contain exactly: ${wanted.join(", ")}.`)
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}
