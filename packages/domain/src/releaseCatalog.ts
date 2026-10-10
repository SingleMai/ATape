import { Schema } from "effect"

export const releaseBundleProtocol = "atape.release-bundle.v1"
export const updateCatalogProtocol = "atape.update-catalog.v1"
export const updateCatalogTag = "atape-update-catalog-v1"
// The v1 reader always requires this original base. Future producer packages
// must extend releasePackageNames without growing this immutable reader floor.
const requiredBundlePackages = ["@atape/cli", "@atape/adapter-codex", "@atape/adapter-claude",
  "@atape/adapter-codebuddy", "@atape/adapter-kimi", "@atape/adapter-opencode", "@atape/adapter-grok"] as const
export const releasePackageNames = [...requiredBundlePackages, "@atape/adapter-cursor"] as const

const stableVersion = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
  value.length < 40 && value.split(".").every(part => Number.isSafeInteger(Number(part)))
const StableVersion = Schema.String.check(Schema.makeFilter(stableVersion))
const OpaqueProtocol = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/))
const Integrity = Schema.String.check(Schema.isPattern(/^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/))
const PackageName = Schema.String.check(Schema.isMaxLength(128), Schema.isPattern(/^@atape\/[a-z0-9][a-z0-9._-]*$/))
const ReleasePackage = Schema.Struct({ name: PackageName, integrity: Integrity,
  tarball: Schema.String.check(Schema.isMaxLength(2_048)) })

export const ReleaseBundle = Schema.Struct({
  protocol: Schema.Literal(releaseBundleProtocol),
  version: StableVersion,
  captureStateContract: OpaqueProtocol,
  updateControlProtocol: OpaqueProtocol,
  packages: Schema.Array(ReleasePackage).check(Schema.isLengthBetween(7, 32))
}).check(Schema.makeFilter(bundle => {
  const names = new Set(bundle.packages.map(item => item.name))
  return names.size === bundle.packages.length && requiredBundlePackages.every(name => names.has(name)) && bundle.packages.every(item =>
    item.tarball === `https://registry.npmjs.org/${item.name}/-/${item.name.slice("@atape/".length)}-${bundle.version}.tgz`)
}))
export type ReleaseBundle = typeof ReleaseBundle.Type

const pair = (bundle: Pick<ReleaseBundle, "captureStateContract" | "updateControlProtocol">) =>
  JSON.stringify([bundle.captureStateContract, bundle.updateControlProtocol])

export const ReleaseCatalog = Schema.Struct({
  protocol: Schema.Literal(updateCatalogProtocol),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  bundles: Schema.Array(ReleaseBundle).check(Schema.isMaxLength(64))
}).check(Schema.makeFilter(catalog => new Set(catalog.bundles.map(pair)).size === catalog.bundles.length &&
  new Set(catalog.bundles.map(bundle => bundle.version)).size === catalog.bundles.length))
export type ReleaseCatalog = typeof ReleaseCatalog.Type

export const decodeReleaseBundle = (value: unknown): ReleaseBundle =>
  Schema.decodeUnknownSync(ReleaseBundle, { onExcessProperty: "error" })(value)
export const decodeReleaseCatalog = (value: unknown): ReleaseCatalog =>
  Schema.decodeUnknownSync(ReleaseCatalog, { onExcessProperty: "error" })(value)

// This is a canonical identity, not a cryptographic signature. Callers may hash
// it for filenames; unrelated catalog revisions never change bundle identity.
export const releaseBundleFingerprint = (value: ReleaseBundle): string => {
  const bundle = decodeReleaseBundle(value)
  return JSON.stringify({ protocol: bundle.protocol, version: bundle.version,
    captureStateContract: bundle.captureStateContract, updateControlProtocol: bundle.updateControlProtocol,
    packages: [...bundle.packages].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      .map(item => ({ name: item.name, integrity: item.integrity, tarball: item.tarball })) })
}

export const selectReleaseBundle = (value: ReleaseCatalog,
  compatibility: { readonly captureStateContract: string; readonly updateControlProtocol: string }): ReleaseBundle => {
  const catalog = decodeReleaseCatalog(value)
  const selected = catalog.bundles.find(bundle => pair(bundle) === pair(compatibility))
  if (!selected) throw new Error("The release catalog does not support this capture/control pair.")
  return selected
}

