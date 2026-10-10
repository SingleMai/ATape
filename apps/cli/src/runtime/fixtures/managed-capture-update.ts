import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { DatabaseSync } from "node:sqlite"
import { build } from "esbuild"
import { Effect } from "effect"
import { CaptureJournals } from "@atape/application"
import { emptyClientConfig, releasePackageNames, type MigrationReleaseBundle } from "@atape/domain"
import { defaultNodeClientPaths } from "../clientPaths.ts"
import { makeCaptureJournalsLayer } from "../captureBootstrap.ts"
import { runtimeContext } from "../runtimeAdmission.ts"
import { captureRoot } from "../captureBinding.ts"
import { atomicJSON, runtimeEntry } from "../runtimeSelection.ts"
import { updateControlProtocol, type UpdateRuntimeSelection } from "../updateControl.ts"
import type { PreparedCaptureUpdate } from "../managedCaptureUpdates.ts"
import { downgradeJournalToV7 } from "./capture-journal-legacy.ts"

const execute = promisify(execFile)
const packageRoot = fileURLToPath(new URL("../../../", import.meta.url))
export const captureV1 = "atape.client.v3-capture.v1", captureV2 = "atape.client.v3-capture.v2"
export const fixtureAccount = { instanceOrigin: "https://atape.test", userId: "fixture-user" }
export const fixtureLimits = { unitBytes: 1024, targetBytes: 1024 * 1024, pendingBytes: 2 * 1024 * 1024,
  metadataEntries: 1000, unitsPerTarget: 100, recordsPerTarget: 100 }
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export const compileCaptureFixtureEntry = async (output: string, kind: "target" | "coordinator", version: string,
  contract = kind === "target" ? captureV2 : captureV1) => {
  await mkdir(dirname(output), { recursive: true })
  await build({ absWorkingDir: packageRoot, entryPoints: [kind === "target" ? "src/entry.ts" : "src/runtime/fixtures/managed-capture-coordinator.ts"],
    outfile: output, bundle: true, platform: "node", format: "esm", target: "node24",
    define: { __ATAPE_CLI_VERSION__: JSON.stringify(version), __ATAPE_CAPTURE_STATE_CONTRACT__: JSON.stringify(contract),
      "process.env.NODE_ENV": '"production"' },
    banner: { js: 'import { createRequire as __atapeCreateRequire } from "node:module"; const require = __atapeCreateRequire(import.meta.url);' },
    plugins: [{ name: "fixture-without-ink-devtools", setup(builder) {
      builder.onResolve({ filter: /^\.\/devtools\.js$/ }, args => /[/\\]ink[/\\]build[/\\]reconciler\.js$/.test(args.importer)
        ? { path: "fixture-devtools", namespace: "atape-fixture" } : undefined)
      builder.onLoad({ filter: /.*/, namespace: "atape-fixture" }, () => ({ contents: "export {};", loader: "js" }))
    } }], logLevel: "silent" })
  await chmod(output, 0o700)
}

