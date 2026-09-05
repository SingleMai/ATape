import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { loadReleaseContract } from "./release-contract.mjs"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const imageTag = process.argv[2] ?? "candidate"
if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(imageTag)) {
  throw new Error("The release image tag must be a lowercase Docker tag component.")
}

const release = await loadReleaseContract(repositoryRoot)
const buildArguments = [
  "--build-arg", `ATAPE_RELEASE_VERSION=${release.version}`,
  "--build-arg", `ATAPE_RELEASE_EPOCH=${release.authEpoch}`,
  "--build-arg", `ATAPE_MINIMUM_CLI_VERSION=${release.minimumCliVersion}`
]

for (const artifact of ["server", "web"]) {
  await execute("docker", [
    "build",
    ...buildArguments,
    "--file", `deploy/${artifact}.Dockerfile`,
    "--tag", `atape-${artifact}:${imageTag}`,
    "."
  ])
}

process.stdout.write(
  `Built ATape Server and Web ${release.version}/${release.authEpoch} images with tag ${imageTag}.\n`
)

function execute(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} failed with ${signal === null ? `exit code ${code}` : `signal ${signal}`}.`))
    })
  })
}
