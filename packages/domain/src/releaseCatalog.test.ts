import { describe, expect, it } from "vitest"
import { decodeReleaseBundle, decodeReleaseCatalog, mergeReleaseBundle, releaseBundleFingerprint, releaseBundleFromBody,
  releaseBundleSection, releasePackageNames, selectReleaseBundle, type ReleaseBundle,
  decodeMigrationReleaseBundle, decodeMigrationReleaseCatalog, decodeManagedReleaseBundle,
  managedReleaseBundleFingerprint, migrationReleaseBundleFingerprint, mergeMigrationReleaseBundle,
  selectMigrationReleaseBundle, migrationReleaseBundleSection, migrationReleaseBundleFromBody,
  type MigrationReleaseBundle } from "./releaseCatalog.ts"

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

const migrationBundle = (version = "1.2.3", sources = ["capture.v1", "capture.v2"], id = "journal-v7-to-v8",
  contract = "capture.v2", protocol = "atape.capture-migration.v1"): MigrationReleaseBundle => ({
  ...bundle(version, contract), protocol: "atape.release-bundle.v2",
  migration: { protocol, id, fromCaptureStateContracts: sources }
})
const identity = { captureStateContract: "capture.v2", updateControlProtocol: "control.v1",
  supportedMigrationPlans: [{ protocol: "atape.capture-migration.v1", id: "journal-v7-to-v8" }] }

describe("explicit migration release bundles", () => {
  it("keeps the original seven-package migration reader floor when producers add Cursor", () => {
    const current = migrationBundle(), original = { ...current,
      packages: current.packages.filter(item => item.name !== "@atape/adapter-cursor") }
    expect(original.packages).toHaveLength(7)
    expect(current.packages).toHaveLength(8)
    expect(decodeMigrationReleaseBundle(original)).toEqual(original)
    const old = mergeMigrationReleaseBundle(undefined, original)
    expect(() => mergeMigrationReleaseBundle(old, current)).toThrow("immutable")
    const next = mergeMigrationReleaseBundle(old, migrationBundle("1.2.4", ["capture.v2"]))
    expect(selectMigrationReleaseBundle(next, { ...identity, captureStateContract: "capture.v1" })).toEqual(original)
    expect(selectMigrationReleaseBundle(next, identity).packages).toHaveLength(8)
  })

  it("preserves strict v1 and its exact canonical identity", () => {
    expect(decodeManagedReleaseBundle(bundle())).toEqual(bundle())
    expect(managedReleaseBundleFingerprint(bundle())).toBe(releaseBundleFingerprint(bundle()))
    expect(() => decodeReleaseBundle(migrationBundle())).toThrow()
    expect(() => decodeReleaseCatalog(mergeMigrationReleaseBundle(undefined, migrationBundle()))).toThrow()
  })

  it("decodes opaque unknown plans while rejecting malformed and inferred source permission", () => {
    expect(decodeMigrationReleaseBundle(migrationBundle("1.2.3", ["capture.unknown"], "unknown", "capture.unknown", "unknown")))
      .toEqual(migrationBundle("1.2.3", ["capture.unknown"], "unknown", "capture.unknown", "unknown"))
    for (const migration of [undefined, { ...migrationBundle().migration, fromCaptureStateContracts: [] },
      { ...migrationBundle().migration, fromCaptureStateContracts: ["capture.v1"] },
      { ...migrationBundle().migration, fromCaptureStateContracts: ["capture.v2", "capture.v2"] },
      { ...migrationBundle().migration, protocol: "bad\nprotocol" }, { ...migrationBundle().migration, executable: "run" }])
      expect(() => decodeMigrationReleaseBundle({ ...migrationBundle(), migration })).toThrow()
    expect(() => decodeMigrationReleaseBundle({ ...migrationBundle(), packages: bundle().packages.slice(1) })).toThrow()
  })

  it("binds the full plan and additive package bytes independently of list order", () => {
    const value = migrationBundle()
    expect(migrationReleaseBundleFingerprint({ ...value, packages: [...value.packages].reverse(),
      migration: { ...value.migration, fromCaptureStateContracts: [...value.migration.fromCaptureStateContracts].reverse() } }))
      .toBe(migrationReleaseBundleFingerprint(value))
    for (const changed of [migrationBundle("1.2.3", ["capture.v2"]), migrationBundle("1.2.3", undefined, "next-plan"),
      migrationBundle("1.2.3", undefined, undefined, undefined, "next-protocol"),
      { ...value, packages: [...value.packages, extraPackage()] }])
      expect(managedReleaseBundleFingerprint(changed)).not.toBe(managedReleaseBundleFingerprint(value))
  })
})