export const prepareManagedCaptureFixture = async (root: string, targetPackage: string, sourceEntry: string) => {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const paths = defaultNodeClientPaths({ ATAPE_HOME: join(root, "home") })
  const targetManifest = JSON.parse(await readFile(join(targetPackage, "package.json"), "utf8"))
  if (targetManifest.atapeRuntime.stateContract !== captureV2 || targetManifest.atapeRuntime.captureMigrationProtocol !== "atape.capture-migration.v1")
    throw new Error("Fixture target must be an actual migration-capable capture-v2 package.")
  const bootstrap = join(root, "npm", "node_modules", "@atape", "cli", "dist", "atape.js")
  await mkdir(dirname(bootstrap), { recursive: true })
  await cp(sourceEntry, bootstrap)
  const sourceManifest = { name: "@atape/cli", version: "0.0.1", type: "module", atapeRuntime: {
    protocol: "atape.runtime.v1", stateContract: captureV1, updateControlProtocol } }
  await atomicJSON(join(dirname(dirname(bootstrap)), "package.json"), sourceManifest)
  const oldEntry = runtimeEntry(paths.atapeHome, sourceManifest.version)
  await mkdir(dirname(oldEntry), { recursive: true }); await cp(bootstrap, oldEntry)
  await atomicJSON(join(dirname(dirname(oldEntry)), "package.json"), sourceManifest)
  const targetEntry = runtimeEntry(paths.atapeHome, targetManifest.version)
  await cp(targetPackage, dirname(dirname(targetEntry)), { recursive: true })
  const source: UpdateRuntimeSelection = { protocol: updateControlProtocol, version: sourceManifest.version,
    captureStateContract: captureV1, bootstrapEntry: bootstrap, bootstrapIdentity: digest(await readFile(bootstrap)), adapters: [] }
  const target: UpdateRuntimeSelection = { ...source, version: targetManifest.version, captureStateContract: captureV2 }
  await atomicJSON(join(paths.atapeHome, "updates", "runtime.json"), source)
  const config = { ...emptyClientConfig(), toolsConfigured: true, autoUpdateEnabled: true, autoStartEnabled: false }
  await atomicJSON(paths.configFile, config)
  await mkdir(dirname(paths.collectorStateFile), { recursive: true })
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const journals = yield* CaptureJournals, journal = yield* journals.open(fixtureAccount, fixtureLimits)
    yield* journal.claim({ projectId: "project", adapterId: "claude", sourceSessionId: "session", originKey: "fixture-root" })
  })).pipe(Effect.provide(makeCaptureJournalsLayer(paths.collectorStateFile, runtimeContext(paths.atapeHome)))))
  const key = digest(JSON.stringify([fixtureAccount.instanceOrigin, fixtureAccount.userId]))
  const journalPath = join(captureRoot(paths.collectorStateFile), `${key}.sqlite`)
  const db = new DatabaseSync(journalPath)
  try { downgradeJournalToV7(db) } finally { db.close() }
  await atomicJSON(`${paths.collectorProcessFile}.desired.json`, { version: 1, wanted: false })
  const bundle: MigrationReleaseBundle = { protocol: "atape.release-bundle.v2", version: target.version,
    captureStateContract: captureV2, updateControlProtocol, migration: targetManifest.atapeRuntime.captureMigration,
    packages: releasePackageNames.map(name => ({ name,
      integrity: `sha512-${createHash("sha512").update(`${name}@${target.version}`).digest("base64")}`,
      tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${target.version}.tgz` })) }
  const candidate: PreparedCaptureUpdate = { bundle, selection: target, baseline: [], baselineSelection: source, enabledAdapterIds: [], hasGit: false }
  const payloadFile = join(root, "case.json")
  await atomicJSON(payloadFile, { paths, source, candidate, account: fixtureAccount, limits: fixtureLimits })
  const preload = join(root, "no-network.mjs"), networkFile = join(root, "network.jsonl"), entryTrace = join(root, "entries.jsonl")
  await writeFile(preload, `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(entryTrace)},JSON.stringify({entry:process.argv[1],args:process.argv.slice(2)})+"\\n");
globalThis.fetch=async url=>{appendFileSync(${JSON.stringify(networkFile)},JSON.stringify(String(url))+"\\n");throw new Error("Unexpected network in stopped migration fixture")};\n`)
  const environment: NodeJS.ProcessEnv = { HOME: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: root, ATAPE_HOME: paths.atapeHome, ATAPE_CONFIG_FILE: paths.configFile, ATAPE_LANG: "en", LANG: "en_US.UTF-8",
    ATAPE_BOOTSTRAP_ENTRY: bootstrap, NODE_OPTIONS: `--import=${preload}`, ATAPE_RUNTIME_DIRECT: "1" }
  const invoke = async (operation: string, entry = bootstrap) => {
    const result = await execute(process.execPath, [entry, operation, payloadFile], { env: environment, cwd: root,
      timeout: 45_000, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 })
    return JSON.parse(result.stdout) as Record<string, unknown>
  }
  return { root, paths, source, target, candidate, payloadFile, journalPath, bootstrap, targetEntry, environment, networkFile, entryTrace, invoke }
}

export const journalVersion = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return Number(db.prepare("PRAGMA user_version").get()?.user_version) } finally { db.close() }
}
