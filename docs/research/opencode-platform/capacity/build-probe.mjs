// Resolve production implementation from an explicit checkout, never a developer path.
import { createRequire } from "node:module"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
const [checkoutArg, outputArg] = process.argv.slice(2)
if (!checkoutArg || !outputArg) throw new Error("Usage: node build-probe.mjs CHECKOUT OUTSIDE_REPO_OUTPUT")
const checkout = resolve(checkoutArg), output = resolve(outputArg)
if (output === checkout || output.startsWith(checkout + "/")) throw new Error("output must be outside checkout")
const cli = join(checkout, "apps/cli"), require = createRequire(join(cli, "package.json"))
const esbuild = require("esbuild"), here = dirname(fileURLToPath(import.meta.url))
await mkdir(output, { recursive: false })
const bundleSHA256 = {}
for (const name of ["capacity"]) {
  const outfile = join(output, name + ".mjs")
  await esbuild.build({ entryPoints: [join(here, name + ".ts")], outfile, bundle: true,
    platform: "node", format: "esm", target: "node24", absWorkingDir: cli,
    nodePaths: [join(cli, "node_modules")],
    alias: {"capacity-application": join(checkout, "packages/application/src/index.ts"), "capacity-domain": join(checkout, "packages/domain/src/index.ts"), "capacity-source-capture": join(checkout, "adapters/opencode/src/capture.ts"), "capacity-source-origin": join(checkout, "adapters/opencode/src/source.ts"), "capacity-journal": join(checkout, "apps/cli/src/runtime/captureJournal.ts")} })
  bundleSHA256[name] = createHash("sha256").update(await readFile(outfile)).digest("hex")
}
await writeFile(join(output, "build-provenance.json"), JSON.stringify({
  checkoutCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim(),
  checkoutDirty: execFileSync("git", ["status", "--porcelain"], { cwd: checkout, encoding: "utf8" }).trim() !== "",
  esbuild: esbuild.version, node: process.version, bundleSHA256
}, null, 2) + "\n")
await copyFile(join(here, "native-fixture.json"), join(output, "native-fixture.json"))
console.log(output)
