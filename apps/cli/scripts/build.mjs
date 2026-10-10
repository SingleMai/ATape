import assert from "node:assert/strict"
import { chmod, mkdir, readFile, rm } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))
const outputDirectory = fileURLToPath(new URL("../dist", import.meta.url))
const outputFile = fileURLToPath(new URL("../dist/atape.js", import.meta.url))
const packageManifest = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"))
assert.equal(packageManifest.atapeRuntime?.protocol, "atape.runtime.v1")
assert.ok(typeof packageManifest.atapeRuntime.stateContract === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(packageManifest.atapeRuntime.stateContract),
"The CLI must declare its compiled capture-state contract.")

await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })
await build({
  absWorkingDir: packageRoot,
  entryPoints: ["src/entry.ts"],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  define: { __ATAPE_CLI_VERSION__: JSON.stringify(packageManifest.version),
    __ATAPE_CAPTURE_STATE_CONTRACT__: JSON.stringify(packageManifest.atapeRuntime.stateContract),
    "process.env.NODE_ENV": '"production"' },
  banner: { js: 'import { createRequire as __atapeCreateRequire } from "node:module"; const require = __atapeCreateRequire(import.meta.url);' },
  plugins: [{
    name: "ink-release-without-devtools",
    setup(build) {
      build.onResolve({ filter: /^\.\/devtools\.js$/ }, args =>
        /[/\\]ink[/\\]build[/\\]reconciler\.js$/.test(args.importer)
          ? { path: "ink-release-devtools", namespace: "atape-release" } : undefined)
      build.onLoad({ filter: /.*/, namespace: "atape-release" }, () => ({ contents: "export {};", loader: "js" }))
    }
  }],
  legalComments: "eof",
  logLevel: "info"
})

const output = await readFile(outputFile, "utf8")
assert.ok(output.startsWith("#!/usr/bin/env node\n"), "The distributable CLI must retain its Node shebang.")
await chmod(outputFile, 0o755)
