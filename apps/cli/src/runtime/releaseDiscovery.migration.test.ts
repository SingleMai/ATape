import { managedReleaseBundleFingerprint, mergeMigrationReleaseBundle, releaseBundleURL, releaseCatalogURL, releasePackageNames,
  type MigrationReleaseBundle, type ReleaseBundle } from "@atape/domain"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createReleaseDiscovery, type ReleaseDiscovery } from "./releaseDiscovery.ts"

const v2URL = releaseCatalogURL("atape.update-catalog.v2"), v1URL = releaseCatalogURL("atape.update-catalog.v1")
const versionURL = (version: string) => releaseBundleURL(version, "atape.release-bundle.v2")
const legacyVersionURL = (version: string) => releaseBundleURL(version, "atape.release-bundle.v1")
const bytes = Buffer.from("verified migration-capable archive")
const plan = { protocol: "atape.capture-migration.v1", id: "journal-v7-to-v8" }
const bundle = (version = "1.2.4", payload = bytes): MigrationReleaseBundle => ({
  protocol: "atape.release-bundle.v2", version, captureStateContract: "capture.v2", updateControlProtocol: "atape.update-control.v1",
  migration: { ...plan, fromCaptureStateContracts: ["capture.v1", "capture.v2"] },
  packages: releasePackageNames.map(name => ({ name, integrity: `sha512-${createHash("sha512").update(payload).digest("base64")}`,
    tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${version}.tgz` }))
})
const legacy = (version = "1.2.3", contract = "capture.v1"): ReleaseBundle => ({
  protocol: "atape.release-bundle.v1", version, captureStateContract: contract, updateControlProtocol: "atape.update-control.v1",
  packages: bundle(version).packages
})
const release = (value: MigrationReleaseBundle) => value
const catalogRelease = (catalog = mergeMigrationReleaseBundle(undefined, bundle())) => catalog
const legacyCatalogRelease = () => ({ protocol: "atape.update-catalog.v1", revision: 1, bundles: [legacy()] })
const signal = () => new AbortController().signal
const homes: string[] = []
const makeHome = async () => { const home = await mkdtemp(join(tmpdir(), "atape-migration-discovery-")); homes.push(home); return home }
const discovery = (home: string, fetchMetadata: typeof fetch, options: { runtimeVersion?: string; captureStateContract?: string;
  supportedMigrationPlans?: ReadonlyArray<{ protocol: string; id: string }> } = {}) => createReleaseDiscovery({
  home, runtimeVersion: options.runtimeVersion ?? "1.2.3", captureStateContract: options.captureStateContract ?? "capture.v1",
  updateControlProtocol: "atape.update-control.v1", supportedMigrationPlans: options.supportedMigrationPlans ?? [plan], fetchMetadata
})
const latest = async (client: ReleaseDiscovery) => (await client.latest({ cached: false, signal: signal() })).bundle
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

describe("migration release discovery caller Interface", () => {
  it("prefers the separate fixed catalog and follows only known source/control/plan routes across capture contracts", async () => {
    const home = await makeHome(), requested: string[] = []
    const unknown = { ...bundle("9.0.0"), migration: { ...bundle().migration, id: "future-plan" } }
    const catalog = mergeMigrationReleaseBundle(mergeMigrationReleaseBundle(undefined, bundle()), unknown)
    const client = discovery(home, async url => { requested.push(String(url)); return Response.json(catalogRelease(catalog)) })
    expect(await latest(client)).toEqual(bundle())
    expect(requested).toEqual([v2URL])
    const never = vi.fn<typeof fetch>()
    expect(await discovery(home, never).latest({ cached: true, signal: signal() })).toEqual({ bundle: bundle(), freshness: "fresh" })
    expect(never).not.toHaveBeenCalled()
    expect(await readFile(join(home, "cache", "release-discovery-v2", "bundles", "9.0.0.json"), "utf8")).toContain("future-plan")
    await expect(readFile(join(home, "cache", "release-discovery", "catalog.json"))).rejects.toThrow()
  })

  it("leaves callers without migration support on the original v1 route", async () => {
    const requested: string[] = []
    const client = createReleaseDiscovery({ home: await makeHome(), runtimeVersion: "1.2.3", captureStateContract: "capture.v1",
      updateControlProtocol: "atape.update-control.v1", fetchMetadata: async url => {
        requested.push(String(url)); return Response.json(legacyCatalogRelease())
      } })
    expect(await latest(client)).toEqual(legacy())
    expect(requested).toEqual([v1URL])
  })

  it("falls back to v1 only for the first missing v2 tag and later adopts v2", async () => {
    const home = await makeHome(), requested: string[] = []
    const client = discovery(home, async url => {
      requested.push(String(url)); return String(url) === v2URL ? new Response("missing", { status: 404 }) : Response.json(legacyCatalogRelease())
    })
    expect(await latest(client)).toEqual(legacy())
    expect(requested).toEqual([v2URL, v1URL])
    expect(await latest(discovery(home, async () => Response.json(catalogRelease())))).toEqual(bundle())
  })

  it.each(["malformed", "transport", "unknown-plan", "unknown-source", "wrong-control", "wrong-tag"] as const)(
    "does not silently fall back before first adoption on %s", async mode => {
      const requested: string[] = [], home = await makeHome()
      const catalog = mergeMigrationReleaseBundle(undefined, bundle())
      const modified = mode === "unknown-plan" ? { ...bundle(), migration: { ...bundle().migration, id: "unknown" } } :
        mode === "wrong-control" ? { ...bundle(), updateControlProtocol: "future.control" } : bundle()
      const client = discovery(home, async url => {
        requested.push(String(url))
        if (mode === "transport") throw new Error("offline")
        return Response.json(mode === "malformed" ? { ...catalogRelease(), body: "invalid" } :
          mode === "wrong-tag" ? { ...catalogRelease(), protocol: "atape.update-catalog.v1" } :
          catalogRelease(mode === "unknown-plan" || mode === "wrong-control" ? mergeMigrationReleaseBundle(undefined, modified) : catalog))
      }, { captureStateContract: mode === "unknown-source" ? "capture.unknown" : "capture.v1" })
      await expect(latest(client)).rejects.toThrow()
      expect(requested).toEqual(mode === "transport" ? [v2URL, v2URL, v2URL] : [v2URL])
    })

  it("never returns to v1 after adoption, retaining its own validated cache offline", async () => {
    const home = await makeHome(); await latest(discovery(home, async () => Response.json(catalogRelease())))
    const requested: string[] = [], missing = discovery(home, async url => {
      requested.push(String(url)); return new Response("missing", { status: 404 })
    })
    await expect(latest(missing)).rejects.toThrow()
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 13 * 60 * 60 * 1_000)
    expect(await missing.latest({ cached: true, signal: signal() })).toEqual({ bundle: bundle(), freshness: "stale" })
    expect(requested).toEqual([v2URL, v2URL])
    await expect(latest(discovery(home, async () => Response.json({ ...catalogRelease(), body: "broken" })))).rejects.toThrow()
  })

  it("uses a verified stale migration catalog immediately on a transient failure under a short caller deadline", async () => {
    const home = await makeHome()
    await latest(discovery(home, async () => Response.json(catalogRelease())))
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 13 * 60 * 60 * 1_000)
    const fetchMetadata = vi.fn<typeof fetch>(async () => new Response("busy", { status: 429, headers: { "retry-after": "3600" } }))
    const short = AbortSignal.timeout(1_500)
    expect(await discovery(home, fetchMetadata).latest({ cached: true, signal: short }))
      .toEqual({ bundle: bundle(), freshness: "stale" })
    expect(fetchMetadata).toHaveBeenCalledOnce()
    expect(short.aborted).toBe(false)
  })

  it("remembers adoption even when exact current-version lookup precedes a catalog", async () => {
    const home = await makeHome(), current = bundle("1.2.3")
    expect(managedReleaseBundleFingerprint(await discovery(home, async () => Response.json(release(current)))
      .exact({ version: current.version, signal: signal() }))).toBe(managedReleaseBundleFingerprint(current))
    const requested: string[] = []
    await expect(latest(discovery(home, async url => { requested.push(String(url)); return new Response("missing", { status: 404 }) }))).rejects.toThrow()
    expect(requested).toEqual([v2URL])
    expect(JSON.parse(await readFile(join(home, "cache", "release-discovery-v2", "adopted.json"), "utf8")))
      .toEqual({ protocol: "atape.update-catalog.v2" })
  })

  it("rejects a late 404 fallback after another reader adopts v2", async () => {
    const home = await makeHome(); let resolveMissing!: (response: Response) => void
    const stale = latest(discovery(home, async url => String(url) === v2URL ?
      new Promise(resolve => { resolveMissing = resolve }) : Response.json(legacyCatalogRelease())))
    const rejection = expect(stale).rejects.toThrow("adopted")
    await vi.waitFor(() => expect(resolveMissing).toBeDefined())
    await latest(discovery(home, async () => Response.json(catalogRelease())))
    resolveMissing(new Response("missing", { status: 404 })); await rejection
  })

  it("retains route floors and immutable revisions across processes while allowing old superseded bundles to be pruned", async () => {
    const home = await makeHome(), old = mergeMigrationReleaseBundle(undefined, bundle())
    const next = mergeMigrationReleaseBundle(old, bundle("1.2.5"))
    await latest(discovery(home, async () => Response.json(catalogRelease(next))))
    for (const invalid of [old, { ...next, revision: next.revision + 1, routes: next.routes.slice(0, 1) },
      { ...next, revision: next.revision + 1, routes: old.routes, bundles: old.bundles }]) {
      await expect(latest(discovery(home, async () => Response.json(catalogRelease(invalid))))).rejects.toThrow(/regressed|removed/)
    }
    const rewritten = mergeMigrationReleaseBundle(next, { ...bundle("1.2.6"), migration: { ...bundle().migration, id: "other-plan" } })
    await expect(latest(discovery(home, async () => Response.json(catalogRelease({ ...rewritten, revision: next.revision }))))).rejects.toThrow("revision")
    expect(await latest(discovery(home, async () => Response.json(catalogRelease({ ...next, routes: [...next.routes].reverse() }))))).toEqual(bundle("1.2.5"))
  })

  it("rejects immutable bundle changes even after a target was superseded or in an unknown route", async () => {
    const home = await makeHome(), first = mergeMigrationReleaseBundle(undefined, bundle())
    await latest(discovery(home, async () => Response.json(catalogRelease(first))))
    const next = mergeMigrationReleaseBundle(first, bundle("1.2.5"))
    await latest(discovery(home, async () => Response.json(catalogRelease(next))))
    const never = vi.fn<typeof fetch>()
    expect(await discovery(home, never).exact({ version: "1.2.4", signal: signal() })).toEqual(bundle())
    expect(never).not.toHaveBeenCalled()
    const unknown = { ...bundle("9.0.0"), migration: { ...bundle().migration, id: "unknown" } }
    const third = mergeMigrationReleaseBundle(next, unknown)
    await latest(discovery(home, async () => Response.json(catalogRelease(third))))
    const changed = { ...third, revision: third.revision + 1, bundles: third.bundles.map(item => item.version === unknown.version ?
      { ...unknown, packages: bundle("9.0.0", Buffer.from("changed unknown bytes")).packages } : item) }
    await expect(latest(discovery(home, async () => Response.json(catalogRelease(changed))))).rejects.toThrow("immutable")
  })

  it("requires advertisement before exact target lookup and reuses the immutable migration receipt", async () => {
    const home = await makeHome(), current = bundle(), requested: string[] = []
    const client = discovery(home, async url => { requested.push(String(url)); return Response.json(catalogRelease()) })
    expect(managedReleaseBundleFingerprint(await client.exact({ version: current.version, signal: signal() })))
      .toBe(managedReleaseBundleFingerprint(current))
    expect(requested).toEqual([v2URL])
    await expect(discovery(await makeHome(), async () => Response.json(catalogRelease()))
      .exact({ version: "1.2.6", signal: signal() })).rejects.toThrow("not an advertised")
  })

  it("never lets malformed or wrong-protocol static v2 descriptors fall back to legacy", async () => {
    const current = bundle("1.2.3")
    for (const value of [legacy(current.version, "capture.v2"), { ...current, unexpected: true }, { ...current, version: "1.2.9" }]) {
      const requests: string[] = []
      await expect(discovery(await makeHome(), async url => { requests.push(String(url)); return Response.json(value) }, { captureStateContract: "capture.v2" })
        .exact({ version: current.version, signal: signal() })).rejects.toThrow()
      expect(requests).toEqual([versionURL(current.version)])
    }
  })

  it("does not mistake a legacy family receipt for migration-route publication", async () => {
    const home = await makeHome(), target = bundle()
    const old = createReleaseDiscovery({ home, runtimeVersion: "1.2.3", captureStateContract: "capture.v1", updateControlProtocol: "atape.update-control.v1",
      fetchMetadata: async () => Response.json({ protocol: "atape.update-catalog.v1", revision: 1,
        bundles: [legacy(), legacy(target.version, "capture.v2")] }) })
    await latest(old)
    const requested: string[] = []
    const client = discovery(home, async url => {
      requested.push(String(url)); return Response.json(String(url) === versionURL(target.version) ? release(target) :
        catalogRelease(mergeMigrationReleaseBundle(undefined, bundle("1.2.5"))))
    })
    await expect(client.exact({ version: target.version, signal: signal() })).rejects.toThrow("not an advertised")
    expect(requested).toEqual([versionURL(target.version), v2URL])
    await expect(readFile(join(home, "cache", "release-discovery-v2", "bundles", `${target.version}.json`))).rejects.toThrow()
  })

  it("binds the same npm version to the same package bytes across independent v1 and v2 receipts", async () => {
    const home = await makeHome(), target = bundle("1.2.3")
    const old = createReleaseDiscovery({ home, runtimeVersion: "1.2.3", captureStateContract: "capture.v2", updateControlProtocol: "atape.update-control.v1",
      fetchMetadata: async () => Response.json(legacy("1.2.3", "capture.v2")) })
    await old.exact({ version: "1.2.3", signal: signal() })
    await expect(discovery(home, async () => Response.json(release({ ...target, packages: bundle(target.version, Buffer.from("changed npm version")).packages })))
      .exact({ version: target.version, signal: signal() })).rejects.toThrow("across catalog protocols")
  })

  it("does not adopt v2 or authorize an earlier new target when a later bundle conflicts across protocols", async () => {
    const home = await makeHome(), current = legacy("1.2.3", "capture.v2"), next = bundle()
    const old = createReleaseDiscovery({ home, runtimeVersion: current.version, captureStateContract: "capture.v2",
      updateControlProtocol: "atape.update-control.v1", fetchMetadata: async () => Response.json(current) })
    await old.exact({ version: current.version, signal: signal() })
    const conflicting = { ...bundle(current.version, Buffer.from("rewritten historical npm bytes")),
      migration: { ...bundle().migration, id: "future-plan" } }
    const rejected = mergeMigrationReleaseBundle(mergeMigrationReleaseBundle(undefined, next), conflicting)
    expect(rejected.bundles.map(item => item.version)).toEqual([next.version, current.version])
    await expect(latest(discovery(home, async () => Response.json(rejected), { captureStateContract: "capture.v2" })))
      .rejects.toThrow("across catalog protocols")
    for (const path of ["adopted.json", "catalog.json", `bundles/${next.version}.json`]) {
      await expect(readFile(join(home, "cache", "release-discovery-v2", path))).rejects.toThrow()
    }
    const unavailable = vi.fn<typeof fetch>(async () => new Response("busy", { status: 503, headers: { "retry-after": "3600" } }))
    await expect(discovery(home, unavailable).exact({ version: next.version, signal: signal() })).rejects.toThrow("HTTP 503")
    expect(unavailable).toHaveBeenCalledOnce()
    expect(String(unavailable.mock.calls[0]![0])).toBe(v2URL)
  })

  it("allows a same-contract legacy receipt for exact maintenance after global v2 adoption without inventing a migration receipt", async () => {
    const home = await makeHome(), current = legacy("1.2.3", "capture.v2")
    const old = createReleaseDiscovery({ home, runtimeVersion: current.version, captureStateContract: "capture.v2",
      updateControlProtocol: "atape.update-control.v1", fetchMetadata: async () => Response.json(current) })
    await old.exact({ version: current.version, signal: signal() })
    await latest(discovery(home, async () => Response.json(catalogRelease()), { captureStateContract: "capture.v2" }))
    const offline = discovery(home, async () => new Response("offline", { status: 503, headers: { "retry-after": "3600" } }),
      { captureStateContract: "capture.v2" })
    expect(await offline.exact({ version: current.version, signal: signal() })).toEqual(current)
    await expect(readFile(join(home, "cache", "release-discovery-v2", "bundles", `${current.version}.json`))).rejects.toThrow()
    await expect(discovery(home, async () => new Response("offline", { status: 503, headers: { "retry-after": "3600" } }))
      .exact({ version: current.version, signal: signal() })).rejects.toThrow("capture/control")
  })

  it("reuses a known v2 receipt across a new discovery process and refuses its corruption before network work", async () => {
    const home = await makeHome(), current = bundle("1.2.3")
    await discovery(home, async () => Response.json(current)).exact({ version: current.version, signal: signal() })
    const never = vi.fn<typeof fetch>()
    expect(await discovery(home, never).exact({ version: current.version, signal: signal() })).toEqual(current)
    expect(never).not.toHaveBeenCalled()
    await writeFile(join(home, "cache", "release-discovery-v2", "bundles", `${current.version}.json`), "broken")
    await expect(discovery(home, never).exact({ version: current.version, signal: signal() })).rejects.toThrow("state is invalid")
    expect(never).not.toHaveBeenCalled()
  })

  it("preserves actual running-version derive fallback when no migration descriptor has ever existed", async () => {
    const current = legacy(), requested: string[] = []
    const client = discovery(await makeHome(), async url => {
      const address = String(url); requested.push(address)
      if ([versionURL(current.version), legacyVersionURL(current.version)].includes(address)) return new Response("missing", { status: 404 })
      const package_ = current.packages.find(item => address.includes(item.name.replace("/", "%2f")))!
      return Response.json({ name: package_.name, version: current.version, dist: package_,
        ...(package_.name === "@atape/cli" ? { atapeRuntime: { protocol: "atape.runtime.v1", stateContract: "capture.v1", updateControlProtocol: "atape.update-control.v1" } } : {}) })
    })
    expect(await client.exact({ version: current.version, signal: signal() })).toEqual(current)
    expect(requested).toHaveLength(releasePackageNames.length + 2)
    expect(requested).not.toContain(v2URL)
  })

  it("acquires only bytes bound to a strict migration receipt and cleans failed leases", async () => {
    const home = await makeHome(), current = bundle(), requested: string[] = []
    const client = discovery(home, async url => { requested.push(String(url)); return String(url) === v2URL ? Response.json(catalogRelease()) : new Response(bytes) })
    await expect(client.acquireArtifact(current, "@atape/cli", signal())).rejects.toThrow("previously discovered")
    expect(requested).toEqual([])
    await latest(client)
    const acquired = await client.acquireArtifact(current, "@atape/cli", signal())
    expect(await readFile(acquired.path)).toEqual(bytes)
    expect(acquired.path).toContain("release-discovery-v2")
    await acquired.release(); await expect(readFile(acquired.path)).rejects.toThrow()
    await expect(client.acquireArtifact({ ...current, migration: { ...current.migration, fromCaptureStateContracts: ["capture.v2"] } }, "@atape/cli", signal()))
      .rejects.toThrow("capture/control")
    const wrong = discovery(home, async () => new Response("wrong archive"))
    await expect(wrong.acquireArtifact(current, "@atape/cli", signal())).rejects.toThrow("does not match")
    expect(await readdir(join(home, "cache", "release-discovery-v2", "artifacts"))).toEqual([])
    expect(managedReleaseBundleFingerprint(current)).toContain("journal-v7-to-v8")
  })

  it("fails closed on corrupt v2 cache, receipt or adoption instead of reading v1", async () => {
    for (const file of ["catalog.json", "adopted.json", "bundles/1.2.4.json"]) {
      const home = await makeHome(); await latest(discovery(home, async () => Response.json(catalogRelease())))
      await writeFile(join(home, "cache", "release-discovery-v2", file), "broken")
      const never = vi.fn<typeof fetch>()
      const client = discovery(home, never)
      await expect(file.startsWith("bundles") ? client.acquireArtifact(bundle(), "@atape/cli", signal()) : latest(client)).rejects.toThrow("state is invalid")
      await expect(client.latest({ cached: true, signal: signal() })).rejects.toThrow("state is invalid")
      if (!file.startsWith("bundles")) {
        await expect(client.exact({ version: "1.2.3", signal: signal() })).rejects.toThrow("state is invalid")
        await expect(client.acquireArtifact(bundle(), "@atape/cli", signal())).rejects.toThrow("state is invalid")
      }
      expect(never).not.toHaveBeenCalled()
    }
  })
})
