import { readFile } from "node:fs/promises"
import { join } from "node:path"

const Registry = "https://registry.npmjs.org/"
const Repository = "git+https://github.com/SingleMai/ATape.git"
const PackageDefinitions = [
  { path: "apps/cli/package.json", name: "@atape/cli", directory: "apps/cli" },
  { path: "adapters/codex/package.json", name: "@atape/adapter-codex", directory: "adapters/codex" }
]

export const loadReleaseContract = async (repositoryRoot) => {
  const root = await readManifest(repositoryRoot, "package.json")
  requireValue(root.private === true, "The workspace root must remain private.")
  requireValue(root.license === "MIT", "The workspace root must use the MIT license.")
  requireVersion(root.version, "workspace root")

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
    releaseDirectory: join(repositoryRoot, "release"),
    packages
  }
}

export const archiveName = (name, version) =>
  `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`

const readManifest = async (repositoryRoot, relativePath) =>
  JSON.parse(await readFile(join(repositoryRoot, relativePath), "utf8"))

const requireVersion = (value, label) => {
  requireValue(typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value),
    `The ${label} version must be an explicit SemVer value.`)
}

const requireValue = (condition, message) => {
  if (!condition) throw new Error(message)
}
