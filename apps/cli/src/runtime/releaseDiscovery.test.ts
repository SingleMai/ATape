import { afterEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { releaseBundleFingerprint, releaseBundleSection, releasePackageNames, updateCatalogTag, type ReleaseBundle } from "@atape/domain"
import { createReleaseDiscovery, type ReleaseDiscovery } from "./releaseDiscovery.ts"

const catalogURL = `https://api.github.com/repos/SingleMai/ATape/releases/tags/${updateCatalogTag}`
const versionURL = (version: string) => `https://api.github.com/repos/SingleMai/ATape/releases/tags/v${version}`
const bytes = Buffer.from("verified immutable archive bytes")
const bundle = (version = "1.2.3", contract = "capture.v2", payload = bytes): ReleaseBundle => ({
  protocol: "atape.release-bundle.v1", version, captureStateContract: contract, updateControlProtocol: "atape.update-control.v1",
  packages: releasePackageNames.map(name => ({ name,
    integrity: `sha512-${createHash("sha512").update(payload).digest("base64")}`,
    tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${version}.tgz` }))
})
const extendedBundle = (version = "1.2.4", extraPayload = Buffer.from("future adapter archive bytes")): ReleaseBundle => ({
  ...bundle(version), packages: [...bundle(version).packages, { name: "@atape/adapter-future",
    integrity: `sha512-${createHash("sha512").update(extraPayload).digest("base64")}`,
    tarball: `https://registry.npmjs.org/@atape/adapter-future/-/adapter-future-${version}.tgz` }]
})
const release = (value: ReleaseBundle) => ({ tag_name: `v${value.version}`, body: `Notes\n${releaseBundleSection(value)}`,
  prerelease: false, draft: false, published_at: "2026-01-01T00:00:00Z" })
const catalogRelease = (bundles: ReadonlyArray<ReleaseBundle>, revision = 1) => ({ tag_name: updateCatalogTag,
  body: JSON.stringify({ protocol: "atape.update-catalog.v1", revision, bundles }),
  prerelease: true, draft: false, published_at: "2026-01-01T00:00:00Z" })
const signal = () => new AbortController().signal
const homes: string[] = []
const makeHome = async () => { const home = await mkdtemp(join(tmpdir(), "atape-release-discovery-")); homes.push(home); return home }
const discovery = (home: string, fetchMetadata: typeof fetch, runtimeVersion = "1.2.3") => createReleaseDiscovery({
  home, runtimeVersion, captureStateContract: "capture.v2", updateControlProtocol: "atape.update-control.v1", fetchMetadata
})
const latest = (client: ReleaseDiscovery) => client.latest({ cached: false, signal: signal() })
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

describe("release discovery caller Interface", () => {
  it("uses the persistent fixed tag, keeps unknown families and selects its exact pair", async () => {
    const requested: string[] = [], current = bundle(), future = bundle("3.0.0", "capture.v3")
    const client = discovery(await makeHome(), async (url, options) => {
      requested.push(String(url)); expect(options?.redirect).toBe("error"); expect(options?.signal).toBeDefined()
      return Response.json(catalogRelease([future, current]))
    })
    expect(await latest(client)).toEqual(current)
    expect(requested).toEqual([catalogURL])
  })

  it("rejects unknown compatibility, incomplete publication and malformed catalog releases", async () => {
    const value = catalogRelease([bundle()])
    for (const invalid of [catalogRelease([bundle("2.0.0", "future")]), { ...value, prerelease: false },
      { ...value, draft: true }, { ...value, tag_name: "v1.2.3" }, { ...value, published_at: "9999-01-01" },
      { ...value, body: "not json" }, { ...value, body: JSON.stringify({ protocol: "unknown", revision: 1, bundles: [] }) },
      catalogRelease([{ ...bundle(), packages: bundle().packages.slice(1) }])]) {
      await expect(latest(discovery(await makeHome(), async () => Response.json(invalid)))).rejects.toThrow()
    }
  })

  it("preserves the durable revision and all family floors across new processes", async () => {
    const home = await makeHome(), old = bundle(), next = bundle("1.2.4"), future = bundle("3.0.0", "future")
    await latest(discovery(home, async () => Response.json(catalogRelease([next, future], 4))))
    for (const response of [catalogRelease([old, future], 5), catalogRelease([next], 5), catalogRelease([next, future], 3),
      catalogRelease([next, bundle("3.0.1", "future")], 4)]) {
      await expect(latest(discovery(home, async () => Response.json(response)))).rejects.toThrow(/regressed|rewrote|removed/)
    }
    expect(await latest(discovery(home, async () => Response.json(catalogRelease([future, next], 4))))).toEqual(next)
  })

  it("rejects same-version changed bytes even at a higher revision", async () => {
    const home = await makeHome()
    await latest(discovery(home, async () => Response.json(catalogRelease([bundle()]))))
    const changed = bundle("1.2.3", "capture.v2", Buffer.from("different bytes"))
    await expect(latest(discovery(home, async () => Response.json(catalogRelease([changed], 2))))).rejects.toThrow(/rewrote|immutable/)
  })

  it("preserves additive package byte identity across catalog refreshes and exact version receipts", async () => {
    const home = await makeHome(), current = extendedBundle(), changed = extendedBundle(current.version, Buffer.from("rewritten future adapter"))
    await latest(discovery(home, async () => Response.json(catalogRelease([current]))))
    await expect(latest(discovery(home, async () => Response.json(catalogRelease([changed], 2))))).rejects.toThrow(/rewrote|immutable/)
    await expect(discovery(home, async () => Response.json(release(changed)))
      .exact({ version: current.version, signal: signal() })).rejects.toThrow("immutable")
    const neverCalled = vi.fn<typeof fetch>()
    expect(await discovery(home, neverCalled).latest({ cached: true, signal: signal() })).toEqual(current)
    expect(neverCalled).not.toHaveBeenCalled()
  })

  it("does not let a late old network response overwrite a concurrent newer catalog", async () => {
    const home = await makeHome()
    let resolveOld!: (response: Response) => void
    const old = latest(discovery(home, () => new Promise(resolve => { resolveOld = resolve })))
    await vi.waitFor(() => expect(resolveOld).toBeDefined())
    const next = bundle("1.2.4")
    await latest(discovery(home, async () => Response.json(catalogRelease([next], 2))))
    resolveOld(Response.json(catalogRelease([bundle()], 1)))
    await expect(old).rejects.toThrow("regressed")
    const neverCalled = vi.fn<typeof fetch>()
    expect(await discovery(home, neverCalled).latest({ cached: true, signal: signal() })).toEqual(next)
    expect(neverCalled).not.toHaveBeenCalled()
  })

  it("uses a last-valid cache offline without lowering its revision, but refresh reports transport failure", async () => {
    const home = await makeHome()
    await latest(discovery(home, async () => Response.json(catalogRelease([bundle()], 2))))
    const now = Date.now()
    vi.spyOn(Date, "now").mockReturnValue(now + 13 * 60 * 60 * 1_000)
    const offline = discovery(home, async () => { throw new Error("offline") })
    expect(await offline.latest({ cached: true, signal: signal() })).toEqual(bundle())
    await expect(latest(offline)).rejects.toThrow("transport")
    await expect(discovery(home, async () => Response.json(catalogRelease([bundle()], 1)))
      .latest({ cached: true, signal: signal() })).rejects.toThrow("regressed")
  })

  it("fails closed on corrupt durable state instead of silently resetting the reader floor", async () => {
    const home = await makeHome()
    await latest(discovery(home, async () => Response.json(catalogRelease([bundle()]))))
    await writeFile(join(home, "cache", "release-discovery", "catalog.json"), "broken")
    const fetchMetadata = vi.fn<typeof fetch>()
    await expect(latest(discovery(home, fetchMetadata))).rejects.toThrow("state is invalid")
    expect(fetchMetadata).not.toHaveBeenCalled()
  })

  it("does not bypass catalog advertisement with a versioned descriptor for another version", async () => {
    const home = await makeHome(), requested: string[] = []
    const client = discovery(home, async url => {
      requested.push(String(url))
      return Response.json(String(url) === catalogURL ? catalogRelease([bundle()]) : release(bundle("1.2.4")))
    })
    await expect(client.exact({ version: "1.2.4", signal: signal() })).rejects.toThrow("not an advertised")
    expect(requested).toEqual([catalogURL])
  })

  it("pins exact advertised descriptors and refuses changed or missing target descriptors", async () => {
    const home = await makeHome(), next = bundle("1.2.4")
    const client = discovery(home, async url => Response.json(String(url) === catalogURL ? catalogRelease([next]) : release(next)))
    expect(releaseBundleFingerprint(await client.exact({ version: next.version, signal: signal() })))
      .toBe(releaseBundleFingerprint(next))
    const changed = bundle(next.version, "capture.v2", Buffer.from("changed"))
    await expect(discovery(home, async () => Response.json(release(changed))).exact({ version: next.version, signal: signal() })).rejects.toThrow("immutable")
    await expect(discovery(home, async () => Response.json({ ...release(next), body: "only notes" }))
      .exact({ version: next.version, signal: signal() })).rejects.toThrow("no immutable")
  })

  it("derives only the actual running version during descriptor propagation, checking all seven exact npm packages", async () => {
    const requested: string[] = [], current = bundle(), client = discovery(await makeHome(), async url => {
      const address = String(url); requested.push(address)
      if (address === versionURL(current.version)) return new Response("missing", { status: 404 })
      const package_ = current.packages.find(item => address.includes(item.name.replace("/", "%2f")))!
      return Response.json({ name: package_.name, version: current.version, dist: package_,
        ...(package_.name === "@atape/cli" ? { atapeRuntime: { protocol: "atape.runtime.v1", stateContract: "capture.v2", updateControlProtocol: "atape.update-control.v1" } } : {}) })
    })
    expect(await client.exact({ version: current.version, signal: signal() })).toEqual(current)
    expect(requested).toHaveLength(8)
    expect(requested.slice(1)).toEqual(releasePackageNames.map(name => `https://registry.npmjs.org/${name.replace("/", "%2f")}/${current.version}`))
    expect(requested.some(url => url.endsWith("/latest"))).toBe(false)
  })

  it("does not hide invalid descriptors or incompatible runtime manifests behind the running-version fallback", async () => {
    const home = await makeHome(), current = bundle()
    const malformed = vi.fn<typeof fetch>(async () => Response.json({ ...release(current), body: "<!-- atape.release-bundle.v1:start -->broken" }))
    await expect(discovery(home, malformed).exact({ version: current.version, signal: signal() })).rejects.toThrow()
    expect(malformed).toHaveBeenCalledOnce()
    const incompatible: typeof fetch = async url => {
      if (String(url) === versionURL(current.version)) return new Response("missing", { status: 404 })
      const package_ = current.packages[0]!
      return Response.json({ name: package_.name, version: current.version, dist: package_,
        atapeRuntime: { protocol: "atape.runtime.v1", stateContract: "capture.v3", updateControlProtocol: "atape.update-control.v1" } })
    }
    await expect(discovery(home, incompatible).exact({ version: current.version, signal: signal() })).rejects.toThrow("incompatible runtime")
  })

  it("does not let historical exact lookup lower the latest catalog target", async () => {
    const home = await makeHome(), next = bundle("1.2.4")
    const client = discovery(home, async url => Response.json(String(url) === catalogURL ? catalogRelease([next], 2) : release(bundle())))
    await latest(client)
    expect(releaseBundleFingerprint(await client.exact({ version: "1.2.3", signal: signal() })))
      .toBe(releaseBundleFingerprint(bundle()))
    expect(await client.latest({ cached: true, signal: signal() })).toEqual(next)
  })
})

describe("verified scoped artifact acquisition", () => {
  it("accepts a future additive package descriptor but downloads only the known package the old caller requests", async () => {
    const home = await makeHome(), current = extendedBundle(), requested: string[] = []
    expect(releasePackageNames).not.toContain("@atape/adapter-future")
    const cli = current.packages.find(item => item.name === "@atape/cli")!
    const client = discovery(home, async url => {
      const address = String(url); requested.push(address)
      if (address === catalogURL) return Response.json(catalogRelease([current]))
      if (address === versionURL(current.version)) return Response.json(release(current))
      if (address === cli.tarball) return new Response(bytes)
      throw new Error(`Unexpected package download: ${address}`)
    })
    expect(await latest(client)).toEqual(current)
    const exact = await client.exact({ version: current.version, signal: signal() })
    expect(releaseBundleFingerprint(exact)).toBe(releaseBundleFingerprint(current))
    const archive = await client.acquireArtifact(exact, "@atape/cli", signal())
    expect(await readFile(archive.path)).toEqual(bytes)
    expect(requested).toEqual([catalogURL, versionURL(current.version), cli.tarball])
    await archive.release()
    await expect(readFile(archive.path)).rejects.toThrow()
  })

  it("returns only downloaded bytes matching the receipt and removes them after the caller releases the archive", async () => {
    const home = await makeHome(), current = bundle(), client = discovery(home,
      async url => String(url) === catalogURL ? Response.json(catalogRelease([current])) : new Response(bytes))
    await latest(client)
    const artifact = await client.acquireArtifact(current, "@atape/cli", signal())
    expect(await readFile(artifact.path)).toEqual(bytes)
    await artifact.release(); await artifact.release()
    await expect(readFile(artifact.path)).rejects.toThrow()
  })

  it("rejects undiscovered bundles before fetching bytes", async () => {
    const fetchMetadata = vi.fn<typeof fetch>(), client = discovery(await makeHome(), fetchMetadata)
    await expect(client.acquireArtifact(bundle(), "@atape/cli", signal())).rejects.toThrow("previously discovered")
    expect(fetchMetadata).not.toHaveBeenCalled()
  })

  it("rejects wrong archive bytes and cleans every failed lease", async () => {
    const home = await makeHome(), current = bundle(), client = discovery(home,
      async url => String(url) === catalogURL ? Response.json(catalogRelease([current])) : new Response("wrong bytes"))
    await latest(client)
    await expect(client.acquireArtifact(current, "@atape/cli", signal())).rejects.toThrow("does not match")
    expect(await readdir(join(home, "cache", "release-discovery", "artifacts"))).toEqual([])
  })

  it("rejects oversized declarations and streamed archives, cancelling remote readers", async () => {
    const home = await makeHome(), current = bundle(), cancelled = vi.fn()
    let response = new Response("small", { headers: { "content-length": String(16 * 1024 * 1024 + 1) } })
    const client = discovery(home, async url => String(url) === catalogURL ? Response.json(catalogRelease([current])) : response)
    await latest(client)
    await expect(client.acquireArtifact(current, "@atape/cli", signal())).rejects.toThrow("size limit")
    response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) }, cancel: cancelled }))
    await expect(client.acquireArtifact(current, "@atape/cli", signal())).rejects.toThrow("size limit")
    expect(cancelled).toHaveBeenCalledOnce()
    expect(await readdir(join(home, "cache", "release-discovery", "artifacts"))).toEqual([])
  })

  it("cancels a stalled body, releases its reader and removes the partial archive", async () => {
    const home = await makeHome(), current = bundle(), cancelled = vi.fn(), active = new AbortController()
    const response = new Response(new ReadableStream({ cancel: cancelled }))
    const client = discovery(home, async url => String(url) === catalogURL ? Response.json(catalogRelease([current])) : response)
    await latest(client)
    const pending = client.acquireArtifact(current, "@atape/cli", active.signal)
    await vi.waitFor(() => expect(response.body!.locked).toBe(true))
    active.abort(new Error("caller stopped"))
    await expect(pending).rejects.toThrow("caller stopped")
    expect(cancelled).toHaveBeenCalledOnce(); expect(response.body!.locked).toBe(false)
    expect(await readdir(join(home, "cache", "release-discovery", "artifacts"))).toEqual([])
  })

  it("does not begin network work after cancellation and bounds stalled metadata", async () => {
    const home = await makeHome(), fetchMetadata = vi.fn<typeof fetch>(), active = new AbortController()
    active.abort(new Error("already stopped"))
    const client = discovery(home, fetchMetadata)
    await expect(client.latest({ cached: false, signal: active.signal })).rejects.toThrow("already stopped")
    expect(fetchMetadata).not.toHaveBeenCalled()
    vi.useFakeTimers()
    let started!: () => void
    const start = new Promise<void>(resolve => { started = resolve })
    const pending = latest(discovery(home, () => { started(); return new Promise(() => {}) }))
    const result = expect(pending).rejects.toThrow("timed out")
    await start
    await vi.advanceTimersByTimeAsync(10_000)
    await result
  })

  it("bounds a stalled artifact body to thirty seconds and cleans its lease", async () => {
    const home = await makeHome(), current = bundle(), cancelled = vi.fn()
    const response = new Response(new ReadableStream({ cancel: cancelled }))
    let started!: () => void
    const start = new Promise<void>(resolve => { started = resolve })
    const client = discovery(home, async url => {
      if (String(url) === catalogURL) return Response.json(catalogRelease([current]))
      started(); return response
    })
    await latest(client)
    vi.useFakeTimers()
    const pending = client.acquireArtifact(current, "@atape/cli", signal())
    const result = expect(pending).rejects.toThrow("timed out")
    await start
    await vi.advanceTimersByTimeAsync(30_000)
    await result
    expect(cancelled).toHaveBeenCalledOnce()
    expect(await readdir(join(home, "cache", "release-discovery", "artifacts"))).toEqual([])
  })
})
