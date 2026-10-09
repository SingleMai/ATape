import { Schema } from "effect"

export const releaseBundleProtocol = "atape.release-bundle.v1"
export const updateCatalogProtocol = "atape.update-catalog.v1"
export const updateCatalogTag = "atape-update-catalog-v1"
// The v1 reader always requires this original base. Future producer packages
// must extend releasePackageNames without growing this immutable reader floor.
const requiredBundlePackages = ["@atape/cli", "@atape/adapter-codex", "@atape/adapter-claude",
  "@atape/adapter-codebuddy", "@atape/adapter-kimi", "@atape/adapter-opencode", "@atape/adapter-grok"] as const
export const releasePackageNames = [...requiredBundlePackages] as const

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
