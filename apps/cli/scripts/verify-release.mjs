import { Effect, ManagedRuntime } from "effect"
import { AdapterRuntimes, ClientConfigStore, CollectorStateStore, applyProjectSetup, planProjectSetup, installAdapter, inspectTools, applyToolChange, planToolChange, loginCLI, runCollector, setAutomaticUpdates, upgradeAdapters } from "@atape/application"
import { defaultNodeClientPaths, makeNodeClientLayer } from "../src/runtime/clientLayers.ts"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { startCLIAuthFixture } from "../../../scripts/cli-auth-fixture.mjs"
import { loadReleaseContract } from "../../../scripts/release-contract.mjs"

const execute = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url))
const release = await loadReleaseContract(repositoryRoot)
const releaseDirectory = release.releaseDirectory
const cliPackage = release.packages.find((package_) => package_.name === "@atape/cli")
const adapterPackage = release.packages.find((package_) => package_.name === "@atape/adapter-codex")
const claudePackage = release.packages.find((package_) => package_.name === "@atape/adapter-claude")
const cursorPackage = release.packages.find(package_ => package_.name === "@atape/adapter-cursor")
const grokPackage = release.packages.find(package_ => package_.name === "@atape/adapter-grok")
const codebuddyPackage = release.packages.find(package_ => package_.name === "@atape/adapter-codebuddy")
const kimiPackage = release.packages.find(package_ => package_.name === "@atape/adapter-kimi")
const opencodePackage = release.packages.find(package_ => package_.name === "@atape/adapter-opencode")
if (cursorPackage === undefined || kimiPackage === undefined || grokPackage === undefined || codebuddyPackage === undefined || opencodePackage === undefined || cliPackage === undefined || adapterPackage === undefined || claudePackage === undefined) throw new Error("Release packages are incomplete.")
const cliArtifact = join(releaseDirectory, cliPackage.artifactName)
const adapterArtifact = join(releaseDirectory, adapterPackage.artifactName)
const claudeArtifact = join(releaseDirectory, claudePackage.artifactName)
const cursorArtifact = join(releaseDirectory, cursorPackage.artifactName)
const grokArtifact = join(releaseDirectory, grokPackage.artifactName)
const codebuddyArtifact = join(releaseDirectory, codebuddyPackage.artifactName)
const kimiArtifact = join(releaseDirectory, kimiPackage.artifactName)
const opencodeArtifact = join(releaseDirectory, opencodePackage.artifactName)
const temporaryRoot = await mkdtemp(join(tmpdir(), "atape-release-"))
const installDirectory = join(temporaryRoot, "install")
const projectDirectory = join(temporaryRoot, "project")
const codexHome = join(temporaryRoot, "codex-home")
const claudeHome = join(temporaryRoot, "claude-home")
const claudeDirectory = join(claudeHome, "projects", "release-fixture")
const stateDirectory = join(temporaryRoot, "state")
const binary = join(
  installDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "atape.cmd" : "atape"
)
const environment = {
  ...process.env,
  HOME: join(temporaryRoot, "user-home"),
  ATAPE_HOME: stateDirectory,
  CURSOR_CONFIG_DIR: join(temporaryRoot, "missing-cursor"),
  CURSOR_DATA_DIR: join(temporaryRoot, "missing-cursor"),
  ATAPE_DEVELOPMENT_ALLOW_HTTP: "true",
  XDG_CONFIG_HOME: join(temporaryRoot, "xdg-config"),
  XDG_DATA_HOME: join(temporaryRoot, "xdg-data"),
  XDG_STATE_HOME: join(temporaryRoot, "xdg-state"),
  ATAPE_CODEX_HOME: codexHome,
  ATAPE_CLAUDE_HOME: claudeHome,
  ATAPE_GROK_HOME: join(temporaryRoot, "missing-grok"),
  ATAPE_CODEBUDDY_HOME: join(temporaryRoot, "missing-codebuddy"),
  ATAPE_KIMI_HOME: join(temporaryRoot, "missing-kimi"),
  OPENCODE_DB: join(temporaryRoot, "missing-opencode.db"),
  ATAPE_CLAUDE_SESSION_FILE: "",
  ATAPE_REDACT_VALUES: "[]"
}
let remote
let runtime
const originalEnvironment = { ...process.env }
const configure = ids => runtime.runPromise(planToolChange(ids).pipe(Effect.flatMap(applyToolChange)))
const collectProject = () => runtime.runPromise(runCollector({ once: true, projectId: "release-project" }))

