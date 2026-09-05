import { createReadStream } from "node:fs"
import { mkdir, mkdtemp, open, realpath, rm, stat } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { createGunzip } from "node:zlib"

const MaxCompressedBytes = 32 * 1024 * 1024
const MaxExpandedBytes = 64 * 1024 * 1024
const MaxManifestBytes = 256 * 1024
const TarBlockBytes = 512
const ManifestPath = "package/package.json"

export type AdapterPackageFetch = typeof globalThis.fetch

export type LocalAdapterPackage = {
  readonly path: string
  readonly packageJSON: unknown
}

export type DownloadedAdapterPackage = LocalAdapterPackage & {
  readonly release: () => Promise<void>
}

export const inspectLocalAdapterPackage = async (requestedPath: string): Promise<LocalAdapterPackage> => {
  const path = await realpath(resolve(requestedPath))
  const metadata = await stat(path)
  if (!metadata.isFile()) throw new Error("local Adapter archive is not a regular file")
  if (!isNpmTarball(path)) throw new Error("local Adapter archive must end in .tgz or .tar.gz")
  if (metadata.size === 0) throw new Error("local Adapter archive is empty")
  if (metadata.size > MaxCompressedBytes) {
    throw new Error(`local Adapter archive exceeds the ${formatMiB(MaxCompressedBytes)} compressed limit`)
  }
  return { path, packageJSON: await readPackageJSON(path) }
}

export const downloadAdapterPackage = async (
  packageURL: string,
  adapterDirectory: string,
  fetchPackage: AdapterPackageFetch
): Promise<DownloadedAdapterPackage> => {
  const requested = parseHTTPSURL(packageURL)
  if (!isNpmTarball(requested.pathname)) throw new Error("remote Adapter archive URL must end in .tgz or .tar.gz")

  await mkdir(adapterDirectory, { recursive: true, mode: 0o700 })
  const stagingDirectory = await mkdtemp(join(adapterDirectory, ".download-"))
  const archivePath = join(stagingDirectory, basename(requested.pathname) || "adapter.tgz")
  const release = () => rm(stagingDirectory, { recursive: true, force: true })

  try {
    const response = await fetchPackage(requested, {
      redirect: "follow",
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw new Error(`download returned HTTP ${response.status}`)
    parseHTTPSURL(response.url || requested.href)
    const declaredLength = response.headers.get("content-length")
    if (declaredLength !== null) {
      const bytes = Number(declaredLength)
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("download returned an invalid Content-Length")
      if (bytes > MaxCompressedBytes) {
        throw new Error(`remote Adapter archive exceeds the ${formatMiB(MaxCompressedBytes)} compressed limit`)
      }
    }
    if (response.body === null) throw new Error("download returned no archive body")

    const file = await open(archivePath, "wx", 0o600)
    let written = 0
    try {
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk)
        written += bytes.byteLength
        if (written > MaxCompressedBytes) {
          throw new Error(`remote Adapter archive exceeds the ${formatMiB(MaxCompressedBytes)} compressed limit`)
        }
        await file.write(bytes)
      }
      if (written === 0) throw new Error("downloaded Adapter archive is empty")
      await file.sync()
    } finally {
      await file.close()
    }

    return {
      path: archivePath,
      packageJSON: await readPackageJSON(archivePath),
      release
    }
  } catch (cause) {
    await release().catch(() => undefined)
    throw cause
  }
}

