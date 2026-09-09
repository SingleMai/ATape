import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execute = promisify(execFile)
// Historical decisions retain their original date checks. Under ADR-0048, an
// explicit release request authorizes manual-only waiver evidence for that candidate.
const manualWaiverPaths = new Map([
  ["0.2.0", "docs/releases/evidence/v0.2.0-manual-waiver.json"],
  ["0.3.0", "docs/releases/evidence/v0.3.0-manual-waiver.json"],
  ["0.3.1", "docs/releases/evidence/v0.3.1-manual-waiver.json"],
  ["0.4.0", "docs/releases/evidence/v0.4.0-manual-waiver.json"],
  ["0.4.1", "docs/releases/evidence/v0.4.1-manual-waiver.json"],
  ["0.4.2", "docs/releases/evidence/v0.4.2-manual-waiver.json"],
  ["0.4.4", "docs/releases/evidence/v0.4.4-manual-waiver.json"],
  ["0.4.5", "docs/releases/evidence/v0.4.5-manual-waiver.json"]
])
export const manualWaiverPathFor = version => {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Release version must be SemVer")
  return manualWaiverPaths.get(version) ?? `docs/releases/evidence/v${version}-manual-waiver.json`
}

export async function verifyManualReleaseWaiver(root, waiver, release, requiredChecks) {
  const manualWaiverPath = manualWaiverPathFor(release.version)
  assert.ok(manualWaiverPath, "This release has no separately authorized manual waiver")
  assert.equal(release.authEpoch, "auth-v1")
  assert.deepEqual(Object.keys(waiver).sort(), ["protocol", "releaseVersion", "authEpoch", "status",
    "candidateCommit", "authorizedOn", "authorization", "scope", "unverifiedChecks", "riskNotice"].sort())
  assert.equal(waiver.protocol, "atape.manual-release-waiver.v1")
  assert.equal(waiver.releaseVersion, release.version)
  assert.equal(waiver.authEpoch, release.authEpoch)
  assert.equal(waiver.status, "authorized")
  assert.equal(waiver.scope, "manual-staging-only")
  if (manualWaiverPaths.has(release.version)) {
    assert.equal(waiver.authorizedOn, release.version === "0.4.5" ? "2026-09-09" : "2026-09-08")
  } else {
    assert.match(waiver.authorizedOn, /^\d{4}-\d{2}-\d{2}$/)
    const date = Date.parse(waiver.authorizedOn)
    assert.ok(Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === waiver.authorizedOn)
    assert.ok(waiver.authorizedOn >= "2026-09-09" && date <= Date.now(), "Authorization must follow the standing policy and not be future-dated")
  }
  assert.ok(typeof waiver.authorization === "string" && waiver.authorization.length >= 40)
  assert.equal(waiver.riskNotice, `docs/releases/v${release.version}.md`)
  assert.deepEqual([...waiver.unverifiedChecks].sort(), [...requiredChecks].sort(), "Waiver must disclose every unverified manual check")
  assert.match(waiver.candidateCommit, /^[0-9a-f]{40}$/)
  const git = args => execute("git", args, { cwd: root, encoding: "utf8" })
  await git(["merge-base", "--is-ancestor", waiver.candidateCommit, "HEAD"])
  const { stdout } = await git(["diff", "--name-only", waiver.candidateCommit, "HEAD"])
  const changed = stdout.trim() ? stdout.trim().split("\n") : []
  assert.ok(changed.every(path => path === manualWaiverPath), "Code changed after the waived candidate; release is blocked")
}
