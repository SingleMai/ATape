import type { CaptureJournal } from "@atape/application"
import type { Effect, Scope } from "effect"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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
  const directory = await mkdtemp(join(tmpdir(), "atape-historical-journal-v7-"))
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
    if (!lock.equals(await readFile(join(repository, "pnpm-lock.yaml"))))
      throw new Error("Historical journal requires its pinned dependency lock; current dependencies cannot replace it.")
    const require = createRequire(join(repository, "apps/cli/package.json"))
    const esbuild = require("esbuild") as typeof import("esbuild")
    const effect = JSON.parse(await readFile(join(repository, "apps/cli/node_modules/effect/package.json"), "utf8")) as { version: string }
    const catalog = (await show("pnpm-workspace.yaml")).toString("utf8")
    if (!catalog.includes(`effect: ${effect.version}\n`) || !catalog.includes(`esbuild: ${esbuild.version}\n`))
      throw new Error("Installed Effect/esbuild differs from the historical journal toolchain pins.")
    const publicIndex = await show("packages/application/src/index.ts")
    if (!publicIndex.toString("utf8").includes('export * from "./captureJournal.ts"'))
      throw new Error("The historical capture journal contract was not publicly exported.")
    const sources = []
    for (const path of ["apps/cli/src/runtime/captureJournal.ts", "packages/application/src/captureJournal.ts"]) {
      const bytes = await show(path), target = join(directory, path)
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
      sources.push({ path, bytes: bytes.length, sha256: digest(bytes) })
    }
    const wrapper = join(directory, "historical-entry.ts")
    await writeFile(wrapper, 'export { openCaptureJournal } from "./apps/cli/src/runtime/captureJournal.ts"\nexport { Effect } from "effect"\n')
    const entry = join(directory, "historical-journal.mjs")
    await esbuild.build({ absWorkingDir: directory, entryPoints: [wrapper], outfile: entry,
      bundle: true, platform: "node", format: "esm", target: "node24", legalComments: "eof", logLevel: "silent",
      nodePaths: [join(repository, "apps/cli/node_modules")],
      alias: { "@atape/application": join(directory, "packages/application/src/captureJournal.ts") } })
    const bundle = await readFile(entry)
    const proof = { revision, tag, sources, lockSha256: digest(lock), publicIndexSha256: digest(publicIndex),
      bundle: { bytes: bundle.length, sha256: digest(bundle) },
      toolchain: { node: process.version, esbuild: esbuild.version, effect: effect.version } }
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
