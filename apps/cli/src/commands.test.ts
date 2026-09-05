import { execFile } from "node:child_process"
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

const exec = promisify(execFile)
const temporaryDirectories: Array<string> = []
const cli = fileURLToPath(new URL("./main.ts", import.meta.url))

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("atape CLI", () => {
  it("reports a development version when run from TypeScript source", async () => {
    const result = await exec(process.execPath, [cli, "--version"])
    expect(result.stdout.trim()).toBe("ATape development")
  })

  it("completes non-interactive Project setup and listing", async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-cli-command-"))
    temporaryDirectories.push(root)
    const project = join(root, "support-notes")
    await mkdir(project)
    const canonicalProject = await realpath(project)
    const environment = {
      ...process.env,
      ATAPE_CONFIG_FILE: join(root, "config", "config.json"),
      ATAPE_COLLECTOR_STATE_FILE: join(root, "state", "collector.json"),
      ATAPE_ADAPTER_DIRECTORY: join(root, "data", "adapters")
    }

    const setup = await exec(process.execPath, [
      cli, "setup", project, "--team-id", "acme", "--team-name", "Acme Engineering",
      "--user-id", "liying", "--type", "directory", "--json"
    ], { env: environment })
    const listed = await exec(process.execPath, [cli, "projects", "list", "--json"], { env: environment })
    const collected = await exec(process.execPath, [cli, "collect", "--once", "--json"], { env: environment })

    expect(JSON.parse(setup.stdout)).toMatchObject({
      created: true,
      userId: "liying",
      project: { id: "support-notes", type: "directory", path: canonicalProject }
    })
    expect(JSON.parse(listed.stdout)).toMatchObject({
      projects: [{ id: "support-notes", teamId: "acme" }]
    })
    expect(JSON.parse(collected.stdout)).toMatchObject({ jobs: [], failures: [] })
  })
})