describe("persistent migration routes", () => {
  it("advances a subset of sources while retaining an offline old-source path", () => {
    const first = mergeMigrationReleaseBundle(undefined, migrationBundle())
    const second = mergeMigrationReleaseBundle(first, migrationBundle("1.2.4", ["capture.v2"]))
    expect(selectMigrationReleaseBundle(second, identity).version).toBe("1.2.4")
    expect(selectMigrationReleaseBundle(second, { ...identity, captureStateContract: "capture.v1" }).version).toBe("1.2.3")
    expect(second.bundles).toHaveLength(2)
    expect(mergeMigrationReleaseBundle(second, migrationBundle())).toEqual(second)
  })

  it("retains a capability bridge when a future plan is unknown to an offline reader", () => {
    const old = mergeMigrationReleaseBundle(undefined, migrationBundle())
    const next = mergeMigrationReleaseBundle(old, migrationBundle("2.0.0", ["capture.v2", "capture.v3"], "next-plan", "capture.v3"))
    expect(selectMigrationReleaseBundle(next, identity).version).toBe("1.2.3")
    expect(selectMigrationReleaseBundle(next, { ...identity, supportedMigrationPlans: [...identity.supportedMigrationPlans,
      { protocol: "atape.capture-migration.v1", id: "next-plan" }] }).version).toBe("2.0.0")
    expect(() => selectMigrationReleaseBundle(next, { ...identity, supportedMigrationPlans: [] })).toThrow("known-plan")
    const unknownProtocol = mergeMigrationReleaseBundle(next,
      migrationBundle("3.0.0", ["capture.v2", "capture.v3"], "next-plan", "capture.v3", "future.protocol"))
    expect(selectMigrationReleaseBundle(unknownProtocol, identity).version).toBe("1.2.3")
  })

  it("does not accumulate unreferenced superseded builds and keeps monotonic reruns", () => {
    let catalog = mergeMigrationReleaseBundle(undefined, migrationBundle())
    for (let index = 4; index < 80; index++) catalog = mergeMigrationReleaseBundle(catalog, migrationBundle(`1.2.${index}`))
    expect(catalog.bundles).toHaveLength(1)
    expect(catalog.routes).toHaveLength(2)
    expect(catalog.revision).toBe(77)
    expect(mergeMigrationReleaseBundle(catalog, migrationBundle("1.2.79"))).toEqual(catalog)
    expect(mergeMigrationReleaseBundle(catalog, migrationBundle())).toEqual(catalog)
  })

  it("rejects immutable changes, ambiguous or dangling routes, invalid revisions and excess metadata", () => {
    const catalog = mergeMigrationReleaseBundle(undefined, migrationBundle()), route = catalog.routes[0]!
    expect(() => mergeMigrationReleaseBundle(catalog, migrationBundle("1.2.3", ["capture.v2"]))).toThrow("immutable")
    for (const changed of [{ ...catalog, bundles: [...catalog.bundles, catalog.bundles[0]] },
      { ...catalog, routes: [...catalog.routes, route] }, { ...catalog, routes: [{ ...route, version: "9.0.0" }] },
      { ...catalog, routes: [{ ...route, migrationProtocol: "other" }] },
      { ...catalog, routes: [{ ...route, fromCaptureStateContract: "unreadable" }] },
      { ...catalog, routes: [] }, { ...catalog, revision: 0 }, { ...catalog, execute: "remote-command" }])
      expect(() => decodeMigrationReleaseCatalog(changed)).toThrow()
    expect(() => mergeMigrationReleaseBundle({ ...catalog, revision: Number.MAX_SAFE_INTEGER }, migrationBundle("1.2.4")))
      .toThrow("exhausted")
  })
})

describe("independent migration descriptor namespace", () => {
  it("lets strict historical v1 readers consume a dual-descriptor actual bridge", () => {
    const legacy = bundle(), migration = migrationBundle()
    const body = `Notes\n${releaseBundleSection(legacy)}\n${migrationReleaseBundleSection(migration)}`
    expect(releaseBundleFingerprint(releaseBundleFromBody(body)!)).toBe(releaseBundleFingerprint(legacy))
    expect(migrationReleaseBundleFingerprint(migrationReleaseBundleFromBody(body)!)).toBe(migrationReleaseBundleFingerprint(migration))
    expect(migrationReleaseBundleFromBody("Historical notes")).toBeUndefined()
    expect(migrationReleaseBundleFingerprint(migrationReleaseBundleFromBody(migrationReleaseBundleSection(migration))!))
      .toBe(migrationReleaseBundleFingerprint(migration))
  })

  it("rejects disagreeing shared identity and malformed migration sections", () => {
    const section = migrationReleaseBundleSection(migrationBundle())
    for (const body of [section + section, section.replace(":end", ":missing"), section.replace(":start", ":missing"),
      "<!-- atape.migration-release-bundle.v1:end --><!-- atape.migration-release-bundle.v1:start -->",
      `${section}\n<!-- atape.migration-release-bundle.v2:start -->`,
      `${releaseBundleSection(bundle("1.2.4"))}\n${section}`,
      "<!-- atape.migration-release-bundle.v1:start -->bad json<!-- atape.migration-release-bundle.v1:end -->"])
      expect(() => migrationReleaseBundleFromBody(body)).toThrow()
  })
})
