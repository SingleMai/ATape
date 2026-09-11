import { officialSources } from "@atape/application"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Schema } from "effect"

const registry = "https://registry.npmjs.org/"
const Cache = Schema.Struct({ checkedAt: Schema.Number, version: Schema.String })
const validVersion = (value: string) => /^\d+\.\d+\.\d+$/.test(value) && value.length < 40 &&
  value.split(".").every(part => Number.isSafeInteger(Number(part)))
const readBounded = async (file: string) => {
  if ((await stat(file)).size > 256 * 1024) throw new Error("Metadata too large")
  return JSON.parse(await readFile(file, "utf8"))
}

// Shared bounded metadata/cache Implementation for CLI and official readers.
export const latestPublishedVersion = async (home: string, name: string, cached: boolean,
  signal: AbortSignal, fetchMetadata: typeof globalThis.fetch) => {
  if (!["@atape/cli", ...officialSources.map(source => source.packageName)].includes(name)) throw new Error("Unknown official package")
  const file = join(home, "cache", `${name.slice("@atape/".length)}-update.json`)
  if (cached) {
    const saved = await readBounded(file).then(value => Schema.decodeUnknownSync(Cache)(value)).catch(() => undefined)
    const age = saved ? Date.now() - saved.checkedAt : -1
    if (saved && validVersion(saved.version) && age >= 0 && age < 12 * 60 * 60 * 1_000) return saved.version
  }
  const response = await fetchMetadata(`${registry}${name.replace("/", "%2f")}/latest`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(cached ? 1_500 : 10_000)]),
    redirect: "error", headers: { accept: "application/json" }
  })
  if (!response.ok || !response.body) throw new Error("Registry unavailable")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 256 * 1024) throw new Error("Metadata too large")
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const manifest = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.Literal(name), version: Schema.String }))(JSON.parse(Buffer.concat(chunks).toString("utf8")))
  if (!validVersion(manifest.version)) throw new Error("Invalid stable version")
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(temporary, JSON.stringify({ checkedAt: Date.now(), version: manifest.version }), { mode: 0o600 })
    await rename(temporary, file)
  } catch { /* An unwritable cache must not hide an available upgrade. */ }
  finally { await rm(temporary, { force: true }).catch(() => {}) }
  return manifest.version
}
