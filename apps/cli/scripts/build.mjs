import assert from "node:assert/strict"
import { chmod, mkdir, readFile, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const outputDirectory = fileURLToPath(new URL("../dist", import.meta.url))
const outputFile = fileURLToPath(new URL("../dist/atape.js", import.meta.url))
const packageManifest = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"))

await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })
await build({
  absWorkingDir: packageRoot,
  entryPoints: ["src/main.ts"],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  define: { __ATAPE_CLI_VERSION__: JSON.stringify(packageManifest.version) },
  legalComments: "eof",
  logLevel: "info"
})

const output = await readFile(outputFile, "utf8")
assert.ok(output.startsWith("#!/usr/bin/env node\n"), "The distributable CLI must retain its Node shebang.")
await chmod(outputFile, 0o755)
