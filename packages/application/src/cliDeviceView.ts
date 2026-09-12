import type { CLICredential } from "@atape/domain"
import { newer, stableVersion } from "./releaseVersion.ts"

const reasons = {
  unauthenticated: "Sign in again in ATape.",
  transport: "The CLI could not reach the server. Check its network connection.",
  adapter: "The Adapter could not collect data. Check the Project’s Sync details in ATape.",
  state: "The CLI could not save local progress. Check Sync details in ATape and local disk access.",
  contract: "The Adapter returned incompatible data. Check for Adapter updates locally.",
  partial: "Some sources could not be synchronized. Open the Project’s Sync details in ATape for details."
} as const

export const cliVersionView = (current: string, latest?: string) => {
  if (!latest || !stableVersion(latest) || !stableVersion(current)) return "Update status unknown"
  return newer(latest, current) ? `Update available · v${latest}` : newer(current, latest) ? "Ahead of latest stable" : "Latest stable version"
}

export const presentCLIDevice = (credential: CLICredential, now: number) => {
  const sync = credential.sync
  const received = Date.parse(credential.reportedAt ?? "")
  const stale = !Number.isFinite(received) || now - received > 120_000 || received > now + 30_000
  const issues = sync?.jobs.filter(job => job.state === "failed" || job.state === "partial") ?? []
  const status = !sync ? "Status not reported" : stale ? "Status expired"
    : sync.phase === "error" ? "Needs attention"
    : issues.length > 0 ? "Needs attention"
    : sync.phase === "stopped" ? "Collector stopped"
    : sync.phase === "syncing" ? "Syncing"
    : sync.jobs.some(job => job.hasMore) ? "Catching up"
    : sync.jobsTruncated ? "Partial status report"
    : sync.jobs.length === 0 ? "No projects configured"
    : sync.jobs.some(job => job.state === "pending") || sync.phase === "starting" ? "Waiting for first sync"
    : "Up to date"
  const guidance = !sync ? "Update the CLI and start the collector to report sync status."
    : stale ? "No status report in the last 2 minutes. The device may be asleep, disconnected, or the CLI may have stopped."
    : sync.phase === "error" ? "The collector could not start a sync cycle. Open the Project’s Sync details in ATape."
    : issues.length ? `${issues.length} Project/Adapter ${issues.length === 1 ? "job needs" : "jobs need"} attention. Open details, then check the CLI locally.`
    : sync.phase === "stopped" ? "Start the collector locally when you want to resume automatic synchronization."
    : sync.jobs.some(job => job.hasMore) ? "More content remains to be synchronized."
    : sync.jobsTruncated ? "This device has more jobs than fit in a status report. Check the Project’s Sync details in ATape for the full list."
    : sync.jobs.length === 0 ? "Configure projects and enable an Adapter in the CLI."
    : "The CLI reports automatically, even when there is no new content."
  const successes = sync?.jobs.flatMap(job => job.lastSuccessAt ? [job.lastSuccessAt] : []) ?? []
  const adapters = [...new Set([...(credential.device?.adapters?.map(a => a.id) ?? []), ...(sync?.jobs.map(j => j.adapterId) ?? [])])].map(id => {
    const installed = credential.device?.adapters?.find(a => a.id === id)
    const jobs = sync?.jobs.filter(j => j.adapterId === id) ?? []
    const attention = jobs.some(j => j.state === "failed" || j.state === "partial")
    const status = attention ? "Sync failed" : installed?.enabled === false ? "Disabled"
      : jobs.some(j => j.hasMore) ? "Catching up"
      : jobs.length === 0 ? "No sync reported"
      : jobs.some(j => j.state === "pending") ? "Waiting for first sync"
      : sync?.jobsTruncated ? "Partial status report" : "Synced"
    // A successful project must not hide a project that has never completed.
    const lastSuccessAt = jobs.length > 0 && jobs.every(j => j.lastSuccessAt)
      ? jobs.map(j => j.lastSuccessAt!).sort((a, b) => Date.parse(a) - Date.parse(b))[0] : undefined
    return { id, packageName: installed?.packageName ?? id, version: installed?.version,
      versionStatus: installed ? cliVersionView(installed.version, installed.latestVersion) : "Version not reported",
      status, attention, lastSuccessAt, jobs }
  })
  return { ...credential, status, guidance, adapters,
    attention: status === "Needs attention" || status === "Status expired",
    versionStatus: credential.device ? cliVersionView(credential.device.version, credential.device.latestVersion) : undefined,
    lastSuccessAt: successes.sort((a, b) => Date.parse(b) - Date.parse(a))[0],
    jobs: sync?.jobs.map(job => ({ ...job, guidance: job.reason ? reasons[job.reason] : undefined })) ?? [] }
}
export type CLIDeviceView = ReturnType<typeof presentCLIDevice>
