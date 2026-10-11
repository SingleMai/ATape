import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const revision = "9b4db957a768b6a7a80ae9f3873a54fe3ea94002"
const tag = "v0.5.8"
const repository = fileURLToPath(new URL("../../../../..", import.meta.url))
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
type HistoricalModules = Pick<typeof import("@atape/application"), "CaptureJournals" | "CaptureJournal" | "CollectorStateStore" |
  "SourceCaptureCollector" | "makeSourceCaptureCollectorLayer" | "PublicationTransport" | "PublicationError" | "RawPublicationTransport" |
  "RawPublicationError" | "makeSecretRedactorLayer" | "SecretRedactor" | "defaultSourceCollectionLimits"> & {
  readonly Effect: typeof import("effect").Effect
  readonly Layer: typeof import("effect").Layer
  readonly makeCaptureJournalsLayer: typeof import("../captureBootstrap.ts").makeCaptureJournalsLayer
  readonly makeCollectorStateLayer: typeof import("../collectorState.ts").makeCollectorStateLayer
}

/** Untouched published 0.5.8 SourceCollector and Node persistence, with its own
 * frozen lock and Effect runtime. The wrapper exports caller Interfaces only. */
export const sourceCollectorV058 = async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "atape-source-collector-v058-")))
  const execute = promisify(execFile)
  const git = async (args: string[]) => (await execute("git", args, {
    cwd: repository, encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 30_000
  })).stdout
  try {
    await git(["cat-file", "-e", `${revision}^{commit}`])
    if ((await git(["rev-parse", `${tag}^{commit}`])).toString("utf8").trim() !== revision)
      throw new Error("The genuine SourceCollector tag does not identify the published 0.5.8 commit.")
    const show = (path: string) => git(["show", `${revision}:${path}`])
    const tree = (await git(["ls-tree", "-r", "--name-only", revision])).toString("utf8").trim().split("\n")
    const manifests = tree.filter(path => /^(?:apps|adapters|packages)\/[^/]+\/package\.json$/.test(path))
    const sources = tree.filter(path => /^(?:apps\/cli\/src|packages\/(?:application|domain|adapter-catalog|i18n)\/src)\//.test(path) &&
      /\.(?:ts|json)$/.test(path) && !path.endsWith(".test.ts") && !path.includes("/fixtures/") && !path.endsWith(".e2e.test.ts"))
    const paths = [...new Set(["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", ...manifests, ...sources])]
    const inputs: Array<{ readonly path: string; readonly bytes: number; readonly sha256: string }> = []
    for (const path of paths) {
      const bytes = await show(path), target = join(directory, path)
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
      inputs.push({ path, bytes: bytes.length, sha256: digest(bytes) })
    }
    const index = await readFile(join(directory, "packages/application/src/index.ts"), "utf8")
    if (!index.includes('export * from "./sourceCollector.ts"') || !index.includes('export * from "./captureJournal.ts"'))
      throw new Error("The historical SourceCollector and journal must be genuine public exports.")
    const installArgs = ["install", "--frozen-lockfile", "--ignore-scripts", "--filter", "@atape/cli..."]
    const install = (args: string[]) => execute("pnpm", args, { cwd: directory, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 })
    try { await install([...installArgs, "--offline"]) }
    catch (cause) {
      const output = cause as { readonly stdout?: string; readonly stderr?: string }
      if (!/ERR_PNPM_NO_OFFLINE_(?:META|TARBALL)/.test(`${output.stdout ?? ""}\n${output.stderr ?? ""}`)) throw cause
      await install(installArgs)
    }
    for (const input of inputs) if (digest(await readFile(join(directory, input.path))) !== input.sha256)
      throw new Error("Historical installation changed a frozen input.")
    const require = createRequire(join(directory, "apps/cli/package.json"))
    const within = (path: string) => {
      const local = relative(directory, path)
      return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local)
    }
    const esbuildPath = require.resolve("esbuild"), effectPath = require.resolve("effect/package.json")
    if (!within(esbuildPath) || !within(effectPath)) throw new Error("Historical toolchain resolved outside its isolated checkout.")
    const esbuild = require("esbuild") as typeof import("esbuild")
    const effect = JSON.parse(await readFile(effectPath, "utf8")) as { version: string }
    const catalog = await readFile(join(directory, "pnpm-workspace.yaml"), "utf8")
    const pnpm = (await execute("pnpm", ["--version"], { cwd: directory, encoding: "utf8", timeout: 30_000 })).stdout.trim()
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { version: string; packageManager: string }
    const cli = JSON.parse(await readFile(join(directory, "apps/cli/package.json"), "utf8")) as { version: string; atapeRuntime: { stateContract: string } }
    if (manifest.version !== "0.5.8" || cli.version !== "0.5.8" || manifest.packageManager !== `pnpm@${pnpm}` ||
      !catalog.includes(`effect: ${effect.version}\n`) || !catalog.includes(`esbuild: ${esbuild.version}\n`))
      throw new Error("Historical identity or dependency pins differ from the published 0.5.8 sources.")
    const wrapper = join(directory, "historical-entry.ts")
    await writeFile(wrapper, 'export { CaptureJournals, CaptureJournal, CollectorStateStore, SourceCaptureCollector, makeSourceCaptureCollectorLayer, PublicationTransport, PublicationError, RawPublicationTransport, RawPublicationError, makeSecretRedactorLayer, SecretRedactor, defaultSourceCollectionLimits } from "@atape/application"\nexport { makeCaptureJournalsLayer } from "./apps/cli/src/runtime/captureBootstrap.ts"\nexport { makeCollectorStateLayer } from "./apps/cli/src/runtime/collectorState.ts"\nexport { Effect, Layer } from "effect"\n')
    const entry = join(directory, "historical-source-collector.mjs")
    const built = await esbuild.build({ absWorkingDir: directory, entryPoints: [wrapper], outfile: entry,
      bundle: true, platform: "node", format: "esm", target: "node24", legalComments: "eof", logLevel: "silent", metafile: true,
      nodePaths: [join(directory, "apps/cli/node_modules")],
      define: { __ATAPE_CLI_VERSION__: JSON.stringify(cli.version), __ATAPE_CAPTURE_STATE_CONTRACT__: JSON.stringify(cli.atapeRuntime.stateContract) } })
    for (const input of Object.keys(built.metafile.inputs)) if (!within(resolve(directory, input)))
      throw new Error("Historical SourceCollector build resolved outside the isolated checkout.")
    const bundle = await readFile(entry)
    const proof = { revision, tag, dependencyMode: "historical-frozen-lock", inputs,
      lockSha256: inputs.find(input => input.path === "pnpm-lock.yaml")!.sha256,
      bundle: { bytes: bundle.length, sha256: digest(bundle) },
      runtime: { version: cli.version, captureStateContract: cli.atapeRuntime.stateContract },
      toolchain: { node: process.version, pnpm, esbuild: esbuild.version, effect: effect.version } }
    await writeFile(join(directory, "provenance.json"), `${JSON.stringify(proof, null, 2)}\n`)
    const historical = await import(pathToFileURL(entry).href) as HistoricalModules
    if (typeof historical.SourceCaptureCollector?.use !== "function" || typeof historical.makeCaptureJournalsLayer !== "function" ||
      typeof historical.Effect?.runPromise !== "function") throw new Error("Historical public SourceCollector Interfaces are missing.")
    return { ...historical, proof, cleanup: () => rm(directory, { recursive: true, force: true }) }
  } catch (cause) { await rm(directory, { recursive: true, force: true }); throw cause }
}
