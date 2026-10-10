import assert from "node:assert/strict"
import { mkdir, readFile, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const outputDirectory = fileURLToPath(new URL("../dist", import.meta.url))
const outputFile = fileURLToPath(new URL("../dist/index.js", import.meta.url))
await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })
await build({ absWorkingDir: packageRoot, entryPoints: ["src/runtime.ts"], outfile: outputFile,
  bundle: true, platform: "node", format: "esm", target: "node24", legalComments: "eof", logLevel: "info" })
assert.match(await readFile(outputFile, "utf8"), /createAtapeAdapter/, "The Adapter bundle must export its factory.")
