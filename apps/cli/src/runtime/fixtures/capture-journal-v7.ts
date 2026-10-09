import type { CaptureJournal } from "@atape/application"
import type { Effect, Scope } from "effect"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import type { CaptureJournalOptions } from "../captureJournal.ts"

const revision = "0840d6a7061f3a38302f2ed97a4d26915d238845"
const tag = "v0.5.3"
const repository = fileURLToPath(new URL("../../../../..", import.meta.url))
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export type CaptureJournalV7 = Omit<CaptureJournal["Service"],
  "legacyMigration" | "freezeLegacyMigration" | "recordFloor" | "adoptBaseline" | "sourceMetadata" | "setSourceMetadata">

/** Build the untouched published 0.5.3 journal and its own public contract.
 * The package-root alias selects that contract's genuine exported Module only;
 * it never substitutes current journal code or edits a SQLite format number. */
export const captureJournalV7 = async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "atape-historical-journal-v7-")))
  const execute = promisify(execFile)
  const git = async (args: string[]) => (await execute("git", args, {
    cwd: repository, encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 10_000
  })).stdout
  try {
    await git(["cat-file", "-e", `${revision}^{commit}`])
    if ((await git(["rev-parse", `${tag}^{commit}`])).toString("utf8").trim() !== revision)
      throw new Error("The historical journal tag does not identify the published 0.5.3 commit.")
    const show = (path: string) => git(["show", `${revision}:${path}`])
    const lock = await show("pnpm-lock.yaml")
    const publicIndex = await show("packages/application/src/index.ts")
    if (!publicIndex.toString("utf8").includes('export * from "./captureJournal.ts"'))
      throw new Error("The historical capture journal contract was not publicly exported.")
    // Current source dependencies may evolve independently. Materialize the
    // complete historical workspace dependency authority, never its current
    // lock or node_modules, around the two untouched journal sources.
    const tree = (await git(["ls-tree", "-r", "--name-only", revision])).toString("utf8").trim().split("\n")
    const manifests = tree.filter(path => /^(?:apps|adapters|packages)\/[^/]+\/package\.json$/.test(path))
    const sourcePaths = ["apps/cli/src/runtime/captureJournal.ts", "packages/application/src/captureJournal.ts"]
    const paths = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", ...manifests,
      "packages/application/src/index.ts", ...sourcePaths]
    const inputs: Array<{ readonly path: string; readonly bytes: number; readonly sha256: string }> = []
    for (const path of paths) {
      const bytes = await show(path), target = join(directory, path)
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
      inputs.push({ path, bytes: bytes.length, sha256: digest(bytes) })
    }
    const installArgs = ["install", "--frozen-lockfile", "--ignore-scripts", "--filter", "@atape/cli..."]
    const install = (args: string[]) => execute("pnpm", args, {
      cwd: directory, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000
    })
    try { await install([...installArgs, "--offline"]) }
    catch (cause) {
      const output = cause as { readonly stdout?: string; readonly stderr?: string }
      if (!/ERR_PNPM_NO_OFFLINE_(?:META|TARBALL)/.test(`${output.stdout ?? ""}\n${output.stderr ?? ""}`)) throw cause
      await install(installArgs)
    }
    for (const input of inputs) if (digest(await readFile(join(directory, input.path))) !== input.sha256)
      throw new Error("The historical dependency install changed a frozen journal input.")
    const require = createRequire(join(directory, "apps/cli/package.json"))
    const within = (path: string) => {
      const local = relative(directory, path)
      return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local)
    }
    const esbuildPath = require.resolve("esbuild"), effectPath = require.resolve("effect/package.json")
    if (!within(esbuildPath) || !within(effectPath))
      throw new Error("Historical journal toolchain resolved outside its isolated checkout.")
    const esbuild = require("esbuild") as typeof import("esbuild")
    const effect = JSON.parse(await readFile(effectPath, "utf8")) as { version: string }
    const catalog = (await readFile(join(directory, "pnpm-workspace.yaml"))).toString("utf8")
    const pnpm = (await execute("pnpm", ["--version"], { cwd: directory, encoding: "utf8", timeout: 30_000 })).stdout.trim()
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { packageManager: string }
    if (manifest.packageManager !== `pnpm@${pnpm}` || !catalog.includes(`effect: ${effect.version}\n`) || !catalog.includes(`esbuild: ${esbuild.version}\n`))
      throw new Error("Isolated Effect/esbuild/pnpm differs from the historical journal toolchain pins.")
    const wrapper = join(directory, "historical-entry.ts")
    await writeFile(wrapper, 'export { openCaptureJournal } from "./apps/cli/src/runtime/captureJournal.ts"\nexport { Effect } from "effect"\n')
    const entry = join(directory, "historical-journal.mjs")
    const built = await esbuild.build({ absWorkingDir: directory, entryPoints: [wrapper], outfile: entry,
      bundle: true, platform: "node", format: "esm", target: "node24", legalComments: "eof", logLevel: "silent", metafile: true,
      nodePaths: [join(directory, "apps/cli/node_modules")],
      alias: { "@atape/application": join(directory, "packages/application/src/captureJournal.ts") } })
    for (const input of Object.keys(built.metafile.inputs)) if (!within(resolve(directory, input)))
      throw new Error("Historical journal build resolved outside its isolated checkout.")
    const bundle = await readFile(entry)
    const sources = sourcePaths.map(path => inputs.find(input => input.path === path)!)
    const proof = { revision, tag, sources, lockSha256: digest(lock), publicIndexSha256: digest(publicIndex),
      dependencyMode: "historical-frozen-lock", inputs,
      bundle: { bytes: bundle.length, sha256: digest(bundle) },
      toolchain: { node: process.version, pnpm, esbuild: esbuild.version, effect: effect.version } }
    await writeFile(join(directory, "provenance.json"), JSON.stringify(proof, null, 2) + "\n")
    const historical = await import(pathToFileURL(entry).href) as {
      readonly Effect: typeof import("effect").Effect
      readonly openCaptureJournal: (options: CaptureJournalOptions) => Effect.Effect<CaptureJournalV7, { readonly reason: string }, Scope.Scope>
    }
    if (typeof historical.openCaptureJournal !== "function" || typeof historical.Effect?.runPromise !== "function")
      throw new Error("The historical public journal Interface is missing.")
    return { ...historical, proof, cleanup: () => rm(directory, { recursive: true, force: true }) }
  } catch (cause) { await rm(directory, { recursive: true, force: true }); throw cause }
}