const compareVersion = (left: string, right: string) => {
  const a = left.split(".").map(Number), b = right.split(".").map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1
  return 0
}

export const mergeReleaseBundle = (previous: ReleaseCatalog | undefined, value: ReleaseBundle): ReleaseCatalog => {
  const bundle = decodeReleaseBundle(value)
  if (!previous) return decodeReleaseCatalog({ protocol: updateCatalogProtocol, revision: 1, bundles: [bundle] })
  const catalog = decodeReleaseCatalog(previous)
  const current = catalog.bundles.find(item => pair(item) === pair(bundle))
  if (current) {
    const order = compareVersion(bundle.version, current.version)
    if (order < 0) return catalog
    if (order === 0) {
      if (releaseBundleFingerprint(current) !== releaseBundleFingerprint(bundle)) throw new Error("A release version cannot change its immutable bundle.")
      return catalog
    }
  }
  if (catalog.revision === Number.MAX_SAFE_INTEGER) throw new Error("Release catalog revision exhausted.")
  return decodeReleaseCatalog({ protocol: updateCatalogProtocol, revision: catalog.revision + 1,
    bundles: [...catalog.bundles.filter(item => pair(item) !== pair(bundle)), bundle] })
}

const sectionStart = `<!-- ${releaseBundleProtocol}:start -->`
const sectionEnd = `<!-- ${releaseBundleProtocol}:end -->`
export const releaseBundleSection = (bundle: ReleaseBundle): string =>
  `${sectionStart}\n${JSON.stringify(JSON.parse(releaseBundleFingerprint(bundle)), null, 2)}\n${sectionEnd}`

export const releaseBundleFromBody = (body: string): ReleaseBundle | undefined => {
  if (/<!--\s*atape\.release-bundle\.(?!v1:(?:start|end) -->)/.test(body)) {
    throw new Error("Release body contains an unsupported or malformed bundle section.")
  }
  const starts = body.split(sectionStart), ends = body.split(sectionEnd)
  const machineMarkers = body.match(/<!--\s*atape\.release-bundle\./g)?.length ?? 0
  if (starts.length === 1 && ends.length === 1 && machineMarkers === 0) return undefined
  if (starts.length !== 2 || ends.length !== 2 || machineMarkers !== 2) throw new Error("Release body must contain one complete bundle section.")
  const start = body.indexOf(sectionStart) + sectionStart.length, end = body.indexOf(sectionEnd)
  if (end < start) throw new Error("Release bundle section is malformed.")
  return decodeReleaseBundle(JSON.parse(body.slice(start, end).trim()))
}

// Migration discovery is additive. Published strict v1 readers keep their
// original tag, body namespace, decoder and canonical bundle identity.
export const migrationReleaseBundleProtocol = "atape.release-bundle.v2"
export const migrationReleaseCatalogProtocol = "atape.update-catalog.v2"
export const migrationReleaseCatalogTag = "atape-update-catalog-v2"
export const MigrationReleaseBundle = Schema.Struct({
  protocol: Schema.Literal(migrationReleaseBundleProtocol),
  version: StableVersion,
  captureStateContract: OpaqueProtocol,
  updateControlProtocol: OpaqueProtocol,
  packages: Schema.Array(ReleasePackage).check(Schema.isLengthBetween(7, 32)),
  migration: Schema.Struct({ protocol: OpaqueProtocol, id: OpaqueProtocol,
    fromCaptureStateContracts: Schema.Array(OpaqueProtocol).check(Schema.isLengthBetween(1, 16)) })
}).check(Schema.makeFilter(bundle => {
  try {
    decodeReleaseBundle({ protocol: releaseBundleProtocol, version: bundle.version,
      captureStateContract: bundle.captureStateContract, updateControlProtocol: bundle.updateControlProtocol, packages: bundle.packages })
    return new Set(bundle.migration.fromCaptureStateContracts).size === bundle.migration.fromCaptureStateContracts.length &&
      bundle.migration.fromCaptureStateContracts.includes(bundle.captureStateContract)
  } catch { return false }
}))
export type MigrationReleaseBundle = typeof MigrationReleaseBundle.Type
export const ManagedReleaseBundle = Schema.Union([ReleaseBundle, MigrationReleaseBundle])
export type ManagedReleaseBundle = typeof ManagedReleaseBundle.Type

