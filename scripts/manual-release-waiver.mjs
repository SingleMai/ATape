import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execute = promisify(execFile)
export const manualWaiverPath = "docs/releases/evidence/v0.2.0-manual-waiver.json"

export async function verifyManualReleaseWaiver(root, waiver, release, requiredChecks) {
  assert.equal(release.version, "0.2.0", "The manual waiver applies only to v0.2.0")
  assert.equal(release.authEpoch, "auth-v1")
  assert.deepEqual(Object.keys(waiver).sort(), ["protocol", "releaseVersion", "authEpoch", "status",
    "candidateCommit", "authorizedOn", "authorization", "scope", "unverifiedChecks", "riskNotice"].sort())
  assert.equal(waiver.protocol, "atape.manual-release-waiver.v1")
  assert.equal(waiver.releaseVersion, release.version)
  assert.equal(waiver.authEpoch, release.authEpoch)
  assert.equal(waiver.status, "authorized")
  assert.equal(waiver.scope, "manual-staging-only")
  assert.equal(waiver.authorizedOn, "2026-09-08")
  assert.ok(typeof waiver.authorization === "string" && waiver.authorization.length >= 40)
  assert.equal(waiver.riskNotice, "docs/releases/v0.2.0.md")
  assert.deepEqual([...waiver.unverifiedChecks].sort(), [...requiredChecks].sort(), "Waiver must disclose every unverified manual check")
  assert.match(waiver.candidateCommit, /^[0-9a-f]{40}$/)
  const git = args => execute("git", args, { cwd: root, encoding: "utf8" })
  await git(["merge-base", "--is-ancestor", waiver.candidateCommit, "HEAD"])
  const { stdout } = await git(["diff", "--name-only", waiver.candidateCommit, "HEAD"])
  const changed = stdout.trim() ? stdout.trim().split("\n") : []
  assert.ok(changed.every(path => path === manualWaiverPath), "Code changed after the waived candidate; release is blocked")
}
