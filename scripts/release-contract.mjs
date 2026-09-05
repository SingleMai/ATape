import { readFile } from "node:fs/promises"
import { join } from "node:path"

const Registry = "https://registry.npmjs.org/"
const Repository = "git+https://github.com/SingleMai/ATape.git"
const PackageDefinitions = [
  { path: "apps/cli/package.json", name: "@atape/cli", directory: "apps/cli" },
  { path: "adapters/codex/package.json", name: "@atape/adapter-codex", directory: "adapters/codex" }
]

export const loadReleaseContract = async (repositoryRoot) => {
  const identity = await readReleaseIdentity(repositoryRoot)
  const root = await readManifest(repositoryRoot, "package.json")
  requireValue(root.private === true, "The workspace root must remain private.")
  requireValue(root.license === "MIT", "The workspace root must use the MIT license.")
  requireVersion(root.version, "workspace root")
  requireValue(root.version === identity.releaseVersion,
    `The workspace version must match ${identity.releaseVersion} from specs/auth-v1-release.json.`)
  requireValue(root.scripts?.["build:release:images"] === "node scripts/build-release-images.mjs",
    "The workspace must expose the canonical release image builder.")

  const web = await readManifest(repositoryRoot, "apps/web/package.json")
  requireValue(web.name === "@atape/web" && web.private === true, "apps/web must remain the private @atape/web artifact.")
  requireValue(web.version === identity.releaseVersion, `@atape/web must use release version ${identity.releaseVersion}.`)

  const packages = []
  for (const definition of PackageDefinitions) {
    const manifest = await readManifest(repositoryRoot, definition.path)
    requireValue(manifest.name === definition.name, `${definition.path} must keep the public package name ${definition.name}.`)
    requireValue(manifest.version === root.version, `${definition.name} must use release version ${root.version}.`)
    requireValue(manifest.private !== true, `${definition.name} must not be marked private.`)
    requireValue(manifest.license === "MIT", `${definition.name} must use the MIT license.`)
    requireValue(manifest.repository?.url === Repository, `${definition.name} repository.url must match ${Repository}.`)
    requireValue(manifest.repository?.directory === definition.directory,
      `${definition.name} repository.directory must be ${definition.directory}.`)
    requireValue(manifest.publishConfig?.access === "public", `${definition.name} must publish with public access.`)
    requireValue(manifest.publishConfig?.registry === Registry, `${definition.name} must publish only to ${Registry}.`)
    packages.push({
      name: definition.name,
      version: root.version,
      directory: definition.directory,
      artifactName: archiveName(definition.name, root.version)
    })
  }

  return {
    version: root.version,
    tag: `v${root.version}`,
    authEpoch: identity.authEpoch,
    minimumCliVersion: identity.minimumCliVersion,
    releaseDirectory: join(repositoryRoot, "release"),
    packages
  }
}

export const archiveName = (name, version) =>
  `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`

const readManifest = async (repositoryRoot, relativePath) =>
  JSON.parse(await readFile(join(repositoryRoot, relativePath), "utf8"))

const readReleaseIdentity = async (repositoryRoot) => {
  const path = join(repositoryRoot, "specs/auth-v1-release.json")
  const identity = JSON.parse(await readFile(path, "utf8"))
  requireExactKeys(identity, ["protocol", "releaseVersion", "authEpoch", "minimumCliVersion"], path)
  requireValue(identity.protocol === "atape.auth-release.v1", `${path} has an unsupported protocol.`)
  requireVersion(identity.releaseVersion, "auth release")
  requireVersion(identity.minimumCliVersion, "minimum CLI")
  requireValue(identity.authEpoch === "auth-v1", `${path} must identify the auth-v1 epoch.`)
  requireValue(identity.minimumCliVersion === identity.releaseVersion,
    "The first authenticated release must require its matching CLI version.")

  const matrix = JSON.parse(await readFile(join(repositoryRoot, "specs/auth-v1-authorization-matrix.json"), "utf8"))
  requireValue(matrix.authEpoch === identity.authEpoch,
    "The authorization matrix and release identity must use the same auth epoch.")

  const releaseSource = await readFile(join(repositoryRoot, "server/internal/releaseinfo/release.go"), "utf8")
  for (const [name, value] of [
    ["Version", identity.releaseVersion],
    ["AuthEpoch", identity.authEpoch],
    ["MinimumCLIVersion", identity.minimumCliVersion]
  ]) {
    requireValue(new RegExp(`\\b${name}\\s*=\\s*"${escapeRegExp(value)}"`).test(releaseSource),
      `The Server ${name} must match specs/auth-v1-release.json.`)
  }

  const artifactContracts = [
    ["deploy/server.Dockerfile", [
      `ARG ATAPE_RELEASE_VERSION=${identity.releaseVersion}`,
      `ARG ATAPE_RELEASE_EPOCH=${identity.authEpoch}`,
      `ARG ATAPE_MINIMUM_CLI_VERSION=${identity.minimumCliVersion}`,
      "releaseinfo.Version=${ATAPE_RELEASE_VERSION}",
      "releaseinfo.AuthEpoch=${ATAPE_RELEASE_EPOCH}",
      "releaseinfo.MinimumCLIVersion=${ATAPE_MINIMUM_CLI_VERSION}"
    ]],
    ["deploy/web.Dockerfile", [
      `ARG ATAPE_RELEASE_VERSION=${identity.releaseVersion}`,
      `ARG ATAPE_RELEASE_EPOCH=${identity.authEpoch}`,
      `ARG ATAPE_MINIMUM_CLI_VERSION=${identity.minimumCliVersion}`
    ]],
    ["compose.yaml", [
      `ATAPE_RELEASE_VERSION: ${identity.releaseVersion}`,
      `ATAPE_RELEASE_EPOCH: ${identity.authEpoch}`,
      `ATAPE_MINIMUM_CLI_VERSION: ${identity.minimumCliVersion}`
    ]],
    ["docs/api/openapi-v1.yaml", [
      `auth_epoch: {type: string, const: ${identity.authEpoch}}`
    ]],
    [".github/workflows/security.yml", [
      "pnpm build:release:images security"
    ]],
    [".github/workflows/release.yml", [
      "pnpm build:release:images release"
    ]]
  ]
  for (const [relativePath, markers] of artifactContracts) {
    const content = await readFile(join(repositoryRoot, relativePath), "utf8")
    for (const marker of markers) {
      requireValue(content.includes(marker), `${relativePath} must carry release marker ${marker}.`)
    }
  }
  return identity
}

const requireVersion = (value, label) => {
  requireValue(typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value),
    `The ${label} version must be an explicit SemVer value.`)
}

const requireExactKeys = (value, expected, label) => {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`)
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  requireValue(keys.length === wanted.length && keys.every((key, index) => key === wanted[index]),
    `${label} must contain exactly: ${wanted.join(", ")}.`)
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const requireValue = (condition, message) => {
  if (!condition) throw new Error(message)
}