const readPackageJSON = async (archivePath: string): Promise<unknown> => {
  const compressed = createReadStream(archivePath)
  const expanded = compressed.pipe(createGunzip())
  let pending = Buffer.alloc(0)
  let expandedBytes = 0
  let zeroBlocks = 0
  let ended = false
  let entry: TarEntry | undefined
  let manifest: Buffer | undefined

  try {
    for await (const value of expanded) {
      const chunk = Buffer.from(value)
      expandedBytes += chunk.byteLength
      if (expandedBytes > MaxExpandedBytes) {
        throw new Error(`Adapter archive exceeds the ${formatMiB(MaxExpandedBytes)} expanded scan limit`)
      }
      if (ended) continue
      pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk])

      while (pending.byteLength > 0 && !ended) {
        if (entry === undefined) {
          if (pending.byteLength < TarBlockBytes) break
          const header = pending.subarray(0, TarBlockBytes)
          pending = pending.subarray(TarBlockBytes)
          if (header.every((byte) => byte === 0)) {
            zeroBlocks += 1
            ended = zeroBlocks === 2
            continue
          }
          zeroBlocks = 0
          validateChecksum(header)
          entry = parseEntry(header)
          if (entry.capture && entry.size > MaxManifestBytes) {
            throw new Error(`Adapter package.json exceeds the ${formatKiB(MaxManifestBytes)} limit`)
          }
          if (entry.capture && manifest !== undefined) {
            throw new Error("Adapter archive contains more than one package/package.json")
          }
        }

        const bodyBytes = Math.min(entry.remaining, pending.byteLength)
        if (bodyBytes > 0) {
          if (entry.capture) entry.chunks.push(Buffer.from(pending.subarray(0, bodyBytes)))
          pending = pending.subarray(bodyBytes)
          entry.remaining -= bodyBytes
        }
        if (entry.remaining > 0) break

        const paddingBytes = Math.min(entry.padding, pending.byteLength)
        pending = pending.subarray(paddingBytes)
        entry.padding -= paddingBytes
        if (entry.padding > 0) break

        if (entry.capture) manifest = Buffer.concat(entry.chunks, entry.size)
        entry = undefined
      }
    }
  } finally {
    expanded.destroy()
    compressed.destroy()
  }

  if (entry !== undefined || (!ended && pending.byteLength !== 0)) {
    throw new Error("Adapter archive is truncated")
  }
  if (manifest === undefined) throw new Error(`Adapter archive does not contain ${ManifestPath}`)
  const source = new TextDecoder("utf-8", { fatal: true }).decode(manifest)
  return JSON.parse(source) as unknown
}

type TarEntry = {
  readonly size: number
  readonly capture: boolean
  readonly chunks: Array<Buffer>
  remaining: number
  padding: number
}

const parseEntry = (header: Buffer): TarEntry => {
  const name = readTarText(header.subarray(0, 100))
  const prefix = readTarText(header.subarray(345, 500))
  const path = prefix === "" ? name : `${prefix}/${name}`
  const size = readTarNumber(header.subarray(124, 136), "entry size")
  const type = header[156]
  const capture = path === ManifestPath
  if (capture && type !== 0 && type !== 48) {
    throw new Error("Adapter package/package.json is not a regular file")
  }
  return {
    size,
    capture,
    chunks: [],
    remaining: size,
    padding: (TarBlockBytes - (size % TarBlockBytes)) % TarBlockBytes
  }
}

const validateChecksum = (header: Buffer) => {
  const expected = readTarNumber(header.subarray(148, 156), "header checksum")
  let actual = 0
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : (header[index] ?? 0)
  }
  if (actual !== expected) throw new Error("Adapter archive contains an invalid TAR header checksum")
}

const readTarText = (value: Buffer) => value.subarray(0, nullIndex(value)).toString("utf8")

const readTarNumber = (value: Buffer, label: string) => {
  if ((value[0] ?? 0) >= 0x80) throw new Error(`Adapter archive uses an unsupported binary TAR ${label}`)
  const source = readTarText(value).trim()
  if (!/^[0-7]+$/.test(source)) throw new Error(`Adapter archive contains an invalid TAR ${label}`)
  const result = Number.parseInt(source, 8)
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Adapter archive contains an invalid TAR ${label}`)
  return result
}

const nullIndex = (value: Buffer) => {
  const index = value.indexOf(0)
  return index === -1 ? value.byteLength : index
}

const parseHTTPSURL = (value: string) => {
  const url = new URL(value)
  if (url.protocol !== "https:") throw new Error("remote Adapter archives must use HTTPS")
  if (url.username !== "" || url.password !== "") throw new Error("remote Adapter archive URLs cannot contain credentials")
  return url
}

const isNpmTarball = (path: string) => path.endsWith(".tgz") || path.endsWith(".tar.gz")
const formatMiB = (bytes: number) => `${bytes / (1024 * 1024)} MiB`
const formatKiB = (bytes: number) => `${bytes / 1024} KiB`
