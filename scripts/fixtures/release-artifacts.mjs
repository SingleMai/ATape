import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { releaseBundleProtocol, migrationReleaseBundleProtocol, targetReleaseBundleProtocol,
  releasePackageNames, updateTargetProtocol } from "../../packages/domain/src/releaseCatalog.ts"

const digest = bytes => createHash("sha256").update(bytes).digest("hex")
const capture = "atape.client.v3-capture.v2", control = "atape.update-control.v1"

// Deterministic real npm-shaped tar archives keep publication callers exercising
// the same packed-manifest boundary as production, without invoking npm.
export function manifestTarball(manifest) {
  const bytes = Buffer.from(JSON.stringify(manifest)), header = Buffer.alloc(512)
  header.write("package/package.json")
  for (const [offset, size, number] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, bytes.length], [136, 12, 0]])
    header.write(`${number.toString(8).padStart(size - 1, "0")}\0`, offset)
  header.fill(32, 148, 156); header.write("0", 156); header.write("ustar\0", 257); header.write("00", 263)
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148)
  return gzipSync(Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512 + 1024)]))
}

export function releaseArtifacts(version = "0.5.6", { channel = "legacy-bridge", migration, target = channel === "target-owned",
  from = ["atape.client.v3-capture.v1", capture], manifestChange = value => value } = {}) {
  const runtime = { protocol: "atape.runtime.v1", releaseChannel: channel, stateContract: capture,
    updateControlProtocol: control, releaseCatalogProtocol: "atape.update-catalog.v1",
    ...(migration ? { migrationReleaseCatalogProtocol: "atape.update-catalog.v2", captureMigrationProtocol: "atape.capture-migration.v1",
      updateWakeProtocol: "atape.update-wake.v1", captureMigration: migration } : {}),
    ...(target ? { updateTargetProtocol, targetReleaseCatalogProtocol: "atape.update-catalog.v3", fromCaptureStateContracts: from } : {}) }
  const files = releasePackageNames.map(name => {
    const manifest = manifestChange({ name, version,
      ...(name === "@atape/cli" ? { atapeRuntime: runtime } : {}),
      ...(name === "@atape/adapter-codex" ? { atapeAdapter: { adapterId: "codex",
        legacyCanonicalProfile: channel === "legacy-bridge" ? "atape.acp-centered.v3" : "atape.acp-centered.v5" } } : {}),
      ...(name === "@atape/adapter-claude" ? { atapeAdapter: { adapterId: "claude", sourceCapture: "atape.source-capture.v2",
        publicationTargetProfile: channel === "legacy-bridge" ? "atape.publication-target.v4" : "atape.publication-target.v5" } } : {}) })
    const bytes = manifestTarball(manifest)
    return { name, filename: `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`, path: "/unused/source.tgz", bytes,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, sha256: digest(bytes), manifest }
  })
  const common = { version, captureStateContract: capture, updateControlProtocol: control,
    packages: files.map(file => ({ name: file.name, integrity: file.integrity,
      tarball: `https://registry.npmjs.org/${file.name}/-/${file.name.slice("@atape/".length)}-${version}.tgz` })) }
  const targetBundle = { ...common, protocol: targetReleaseBundleProtocol, updateTargetProtocol, fromCaptureStateContracts: from }
  const bundle = channel === "target-owned" ? targetBundle : { ...common,
    protocol: migration ? migrationReleaseBundleProtocol : releaseBundleProtocol, ...(migration ? { migration } : {}) }
  const checksums = Buffer.from([...files].sort((a, b) => a.filename < b.filename ? -1 : 1)
    .map(file => `${file.sha256}  ${file.filename}\n`).join(""))
  return { releaseChannel: channel, bundle, ...(channel === "legacy-bridge" && target ? { targetBundle } : {}),
    files: [...files, { filename: "SHA256SUMS", bytes: checksums, sha256: digest(checksums) }] }
}