const MigrationReleaseRoute = Schema.Struct({ fromCaptureStateContract: OpaqueProtocol,
  updateControlProtocol: OpaqueProtocol, migrationProtocol: OpaqueProtocol, migrationId: OpaqueProtocol, version: StableVersion })
const routeKey = (route: typeof MigrationReleaseRoute.Type) => JSON.stringify([route.fromCaptureStateContract,
  route.updateControlProtocol, route.migrationProtocol, route.migrationId])
export const MigrationReleaseCatalog = Schema.Struct({
  protocol: Schema.Literal(migrationReleaseCatalogProtocol),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  bundles: Schema.Array(MigrationReleaseBundle).check(Schema.isMaxLength(64)),
  routes: Schema.Array(MigrationReleaseRoute).check(Schema.isMaxLength(256))
}).check(Schema.makeFilter(catalog => {
  if (new Set(catalog.bundles.map(bundle => bundle.version)).size !== catalog.bundles.length ||
    new Set(catalog.routes.map(routeKey)).size !== catalog.routes.length) return false
  return catalog.routes.every(route => {
    const bundle = catalog.bundles.find(item => item.version === route.version)
    return bundle !== undefined && bundle.updateControlProtocol === route.updateControlProtocol &&
      bundle.migration.protocol === route.migrationProtocol && bundle.migration.id === route.migrationId &&
      bundle.migration.fromCaptureStateContracts.includes(route.fromCaptureStateContract)
  }) && catalog.bundles.every(bundle => catalog.routes.some(route => route.version === bundle.version))
}))
export type MigrationReleaseCatalog = typeof MigrationReleaseCatalog.Type
export const decodeMigrationReleaseBundle = (value: unknown): MigrationReleaseBundle =>
  Schema.decodeUnknownSync(MigrationReleaseBundle, { onExcessProperty: "error" })(value)
export const decodeManagedReleaseBundle = (value: unknown): ManagedReleaseBundle =>
  Schema.decodeUnknownSync(ManagedReleaseBundle, { onExcessProperty: "error" })(value)
export const decodeMigrationReleaseCatalog = (value: unknown): MigrationReleaseCatalog =>
  Schema.decodeUnknownSync(MigrationReleaseCatalog, { onExcessProperty: "error" })(value)

export const migrationReleaseBundleFingerprint = (value: MigrationReleaseBundle): string => {
  const bundle = decodeMigrationReleaseBundle(value)
  const base = JSON.parse(releaseBundleFingerprint({ protocol: releaseBundleProtocol, version: bundle.version,
    captureStateContract: bundle.captureStateContract, updateControlProtocol: bundle.updateControlProtocol,
    packages: bundle.packages })) as Record<string, unknown>
  return JSON.stringify({ ...base, protocol: bundle.protocol, migration: { protocol: bundle.migration.protocol, id: bundle.migration.id,
    fromCaptureStateContracts: [...bundle.migration.fromCaptureStateContracts].sort() } })
}
export const managedReleaseBundleFingerprint = (value: ManagedReleaseBundle): string => {
  const bundle = decodeManagedReleaseBundle(value)
  return bundle.protocol === releaseBundleProtocol ? releaseBundleFingerprint(bundle) : migrationReleaseBundleFingerprint(bundle)
}

export const selectMigrationReleaseBundle = (value: MigrationReleaseCatalog, compatibility: {
  readonly captureStateContract: string; readonly updateControlProtocol: string
  readonly supportedMigrationPlans: ReadonlyArray<{ readonly protocol: string; readonly id: string }>
}): MigrationReleaseBundle => {
  const catalog = decodeMigrationReleaseCatalog(value)
  const routes = catalog.routes.filter(route => route.fromCaptureStateContract === compatibility.captureStateContract &&
    route.updateControlProtocol === compatibility.updateControlProtocol && compatibility.supportedMigrationPlans.some(plan =>
      plan.protocol === route.migrationProtocol && plan.id === route.migrationId))
  const selected = routes.sort((a, b) => compareVersion(b.version, a.version))[0]
  if (!selected) throw new Error("The migration catalog does not support this capture/control/known-plan combination.")
  return catalog.bundles.find(bundle => bundle.version === selected.version)!
}

