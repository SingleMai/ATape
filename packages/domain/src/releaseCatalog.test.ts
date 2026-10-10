import { describe, expect, it } from "vitest"
import { decodeReleaseBundle, decodeReleaseCatalog, mergeReleaseBundle, releaseBundleFingerprint, releaseBundleFromBody,
  releaseBundleSection, releasePackageNames, selectReleaseBundle, type ReleaseBundle } from "./releaseCatalog.ts"

const bundle = (version = "1.2.3", contract = "capture.v2", control = "control.v1"): ReleaseBundle => ({
  protocol: "atape.release-bundle.v1", version, captureStateContract: contract, updateControlProtocol: control,
  packages: releasePackageNames.map(name => ({ name, integrity: `sha512-${"A".repeat(86)}==`,
    tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${version}.tgz` }))
})
const extraPackage = (name = "@atape/adapter-future", version = "1.2.3") => ({ name,
  integrity: `sha512-${"A".repeat(86)}==`,
  tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${version}.tgz` })
const extendedBundle = (): ReleaseBundle => ({ ...bundle(), packages: [...bundle().packages, extraPackage()] })

describe("immutable complete release bundles", () => {
  it("decodes the current producer packages with canonical SHA-512 and npm URLs", () => {
    expect(decodeReleaseBundle(bundle())).toEqual(bundle())
    for (const version of ["0.0.0", "9007199254740991.0.0"]) expect(decodeReleaseBundle(bundle(version)).version).toBe(version)
  })

  it.each(["latest", "01.2.3", "1.2.3-beta", "1.2.3+build", "9007199254740992.0.0", "../1.2.3"])("rejects unstable version %s", version => {
    expect(() => decodeReleaseBundle(bundle(version))).toThrow()
  })

  it("accepts bounded additive packages while retaining the original seven-package reader floor", () => {
    const original = { ...bundle(), packages: bundle().packages.filter(item => item.name !== "@atape/adapter-cursor") }
    expect(original.packages).toHaveLength(7)
    expect(decodeReleaseBundle(original)).toEqual(original)
    const value = extendedBundle()
    expect(decodeReleaseBundle(value)).toEqual(value)
    const maximum = { ...bundle(), packages: [...bundle().packages,
      ...Array.from({ length: 32 - bundle().packages.length }, (_, index) => extraPackage(`@atape/future-${index}`))] }
    expect(decodeReleaseBundle(maximum).packages).toHaveLength(32)
    expect(() => decodeReleaseBundle({ ...maximum, packages: [...maximum.packages, extraPackage()] })).toThrow()
  })

  it("rejects missing required packages and duplicate names even when additive packages fill the count", () => {
    const value = bundle(), first = value.packages[0]!
    for (const packages of [value.packages.slice(1), [...value.packages, first], value.packages.map(() => first),
      [extraPackage(), ...value.packages.slice(1)], [...value.packages, extraPackage(), extraPackage()]]) {
      expect(() => decodeReleaseBundle({ ...value, packages })).toThrow()
    }
  })

  it.each(["@other/adapter-future", "@atape/../adapter", "@atape/Adapter", "@atape/.adapter", "@atape/_adapter",
    "@atape/adapter%2ffuture", "@atape/adapter\nfuture", `@atape/${"a".repeat(122)}`])("rejects malformed additive package name %s", name => {
    expect(() => decodeReleaseBundle({ ...bundle(), packages: [...bundle().packages, extraPackage(name)] })).toThrow()
  })

  it("binds every archive URL to its official name and exact bundle version", () => {
    const value = bundle(), first = value.packages[0]!
    for (const tarball of [first.tarball.replace("1.2.3", "1.2.4"), first.tarball.replace("https:", "http:"),
      first.tarball.replace("registry.npmjs.org", "registry.example.com"), `${first.tarball}?token=secret`,
      first.tarball.replace("https://", "https://user@"), first.tarball.replace("@atape", "%40atape")]) {
      expect(() => decodeReleaseBundle({ ...value, packages: [{ ...first, tarball }, ...value.packages.slice(1)] })).toThrow()
    }
    const extra = extraPackage()
    expect(() => decodeReleaseBundle({ ...value, packages: [...value.packages, { ...extra,
      tarball: extra.tarball.replace("1.2.3", "1.2.4") }] })).toThrow()
  })

  it("rejects noncanonical integrity and unknown protocol fields", () => {
    const value = bundle(), first = value.packages[0]!
    for (const integrity of ["sha256-aaa", `sha512-${"A".repeat(85)}B==`, `sha512-${"A".repeat(86)}`, "sha512-"])
      expect(() => decodeReleaseBundle({ ...value, packages: [{ ...first, integrity }, ...value.packages.slice(1)] })).toThrow()
    expect(() => decodeReleaseBundle({ ...value, protocol: "unknown" })).toThrow()
    expect(() => decodeReleaseBundle({ ...value, captureStateContract: "capture\nv2" })).toThrow()
    expect(() => decodeReleaseBundle({ ...value, extra: true })).toThrow()
  })

  it("canonicalizes all immutable bundle fields independently of package order", () => {
    const value = bundle()
    expect(releaseBundleFingerprint({ ...value, packages: [...value.packages].reverse() })).toBe(releaseBundleFingerprint(value))
    expect(releaseBundleFingerprint(bundle("1.2.4"))).not.toBe(releaseBundleFingerprint(value))
    expect(releaseBundleFingerprint({ ...value, packages: value.packages.map(item => ({ ...item, integrity: `sha512-${"B".repeat(85)}A==` })) }))
      .not.toBe(releaseBundleFingerprint(value))
    const extended = extendedBundle()
    expect(releaseBundleFingerprint({ ...extended, packages: [...extended.packages].reverse() }))
      .toBe(releaseBundleFingerprint(extended))
    expect(JSON.parse(releaseBundleFingerprint(extended)).packages.map((item: { name: string }) => item.name))
      .toEqual(extended.packages.map(item => item.name).sort())
    expect(releaseBundleFingerprint({ ...extended, packages: extended.packages.map(item => item.name === "@atape/adapter-future"
      ? { ...item, integrity: `sha512-${"B".repeat(85)}A==` } : item) })).not.toBe(releaseBundleFingerprint(extended))
  })
})

describe("persistent compatible catalog", () => {
  it("accepts additive packages in the catalog and rejects changes to their same-version immutable bytes", () => {
    const value = extendedBundle(), catalog = mergeReleaseBundle(undefined, value)
    expect(selectReleaseBundle(decodeReleaseCatalog(catalog), value)).toEqual(value)
    expect(mergeReleaseBundle(catalog, { ...value, packages: [...value.packages].reverse() })).toEqual(catalog)
    const changed = { ...value, packages: value.packages.map(item => item.name === "@atape/adapter-future"
      ? { ...item, integrity: `sha512-${"B".repeat(85)}A==` } : item) }
    expect(() => mergeReleaseBundle(catalog, changed)).toThrow("immutable")
  })

  it("selects exact opaque pairs and preserves unknown pairs", () => {
    const current = bundle(), future = bundle("2.0.0", "capture.unknown", "control.unknown")
    const catalog = mergeReleaseBundle(mergeReleaseBundle(undefined, current), future)
    expect(selectReleaseBundle(catalog, current)).toEqual(current)
    expect(selectReleaseBundle(catalog, future)).toEqual(future)
    expect(() => selectReleaseBundle(catalog, { ...current, updateControlProtocol: "other" })).toThrow()
  })

  it("advances only the selected family with a monotonic revision and idempotent reruns", () => {
    const first = mergeReleaseBundle(undefined, bundle()), second = mergeReleaseBundle(first, bundle("1.2.4"))
    expect(first.revision).toBe(1)
    expect(second.revision).toBe(2)
    expect(mergeReleaseBundle(second, bundle())).toEqual(second)
    expect(mergeReleaseBundle(second, { ...bundle("1.2.4"), packages: [...bundle("1.2.4").packages].reverse() })).toEqual(second)
    const third = mergeReleaseBundle(second, bundle("3.0.0", "future"))
    expect(third.revision).toBe(3)
    expect(selectReleaseBundle(third, bundle()).version).toBe("1.2.4")
  })

  it("refuses same-version changed bytes, duplicate families and invalid revisions", () => {
    const value = bundle(), catalog = mergeReleaseBundle(undefined, value)
    const changed = { ...value, packages: value.packages.map(item => ({ ...item, integrity: `sha512-${"B".repeat(85)}A==` })) }
    expect(() => mergeReleaseBundle(catalog, changed)).toThrow("immutable")
    expect(() => decodeReleaseCatalog({ ...catalog, bundles: [value, bundle("1.2.4")] })).toThrow()
    expect(() => decodeReleaseCatalog({ ...catalog, bundles: [value, bundle("1.2.3", "future")] })).toThrow()
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => decodeReleaseCatalog({ ...catalog, revision })).toThrow()
    expect(() => mergeReleaseBundle({ ...catalog, revision: Number.MAX_SAFE_INTEGER }, bundle("1.2.4"))).toThrow("exhausted")
  })
})

describe("versioned Release body descriptor", () => {
  it("round trips one machine section beside release notes", () => {
    const section = releaseBundleSection(bundle())
    expect(releaseBundleFingerprint(releaseBundleFromBody(`Release notes\n\n${section}\n\nMore notes`)!))
      .toBe(releaseBundleFingerprint(bundle()))
    expect(releaseBundleFromBody("Historical release notes")).toBeUndefined()
  })

  it("preserves additive packages in the immutable version descriptor", () => {
    const value = extendedBundle(), parsed = releaseBundleFromBody(releaseBundleSection(value))!
    expect(parsed.packages).toHaveLength(releasePackageNames.length + 1)
    expect(releaseBundleFingerprint(parsed)).toBe(releaseBundleFingerprint(value))
  })

  it("rejects duplicate, missing, reversed or malformed machine sections", () => {
    const section = releaseBundleSection(bundle())
    for (const body of [section + section, section.replace(":end", ":missing"), section.replace(":start", ":missing"),
      "<!-- atape.release-bundle.v1:end --><!-- atape.release-bundle.v1:start -->",
      "<!-- atape.release-bundle.v2:start -->{}<!-- atape.release-bundle.v2:end -->",
      `${section}\n<!-- atape.release-bundle.v2:start -->`,
      "<!-- atape.release-bundle.v1:start -->not json<!-- atape.release-bundle.v1:end -->"]) {
      expect(() => releaseBundleFromBody(body)).toThrow()
    }
  })
})