try {
  await run("node", ["scripts/pack-release.mjs"], repositoryRoot)
  await verifyChecksums()
  await Promise.all([
    mkdir(projectDirectory, { recursive: true }),
    mkdir(claudeDirectory, { recursive: true }),
    mkdir(join(codexHome, "sessions"), { recursive: true }),
    mkdir(join(codexHome, "archived_sessions"), { recursive: true })
  ])
  await run("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installDirectory, cliArtifact
  ], temporaryRoot)
  remote = await startCLIAuthFixture({
    capture: true,
    rawCaptureEnabled: true,
    userId: "release-user",
    userName: "Release User",
    teamId: "release-team-id",
    teamSlug: "release-team",
    teamName: "Release Team",
    projectId: "release-project",
    projectName: "Release Project",
    credential: "atc_v1_release-secret",
    credentialId: "release-credential"
  })
  environment.ATAPE_INSTANCE_URL = remote.origin
  // Providers read their source-specific environment while loaded by the real Node Host.
  Object.assign(process.env, environment)
  runtime = ManagedRuntime.make(makeNodeClientLayer(defaultNodeClientPaths(environment), environment))
  await runtime.runPromise(setAutomaticUpdates(false))
  await runtime.runPromise(ClientConfigStore.use(store => store.transact(config => Effect.succeed({ value: undefined, config: { ...config, autoStartEnabled: false } }))))
  assert.match((await atape(["--help"])).stdout, /projects, tools and settings/)
  const login = await runtime.runPromise(loginCLI({ instanceOrigin: remote.origin, allowLoopbackHttp: true, openBrowser: false }))
  assert.equal(login.user.id, "release-user")
  assert.equal(login.instanceOrigin, remote.origin)

  const installed = await runtime.runPromise(installAdapter(adapterArtifact))
  assert.equal(installed.created, true)
  assert.equal(installed.adapter.adapterId, "codex")
  assert.equal(installed.adapter.packageName, "@atape/adapter-codex")
  assert.equal(installed.adapter.upgradeSpec, `file:${adapterArtifact}`)
  assert.equal(installed.adapter.version, adapterPackage.version)
  assert.equal(installed.adapter.displayName, "Codex")
  await configure(["codex"])
  const plan = await runtime.runPromise(planProjectSetup({ instanceOrigin: remote.origin, path: projectDirectory, type: "directory" }))
  await runtime.runPromise(applyProjectSetup(plan, { mode: "create", teamId: "release-team-id", name: "Release Project" }))
  assert.ok(!JSON.stringify(remote.requests).includes(projectDirectory), "setup uploaded a local filesystem path")
  const collected = await collectProject()
  assert.equal(collected.failures.length, 0)
  assert.deepEqual(collected.jobs.map((job) => ({
    projectId: job.projectId,
    adapterId: job.adapterId,
    observations: job.observations
  })), [{ projectId: "release-project", adapterId: "codex", observations: 0 }])

  await verifyClaudePackageReplacement()
  const opencode = await runtime.runPromise(installAdapter(opencodeArtifact))
  assert.equal(opencode.adapter.adapterId, "opencode")
  assert.equal(opencode.adapter.version, opencodePackage.version)
  await configure(["codex", "claude", "opencode"])
  const tools = await runtime.runPromise(inspectTools())
  assert.ok(tools.choices.some(choice => choice.id === "opencode" && choice.installed && choice.selected))
  await run(process.execPath, ["adapters/opencode/scripts/verify-package.mjs", opencodeArtifact], repositoryRoot)
  const codebuddy = await runtime.runPromise(installAdapter(codebuddyArtifact))
  assert.equal(codebuddy.adapter.adapterId, "codebuddy")
  assert.equal(codebuddy.adapter.version, codebuddyPackage.version)
  await configure(["codex", "claude", "opencode", "codebuddy"])
  const updatedTools = await runtime.runPromise(inspectTools())
  assert.ok(updatedTools.choices.some(choice => choice.id === "codebuddy" && choice.installed && choice.selected))
  await run(process.execPath, ["adapters/codebuddy/scripts/verify-package.mjs", codebuddyArtifact], repositoryRoot)
  const kimi = await runtime.runPromise(installAdapter(kimiArtifact))
  assert.equal(kimi.adapter.adapterId, "kimi")
  assert.equal(kimi.adapter.version, kimiPackage.version)
  await configure(["codex", "claude", "opencode", "codebuddy", "kimi"])
  assert.ok((await runtime.runPromise(inspectTools())).choices.some(choice => choice.id === "kimi" && choice.installed && choice.selected))
  await run(process.execPath, ["adapters/kimi/scripts/verify-package.mjs", kimiArtifact], repositoryRoot)
  const grok = await runtime.runPromise(installAdapter(grokArtifact))
  assert.equal(grok.adapter.adapterId, "grok")
  assert.equal(grok.adapter.version, grokPackage.version)
  await configure(["codex", "claude", "opencode", "codebuddy", "kimi", "grok"])
  const grokTools = await runtime.runPromise(inspectTools())
  assert.ok(grokTools.choices.some(choice => choice.id === "grok" && choice.installed && choice.selected))
  await run(process.execPath, ["adapters/grok/scripts/verify-package.mjs", grokArtifact], repositoryRoot)
  const cursor = await runtime.runPromise(installAdapter(cursorArtifact))
  assert.equal(cursor.adapter.adapterId, "cursor")
  assert.equal(cursor.adapter.version, cursorPackage.version)
  await configure(["codex", "claude", "opencode", "codebuddy", "kimi", "grok", "cursor"])
  assert.ok((await runtime.runPromise(inspectTools())).choices.some(choice => choice.id === "cursor" && choice.installed && choice.selected))
  await run(process.execPath, ["adapters/cursor/scripts/verify-package.mjs", cursorArtifact], repositoryRoot)
  // The fixture artifact is kept outside release/ and never replaces publish bytes.
  await verifyChecksums()
  process.stdout.write("Verified CLI artifact help, Codex/Claude/OpenCode/CodeBuddy/Kimi/Grok/Cursor artifacts through the source Node Host, and a versioned Claude package replacement preserving configuration and checkpoint bytes. Installed console/daemon coverage is the separate CLI package gate; Claude delivery and legacy compatibility use the required authenticated PostgreSQL contracts.\n")
} finally {
  await runtime?.dispose()
  for (const key of Object.keys(environment)) {
    if (originalEnvironment[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnvironment[key]
  }
  await remote?.close().catch(() => undefined)
  await rm(temporaryRoot, { recursive: true, force: true })
}

async function verifyChecksums() {
  const expected = new Map((await readFile(join(releaseDirectory, "SHA256SUMS"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => {
      const [digest, filename] = line.split(/\s{2}/)
      return [filename, digest]
    }))
  assert.equal(expected.size, release.packages.length)
  for (const artifact of release.packages.map(package_ => join(releaseDirectory, package_.artifactName))) {
    const filename = artifact.slice(releaseDirectory.length + 1)
    const digest = createHash("sha256").update(await readFile(artifact)).digest("hex")
    assert.equal(expected.get(filename), digest)
  }
}

async function verifyClaudePackageReplacement() {
  // There is no historical released Claude package in this test. Re-version the
  // current bundle in isolated staging to exercise the real package replacement
  // boundary; this is not evidence of old source-format compatibility.
  const staging = join(temporaryRoot, "upgrade-staging")
  await mkdir(staging)
  await run("tar", ["-xzf", claudeArtifact, "-C", staging], temporaryRoot)
  const manifestPath = join(staging, "package", "package.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  const fixtureVersion = `${release.version.split("-")[0]}-upgrade-fixture`
  manifest.version = fixtureVersion
  await writeFile(manifestPath, JSON.stringify(manifest))
  const packed = JSON.parse((await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", staging], join(staging, "package"))).stdout)
  const upgradeSource = join(temporaryRoot, "claude-upgrade.tgz")
  await copyFile(join(staging, packed[0].filename), upgradeSource)
  const statePath = join(stateDirectory, "state", "collector.json")
  const beforeInstall = await readFile(statePath, "utf8")
  const installed = await runtime.runPromise(installAdapter(upgradeSource))
  assert.equal(installed.adapter.adapterId, "claude")
  assert.equal(installed.adapter.version, fixtureVersion)
  assert.equal(installed.adapter.upgradeSpec, `file:${await realpath(upgradeSource)}`)
  assert.equal(await readFile(statePath, "utf8"), beforeInstall, "package installation must not rewrite Collector state")
  await configure(["codex", "claude"])
  const configuration = () => runtime.runPromise(ClientConfigStore.use(store => store.transact(config => Effect.succeed({ value: config }))))
  const configured = await configuration()
  const project = configured.projects.find(item => item.id === "release-project")
  assert.ok(project)
  const verifyRuntime = adapter => runtime.runPromise(Effect.scoped(Effect.gen(function*() {
    const hosted = yield* (yield* AdapterRuntimes).open({ ...project, adapterIds: configured.enabledAdapterIds }, adapter)
    assert.ok("sourceCapture" in hosted)
    assert.equal("collect" in hosted, false)
    assert.equal(hosted.sourceCapture.protocolVersion, "atape.source-capture.v2")
    assert.equal(typeof hosted.sourceCapture.legacyMigration, "function")
  })))
  await verifyRuntime(installed.adapter)
  // Generated state tests package replacement's byte preservation only. It is
  // never collected or claimed as native capture/old-format compatibility proof.
  // Delivery uses the required PG18 and genuine previous-main legacy contracts.
  const generatedCheckpoint = { instanceOrigin: remote.origin, userId: "release-user", projectId: project.id,
    projectCreatedAt: project.createdAt, adapterId: "claude", adapterVersion: fixtureVersion, revision: 1,
    cursor: "generated-package-replacement-checkpoint", rawObjects: [], canonicalPublished: false,
    updatedAt: new Date().toISOString() }
  await runtime.runPromise(CollectorStateStore.use(store => store.commit({ instanceOrigin: remote.origin, userId: "release-user",
    projectId: project.id, adapterId: "claude", expectedRevision: 0, checkpoint: generatedCheckpoint })))
  const before = await readFile(statePath, "utf8")
  const checkpoint = JSON.parse(before).checkpoints.find(item => item.adapterId === "claude")
  assert.deepEqual(checkpoint, generatedCheckpoint)

  await copyFile(claudeArtifact, upgradeSource)
  const upgraded = { adapters: await runtime.runPromise(upgradeAdapters("claude")) }
  assert.equal(upgraded.adapters.length, 1)
  assert.equal(upgraded.adapters[0].adapterId, "claude")
  assert.equal(upgraded.adapters[0].version, claudePackage.version)
  assert.equal(await readFile(statePath, "utf8"), before, "package replacement must not rewrite Collector state")
  const replaced = await configuration()
  assert.deepEqual({ ...replaced, adapters: replaced.adapters.filter(item => item.adapterId !== "claude") },
    { ...configured, adapters: configured.adapters.filter(item => item.adapterId !== "claude") },
    "package replacement must preserve Projects, tool selections and other Adapter configuration")
  const current = replaced.adapters.find(item => item.adapterId === "claude")
  assert.equal(current.upgradeSpec, installed.adapter.upgradeSpec)
  assert.equal(current.version, claudePackage.version)
  await verifyRuntime(current)
  assert.equal(await readFile(statePath, "utf8"), before, "opening the installed runtime must not rewrite Collector state")
}

function atape(arguments_) {
  return run(binary, arguments_, temporaryRoot, environment)
}

async function run(file, arguments_, cwd, env = process.env) {
  try {
    return await execute(file, arguments_, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024
    })
  } catch (cause) {
    const detail = cause && typeof cause === "object"
      ? `\nstdout: ${cause.stdout ?? ""}\nstderr: ${cause.stderr ?? ""}`
      : ""
    throw new Error(`${file} ${arguments_.join(" ")} failed${detail}`, { cause })
  }
}
