import { managedReleaseBundleFingerprint, mergeTargetReleaseBundle, mergeMigrationReleaseBundle, releaseBundleURL,
  releaseCatalogURL, releasePackageNames, updateTargetProtocol, type TargetReleaseBundle } from "@atape/domain"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createReleaseDiscovery } from "./releaseDiscovery.ts"

const bytes = Buffer.from("target-owned immutable CLI"), signal = () => new AbortController().signal
const target = (version = "0.5.12", payload = bytes): TargetReleaseBundle => ({ protocol: "atape.release-bundle.v3", version,
  captureStateContract: "capture.v2", updateControlProtocol: "atape.update-control.v1", updateTargetProtocol,
  fromCaptureStateContracts: ["capture.v1", "capture.v2"], packages: releasePackageNames.map(name => ({ name,
    integrity: `sha512-${createHash("sha512").update(payload).digest("base64")}`,
    tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${version}.tgz` })) })
const legacy = () => ({ protocol: "atape.release-bundle.v2" as const, version: "0.5.11", captureStateContract: "capture.v2",
  updateControlProtocol: "atape.update-control.v1", packages: target("0.5.11").packages,
  migration: { protocol: "atape.capture-migration.v1", id: "journal-v7-to-v8", fromCaptureStateContracts: ["capture.v1", "capture.v2"] } })
const homes: string[] = [], makeHome = async () => { const home = await mkdtemp(join(tmpdir(), "atape-target-discovery-")); homes.push(home); return home }
const client = (home: string, fetchMetadata: typeof fetch, capable = true) => createReleaseDiscovery({ home,
  runtimeVersion: "0.5.11", captureStateContract: "capture.v2", updateControlProtocol: "atape.update-control.v1",
  ...(capable ? { updateTargetProtocol } : {}), supportedMigrationPlans: [{ protocol: "atape.capture-migration.v1", id: "journal-v7-to-v8" }], fetchMetadata })
const v3URL = releaseCatalogURL("atape.update-catalog.v3"), v2URL = releaseCatalogURL("atape.update-catalog.v2")
const latest = (instance: ReturnType<typeof client>, cached = false) => instance.latest({ cached, signal: signal() })
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

describe("target-owned discovery through the caller Interface", () => {
  it("selects the v3 feature while a caller without target protocol retains its v2 bridge route", async () => {
    const requested: string[] = [], transport: typeof fetch = async url => {
      requested.push(String(url)); return Response.json(String(url) === v3URL ? mergeTargetReleaseBundle(undefined, target()) : mergeMigrationReleaseBundle(undefined, legacy()))
    }
    expect((await latest(client(await makeHome(), transport))).bundle).toEqual(target())
    expect((await latest(client(await makeHome(), transport, false))).bundle).toEqual(legacy())
    expect(requested).toEqual([v3URL, v2URL])
  })
  it("permits only a first 404 fallback, then never downgrades after adoption", async () => {
    const home = await makeHome(), requested: string[] = [], absent: typeof fetch = async url => {
      requested.push(String(url)); return String(url) === v3URL ? new Response(null, { status: 404 }) : Response.json(mergeMigrationReleaseBundle(undefined, legacy()))
    }
    expect((await latest(client(home, absent))).bundle).toEqual(legacy())
    expect(requested).toEqual([v3URL, v2URL])
    await latest(client(home, async () => Response.json(mergeTargetReleaseBundle(undefined, target()))))
    requested.length = 0
    await expect(latest(client(home, absent))).rejects.toThrow()
    expect(requested).toEqual([v3URL])
    expect(await latest(client(home, absent), true)).toEqual({ bundle: target(), freshness: "fresh" })
  })
  it.each(["malformed", "unauthorized", "unsupported", "wrong-control"])("fails closed on %s without reading old discovery", async mode => {
    const requested: string[] = [], modified = mode === "wrong-control" ? { ...target(), updateControlProtocol: "other" } : target()
    const transport: typeof fetch = async url => {
      requested.push(String(url))
      return mode === "unauthorized" ? new Response(null, { status: 401 }) : Response.json(mode === "malformed" ? {} :
        mode === "unsupported" ? { ...mergeTargetReleaseBundle(undefined, target()), routes: [], bundles: [] } : mergeTargetReleaseBundle(undefined, modified))
    }
    await expect(latest(client(await makeHome(), transport))).rejects.toThrow()
    expect(requested).toEqual([v3URL])
  })
  it("binds exact repair and acquisition to the discovered v3 receipt and SHA512 bytes", async () => {
    const home = await makeHome(), value = target(), transport: typeof fetch = async url =>
      String(url).endsWith(".tgz") ? new Response(bytes) : Response.json(mergeTargetReleaseBundle(undefined, value))
    const instance = client(home, transport)
    await expect(instance.acquireArtifact(value, "@atape/cli", signal())).rejects.toThrow("previously discovered")
    await latest(instance)
    const offline = client(home, async () => { throw new Error("offline") })
    expect(managedReleaseBundleFingerprint(await offline.exact({ version: value.version, signal: signal() })))
      .toBe(managedReleaseBundleFingerprint(value))
    const acquired = await instance.acquireArtifact(value, "@atape/cli", signal())
    try { expect(await readFile(acquired.path)).toEqual(bytes) } finally { await acquired.release() }
    await expect(client(home, async () => new Response("modified")).acquireArtifact(value, "@atape/cli", signal())).rejects.toThrow("immutable")
  })
  it("adopts an exact running v3 descriptor before any latest request and rejects corrupt saved authority", async () => {
    const home = await makeHome(), value = target("0.5.11"), requested: string[] = []
    const instance = client(home, async url => { requested.push(String(url)); return Response.json(value) })
    expect(await instance.exact({ version: value.version, signal: signal() })).toEqual(value)
    expect(requested).toEqual([releaseBundleURL(value.version, "atape.release-bundle.v3")])
    await expect(latest(client(home, async () => new Response(null, { status: 404 })))).rejects.toThrow()
    await writeFile(join(home, "cache", "release-discovery-v3", "adopted.json"), "{}")
    await expect(latest(client(home, async () => { throw new Error("must not reach network") }))).rejects.toThrow()
  })
  it("allows an initial missing running v3 descriptor to use a bridge, but never falls back after target adoption", async () => {
    const requested: string[] = [], transport: typeof fetch = async url => {
      requested.push(String(url))
      return String(url).endsWith("bundle.v3.json") ? new Response(null, { status: 404 }) : Response.json(legacy())
    }
    expect(await client(await makeHome(), transport).exact({ version: "0.5.11", signal: signal() })).toEqual(legacy())
    expect(requested).toEqual([releaseBundleURL("0.5.11", "atape.release-bundle.v3"), releaseBundleURL("0.5.11", "atape.release-bundle.v2")])
    const home = await makeHome()
    await latest(client(home, async () => Response.json(mergeTargetReleaseBundle(undefined, target()))))
    requested.length = 0
    await expect(client(home, transport).exact({ version: "0.5.11", signal: signal() })).rejects.toThrow("immutable target descriptor")
    expect(requested).toEqual([releaseBundleURL("0.5.11", "atape.release-bundle.v3")])
  })
  it("rejects same-version cross-protocol rewrites and route removal before remembering new authority", async () => {
    const home = await makeHome()
    await latest(client(home, async url => String(url) === v3URL ? new Response(null, { status: 404 }) : Response.json(mergeMigrationReleaseBundle(undefined, legacy()))))
    await expect(latest(client(home, async () => Response.json(mergeTargetReleaseBundle(undefined, target("0.5.11", Buffer.from("changed"))))))).rejects.toThrow("across")
    await expect(readFile(join(home, "cache", "release-discovery-v3", "adopted.json"))).rejects.toThrow()
    await latest(client(home, async () => Response.json(mergeTargetReleaseBundle(undefined, target()))))
    const removed = mergeTargetReleaseBundle(undefined, { ...target("0.5.13"), fromCaptureStateContracts: ["capture.v2"] })
    await expect(latest(client(home, async () => Response.json({ ...removed, revision: 2 })))).rejects.toThrow("removed")
  })
})
