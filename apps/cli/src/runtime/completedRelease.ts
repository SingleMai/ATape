import { officialSources } from "@atape/application"
import { Schema } from "effect"

const completedReleaseURL = "https://api.github.com/repos/SingleMai/ATape/releases/latest"
const registry = "https://registry.npmjs.org/"
const metadataLimit = 256 * 1024
const metadataTimeoutMs = 10_000
const allowedPackages = new Set<string>(["@atape/cli", ...officialSources.map(source => source.packageName)])
const CompletedRelease = Schema.Struct({
  tag_name: Schema.String,
  prerelease: Schema.Literal(false),
  draft: Schema.Literal(false),
  published_at: Schema.String
})
const PublishedPackage = Schema.Struct({ name: Schema.String, version: Schema.String })

const isStableVersion = (version: string): boolean =>
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) && version.length < 40 &&
  version.split(".").every(part => Number.isSafeInteger(Number(part)))

// This private reader bounds the entire request, including a stalled body. The
// external fetch receives cancellation, while the race also bounds controlled
// test Adapters that do not implement AbortSignal themselves.
const abortable = <A>(pending: Promise<A>, signal: AbortSignal): Promise<A> => {
  if (signal.aborted) {
    void pending.catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise<A>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort)
    const abort = () => { cleanup(); reject(signal.reason) }
    signal.addEventListener("abort", abort, { once: true })
    pending.then(value => { cleanup(); resolve(value) }, cause => { cleanup(); reject(cause) })
  })
}

const readMetadata = async (url: string, signal: AbortSignal, fetchMetadata: typeof fetch): Promise<unknown> => {
  signal.throwIfAborted()
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new Error("Release metadata request timed out.")), metadataTimeoutMs)
  timer.unref()
  const requestSignal = AbortSignal.any([signal, timeout.signal])
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await abortable(fetchMetadata(url, {
      signal: requestSignal,
      redirect: "error",
      headers: { accept: "application/json", "user-agent": "ATape automatic updater" }
    }), requestSignal)
    reader = response.body?.getReader()
    if (!response.ok || !reader) throw new Error("Completed release metadata unavailable.")
    const contentLength = response.headers.get("content-length")
    if (contentLength !== null && Number(contentLength) > metadataLimit) throw new Error("Release metadata too large.")
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const chunk = await abortable(reader.read(), requestSignal)
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > metadataLimit) throw new Error("Release metadata too large.")
      chunks.push(chunk.value)
    }
    requestSignal.throwIfAborted()
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
  } finally {
    clearTimeout(timer)
    if (reader) {
      // Do not let a broken remote stream delay cancellation/timeout cleanup.
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

export const completedReleaseVersion = async (
  signal: AbortSignal,
  fetchMetadata: typeof fetch = fetch
): Promise<string> => {
  const release = Schema.decodeUnknownSync(CompletedRelease)(await readMetadata(completedReleaseURL, signal, fetchMetadata))
  const version = release.tag_name.startsWith("v") ? release.tag_name.slice(1) : ""
  const publishedAt = Date.parse(release.published_at)
  if (!isStableVersion(version) || !Number.isFinite(publishedAt) || publishedAt > Date.now()) {
    throw new Error("GitHub Release is not a published stable ATape version.")
  }
  return version
}

export const verifyPublishedRelease = async (
  version: string,
  names: ReadonlyArray<string>,
  signal: AbortSignal,
  fetchMetadata: typeof fetch = fetch
): Promise<void> => {
  signal.throwIfAborted()
  if (!isStableVersion(version) || names.some(name => !allowedPackages.has(name))) {
    throw new Error("Invalid official release package selection.")
  }
  for (const name of new Set(names)) {
    const metadata = Schema.decodeUnknownSync(PublishedPackage)(await readMetadata(
      `${registry}${name.replace("/", "%2f")}/${version}`, signal, fetchMetadata
    ))
    if (metadata.name !== name || metadata.version !== version) {
      throw new Error("Official package does not match the completed release.")
    }
  }
}
