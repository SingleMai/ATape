import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { manualWaiverPathFor, verifyManualReleaseWaiver } from "./manual-release-waiver.mjs"

const execute = promisify(execFile)
const authorizedVersions = ["0.2.0", "0.3.0", "0.3.1", "0.4.0", "0.4.1"]
for (const version of authorizedVersions) test(`v${version} manual waiver is version-, scope- and candidate-bound without fabricating staging evidence`, async () => {
  const manualWaiverPath = manualWaiverPathFor(version)
  const root = await mkdtemp(join(tmpdir(), "atape-waiver-test-"))
  const git = args => execute("git", args, { cwd: root, encoding: "utf8" })
  const commit = async message => {
    await git(["add", "."])
    await git(["-c", "user.name=ATape Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", message])
  }
  try {
    await git(["init"])
    await writeFile(join(root, "code.txt"), "candidate")
    await commit("candidate")
    const waiver = {
      protocol: "atape.manual-release-waiver.v1", releaseVersion: version, authEpoch: "auth-v1",
      status: "authorized", candidateCommit: (await git(["rev-parse", "HEAD"])).stdout.trim(),
      authorizedOn: "2026-09-08", authorization: "Explicit user authorization of one-time manual waiver; automated checks remain required.",
      scope: "manual-staging-only", unverifiedChecks: ["staging", "signoff"], riskNotice: `docs/releases/v${version}.md`
    }
    await mkdir(dirname(join(root, manualWaiverPath)), { recursive: true })
    await writeFile(join(root, manualWaiverPath), JSON.stringify(waiver))
    await commit("record waiver")
    const release = { version, authEpoch: "auth-v1" }
    const checks = new Set(["staging", "signoff"])
    await verifyManualReleaseWaiver(root, waiver, release, checks)
    await assert.rejects(verifyManualReleaseWaiver(root, waiver, { ...release, version: "0.2.1" }, checks))
    await assert.rejects(verifyManualReleaseWaiver(root, waiver, { ...release, version: "0.3.2" }, checks))
    await assert.rejects(verifyManualReleaseWaiver(root, waiver, { ...release, version: "0.5.0" }, checks))
    await assert.rejects(verifyManualReleaseWaiver(root, waiver, { ...release, version: "0.4.2" }, checks))
    const otherVersion = version === "0.2.0" ? "0.3.0" : "0.2.0"
    for (const differentVersion of authorizedVersions.filter(candidate => candidate !== version)) {
      await assert.rejects(verifyManualReleaseWaiver(root, waiver, { ...release, version: differentVersion }, checks))
      await assert.rejects(verifyManualReleaseWaiver(root, { ...waiver, riskNotice: `docs/releases/v${differentVersion}.md` }, release, checks))
    }
    await assert.rejects(verifyManualReleaseWaiver(root, { ...waiver, scope: "all-checks" }, release, checks))
    await assert.rejects(verifyManualReleaseWaiver(root, { ...waiver, unverifiedChecks: ["signoff"] }, release, checks))
    await assert.rejects(verifyManualReleaseWaiver(root, { ...waiver, candidateCommit: "0".repeat(40) }, release, checks))
    await writeFile(join(root, manualWaiverPathFor(otherVersion)), JSON.stringify(waiver))
    await commit("change another release's evidence")
    await assert.rejects(verifyManualReleaseWaiver(root, waiver, release, checks), /Code changed/)
    await rm(join(root, manualWaiverPathFor(otherVersion)))
    await commit("restore unrelated evidence")
    await verifyManualReleaseWaiver(root, waiver, release, checks)
    await writeFile(join(root, "code.txt"), "unapproved changes")
    await commit("change code")
    await assert.rejects(verifyManualReleaseWaiver(root, waiver, release, checks), /Code changed/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