export const mergeMigrationReleaseBundle = (previous: MigrationReleaseCatalog | undefined,
  value: MigrationReleaseBundle): MigrationReleaseCatalog => {
  const bundle = decodeMigrationReleaseBundle(value)
  const catalog = previous ? decodeMigrationReleaseCatalog(previous) :
    { protocol: migrationReleaseCatalogProtocol, revision: 0, bundles: [], routes: [] } as const
  const existing = catalog.bundles.find(item => item.version === bundle.version)
  if (existing && migrationReleaseBundleFingerprint(existing) !== migrationReleaseBundleFingerprint(bundle))
    throw new Error("A release version cannot change its immutable migration bundle.")
  const routes = [...catalog.routes]
  let changed = false
  for (const fromCaptureStateContract of bundle.migration.fromCaptureStateContracts) {
    const route = { fromCaptureStateContract, updateControlProtocol: bundle.updateControlProtocol,
      migrationProtocol: bundle.migration.protocol, migrationId: bundle.migration.id, version: bundle.version }
    const index = routes.findIndex(item => routeKey(item) === routeKey(route))
    if (index < 0) { routes.push(route); changed = true }
    else if (compareVersion(bundle.version, routes[index]!.version) > 0) { routes[index] = route; changed = true }
  }
  if (!changed) return decodeMigrationReleaseCatalog(catalog)
  if (catalog.revision === Number.MAX_SAFE_INTEGER) throw new Error("Migration catalog revision exhausted.")
  // Retain old-plan/source routes indefinitely, but do not accumulate every
  // superseded build. Historical exact descriptors and client receipts persist.
  const bundles = [...catalog.bundles.filter(item => item.version !== bundle.version), bundle]
    .filter(item => routes.some(route => route.version === item.version))
  return decodeMigrationReleaseCatalog({ protocol: migrationReleaseCatalogProtocol, revision: catalog.revision + 1, bundles, routes })
}

const migrationSectionProtocol = "atape.migration-release-bundle.v1"
const migrationSectionStart = `<!-- ${migrationSectionProtocol}:start -->`
const migrationSectionEnd = `<!-- ${migrationSectionProtocol}:end -->`
export const migrationReleaseBundleSection = (bundle: MigrationReleaseBundle): string =>
  `${migrationSectionStart}\n${JSON.stringify(JSON.parse(migrationReleaseBundleFingerprint(bundle)), null, 2)}\n${migrationSectionEnd}`
export const migrationReleaseBundleFromBody = (body: string): MigrationReleaseBundle | undefined => {
  if (/<!--\s*atape\.migration-release-bundle\.(?!v1:(?:start|end) -->)/.test(body))
    throw new Error("Release body contains an unsupported or malformed migration bundle section.")
  const starts = body.split(migrationSectionStart), ends = body.split(migrationSectionEnd)
  const markers = body.match(/<!--\s*atape\.migration-release-bundle\./g)?.length ?? 0
  if (starts.length === 1 && ends.length === 1 && markers === 0) return undefined
  if (starts.length !== 2 || ends.length !== 2 || markers !== 2) throw new Error("Release body must contain one complete migration bundle section.")
  const start = body.indexOf(migrationSectionStart) + migrationSectionStart.length, end = body.indexOf(migrationSectionEnd)
  if (end < start) throw new Error("Release migration bundle section is malformed.")
  const bundle = decodeMigrationReleaseBundle(JSON.parse(body.slice(start, end).trim()))
  const legacy = releaseBundleFromBody(body)
  if (legacy && releaseBundleFingerprint(legacy) !== releaseBundleFingerprint({ protocol: releaseBundleProtocol,
    version: bundle.version, captureStateContract: bundle.captureStateContract, updateControlProtocol: bundle.updateControlProtocol,
    packages: bundle.packages })) throw new Error("Legacy and migration release descriptors disagree.")
  return bundle
}
