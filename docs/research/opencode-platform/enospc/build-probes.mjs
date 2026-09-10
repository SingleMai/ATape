// Resolve production implementation from an explicit checkout, never a developer path.
import { createRequire } from "node:module"
import { resolve, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
const [checkoutArg, outputArg] = process.argv.slice(2)
if (!checkoutArg || !outputArg) throw new Error("Usage: node build-probes.mjs CHECKOUT OUTSIDE_REPO_OUTPUT")
const checkout = resolve(checkoutArg), output = resolve(outputArg)
if (output === checkout || output.startsWith(checkout + "/")) throw new Error("output must be outside checkout")
const cli = join(checkout, "apps/cli"), require = createRequire(join(cli, "package.json"))
const esbuild = require("esbuild"), here = dirname(fileURLToPath(import.meta.url))
await mkdir(output, { recursive: false })
const bundleSHA256 = {}
for (const name of ["prototype", "max-pages"]) {
  const outfile = join(output, name + ".mjs")
  await esbuild.build({ entryPoints: [join(here, name + ".ts")], outfile, bundle: true,
    platform: "node", format: "esm", target: "node24", absWorkingDir: cli,
    nodePaths: [join(cli, "node_modules")],
    alias: { "atape-journal-probe-source": join(cli, "src/runtime/captureJournal.ts") } })
  bundleSHA256[name] = createHash("sha256").update(await readFile(outfile)).digest("hex")
}
await writeFile(join(output, "build-provenance.json"), JSON.stringify({
  checkoutCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim(),
  checkoutDirty: execFileSync("git", ["status", "--porcelain"], { cwd: checkout, encoding: "utf8" }).trim() !== "",
  esbuild: esbuild.version, node: process.version, bundleSHA256
}, null, 2) + "\n")
console.log(output)
