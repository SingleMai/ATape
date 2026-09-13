// Controlled native source + real installed CLI/Adapter against the Go HTTP contract.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { CaptureJournals, CLICredentialStore, CollectorStateStore, runCollectionCycle, installAdapter, planToolChange, applyToolChange, startManagedCollector, stopManagedCollector, inspectManagedCollector } from "@atape/application"
import { type StoredCLICredential } from "@atape/domain"
import { Effect, Layer, Logger } from "effect"
import { makeNodeClientLayer, defaultNodeClientPaths } from "../clientLayers.ts"
import { makeNodeCollectorDaemonLayer } from "../collectorDaemonLayers.ts"
import { defaultSourceCollectionLimits } from "@atape/application"

const input = JSON.parse(readFileSync(0, "utf8")) as { phase: string; origin: string; credential: string; userId: string; home: string; tarball: string; cliTarball: string; projectId: string; teamId: string }
const forkPhase = input.phase.startsWith("fork-"), forkId = "atape-codebuddy-nested-fork-21240"
const compactPhase = input.phase.startsWith("compact-"), compactId = "atape-codebuddy-compact-21240"
const familyPhase = input.phase.startsWith("family-"), familyId = "atape-codebuddy-child-21240"
const backgroundPhase = input.phase.startsWith("background-"), backgroundId = "atape-codebuddy-background-21240"
const turnsPhase = input.phase.startsWith("turns-"), turnsId = "atape-codebuddy-background-turns-21240"
const emergencyPhase = input.phase.startsWith("emergency-"), emergencyId = "atape-codebuddy-child-compact-21240"
const multiPhase = input.phase.startsWith("multi-"), multiId = "atape-codebuddy-multitool-21240"
const multiWorkspace = join(input.home, "multitool-workspace")
const forkFamilyPhase = input.phase.startsWith("fork-family-"), forkFamilyId = "atape-codebuddy-fork-child-nested-21240"
const forkFamilyWorkspace = join(input.home, "fork-family-workspace")
const sourceId = forkFamilyPhase ? forkFamilyId : multiPhase ? multiId : emergencyPhase ? emergencyId : turnsPhase ? turnsId : backgroundPhase ? backgroundId : familyPhase ? familyId : compactPhase ? compactId : forkPhase && input.phase !== "fork-foreign" ? forkId : "atape-codebuddy-native-21240", home = input.home, workspace = join(home, "workspace")
const turnsWorkspace = join(home, "turns-workspace"), emergencyWorkspace = join(home, "emergency-workspace")
const forkWorkspace = join(home, "fork-workspace")
const compactWorkspace = join(home, "compact-workspace")
const familyWorkspace = join(home, "family-workspace"), backgroundWorkspace = join(home, "background-workspace")
const sourceHome = join(home, "source"), directory = join(sourceHome, "projects", "opaque"), file = join(directory, `${sourceId}.jsonl`)
const paths = defaultNodeClientPaths({ ATAPE_HOME: join(home, "client") }), installed = join(home, "installed")
const binary = join(installed, "node_modules", "@atape", "cli", "dist", "atape.js")
const environment = { ...process.env, ATAPE_HOME: paths.atapeHome, ATAPE_CODEBUDDY_HOME: sourceHome,
  ATAPE_CODEX_HOME: join(home, "missing-codex"), ATAPE_CLAUDE_HOME: join(home, "missing-claude"), OPENCODE_DB: join(home, "missing-opencode"),
  ATAPE_DEVELOPMENT_ALLOW_HTTP: "true", ATAPE_COLLECTOR_DAEMON: "0", TEST_SECRET: "SENSITIVE_TEST_TOKEN" }
process.env.ATAPE_CODEBUDDY_HOME = sourceHome
const native = readFileSync(new URL("../../../../../adapters/codebuddy/src/fixtures/native-2.124.0.jsonl", import.meta.url), "utf8").replaceAll("/fixture/codebuddy-project", workspace)
const at = "2026-09-12T16:00:00Z", adapterId = "codebuddy"
const forkSource = readFileSync(new URL("../../../../../adapters/codebuddy/src/fixtures/native-nested-fork-2.124.0.jsonl", import.meta.url), "utf8")
  .replaceAll("/fixture/codebuddy-project", workspace).replaceAll("/fixture/codebuddy-fork-project", forkWorkspace)
const forkMeta = readFileSync(new URL("../../../../../adapters/codebuddy/src/fixtures/native-fork-2.124.0.meta.json", import.meta.url), "utf8")
const compactSource = readFileSync(new URL("../../../../../adapters/codebuddy/src/fixtures/native-compaction-2.124.0.jsonl", import.meta.url), "utf8")
  .replaceAll("/fixture/codebuddy-compact-project", compactWorkspace)
const save = (rows: unknown[]) => writeFileSync(file, rows.map(row => JSON.stringify(row) + "\n").join(""))
if (input.phase === "initial") {
  mkdirSync(directory, { recursive: true }); mkdirSync(workspace); mkdirSync(paths.atapeHome, { recursive: true, mode: 0o700 })
  writeFileSync(file, native)
  // A valid foreign source must be discovered but excluded before capture.
  const foreign = native.replaceAll(sourceId, "foreign-codebuddy-session").replaceAll(workspace, join(home, "foreign-project"))
  mkdirSync(join(home, "foreign-project")); writeFileSync(join(directory, "foreign-codebuddy-session.jsonl"), foreign)
  execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installed, input.cliTarball], { cwd: home, stdio: "pipe", timeout: 120000 })
  mkdirSync(dirname(paths.configFile), { recursive: true })
  writeFileSync(paths.configFile, JSON.stringify({ version: 3, toolsConfigured: true, enabledAdapterIds: [], adapters: [], projects: [{
    id: input.projectId, instanceOrigin: input.origin, userId: input.userId, teamId: input.teamId, teamSlug: "acme", teamName: "Fixture", name: "CodeBuddy", type: "directory", path: workspace, createdAt: at, adapterIds: [] }] }))
}
if (input.phase === "fork-foreign") {
  mkdirSync(forkWorkspace)
  writeFileSync(join(directory, `${forkId}.jsonl`), forkSource.trimEnd().split("\n").slice(0, 21).join("\n") + "\n")
  writeFileSync(join(directory, `${forkId}.meta.json`), forkMeta)
}
if (input.phase === "fork-initial") {
  const config = JSON.parse(readFileSync(paths.configFile, "utf8"))
  config.projects.push({ ...config.projects[0], id: input.projectId, name: "CodeBuddy fork", path: forkWorkspace })
  writeFileSync(paths.configFile, JSON.stringify(config))
}
if (input.phase === "fork-resume") writeFileSync(file, forkSource)
if (input.phase === "fork-invalid") writeFileSync(file.replace(/\.jsonl$/, ".meta.json"), '{"forkedFrom":"unrelated"}')
if (input.phase === "fork-repair") writeFileSync(file.replace(/\.jsonl$/, ".meta.json"), forkMeta)
if (input.phase === "fork-lost") {
  const values = forkSource.trimEnd().split("\n").map(line => JSON.parse(line))
  values.at(-1).content[0].text = "CodeBuddyForkFrozenNeedle"
  save(values)
}
if (input.phase === "fork-recover") { rmSync(file); rmSync(file.replace(/\.jsonl$/, ".meta.json")) }
if (input.phase === "compact-initial") {
  mkdirSync(compactWorkspace)
  const config = JSON.parse(readFileSync(paths.configFile, "utf8"))
  config.projects.push({ ...config.projects[0], id: input.projectId, name: "CodeBuddy compaction", path: compactWorkspace })
  writeFileSync(paths.configFile, JSON.stringify(config))
}
const compactLength: Record<string, number> = { "compact-initial": 4, "compact-manual": 7, "compact-resume": 10, "compact-auto": 14, "compact-pending": 6, "compact-repair": 14 }
if (input.phase in compactLength) save(compactSource.trimEnd().split("\n").slice(0, compactLength[input.phase]).map(line => JSON.parse(line)))
if (["compact-edit", "compact-raw-only"].includes(input.phase)) {
  const values = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line))
  if (input.phase === "compact-edit") values.at(-1).content[0].text = "CodeBuddyCompactFinalNeedle"
  else values[10].content[0].text = values[10].content[0].text.replace("</cb_summary>", "CodeBuddyCompactRawOnlyNeedle</cb_summary>")
  save(values)
}
if (input.phase === "compact-recover") rmSync(file)
const childFile = join(directory, familyId, "subagents", "agent-6b64fa37.jsonl")
const familyFiles = [
  `${familyId}.jsonl`, `${familyId}/subagents/agent-6b64fa37.jsonl`,
  `${familyId}/subagents/agent-60a8b853.jsonl`, `${familyId}/subagents/agent-64db2ff8.jsonl`,
  "e8142638-13cc-4138-95b5-c9283398cb11/subagents/agent-bc513377.jsonl"
]
const familyLength: Record<string, number> = { "family-initial": 6, "family-resume": 11, "family-nested": 16, "family-compact": 18, "family-default": 24, "family-repair": 24 }
if (input.phase === "family-initial") {
  mkdirSync(familyWorkspace)
  const config = JSON.parse(readFileSync(paths.configFile, "utf8"))
  config.projects.push({ ...config.projects[0], id: input.projectId, name: "CodeBuddy children", path: familyWorkspace })
  writeFileSync(paths.configFile, JSON.stringify(config))
}
if (input.phase in familyLength) {
  for (const relative of familyFiles) {
    const destination = join(directory, relative)
    mkdirSync(dirname(destination), { recursive: true })
    // Child CWD deliberately names another configured Project: only the parent's Origin owns the family.
    const text = readFileSync(new URL(`../../../../../adapters/codebuddy/src/fixtures/native-family-2.124.0/${relative}`, import.meta.url), "utf8")
      .replaceAll("/fixture/codebuddy-family-project", relative === `${familyId}.jsonl` ? familyWorkspace : workspace)
    const rows = text.trimEnd().split("\n")
    writeFileSync(destination, rows.slice(0, relative === `${familyId}.jsonl` ? familyLength[input.phase] : relative.endsWith("agent-6b64fa37.jsonl") && input.phase === "family-initial" ? 3 : rows.length).join("\n") + "\n")
  }
}
if (input.phase === "family-invalid") writeFileSync(childFile, readFileSync(childFile, "utf8") + "unfinished")
if (input.phase === "family-missing") rmSync(childFile)
if (["family-edit", "family-lost"].includes(input.phase)) {
  const rows = readFileSync(childFile, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
  rows.at(-1).content[0].text = input.phase === "family-edit" ? "CodeBuddyChildPolicyNeedle" : "CodeBuddyChildFrozenNeedle"
  writeFileSync(childFile, rows.map(row => JSON.stringify(row) + "\n").join(""))
}
if (input.phase === "family-recover") for (const relative of familyFiles) rmSync(join(directory, relative))
const backgroundChild = join(directory, backgroundId, "subagents", "agent-aeb3d60f.jsonl")
const backgroundFiles = [`${backgroundId}.jsonl`, `${backgroundId}/subagents/agent-aeb3d60f.jsonl`, `${backgroundId}/subagents/agent-93604b67.jsonl`]
const backgroundLength: Record<string, number> = { "background-initial": 9, "background-pending": 15, "background-complete": 15, "background-resume": 18, "background-repair": 18 }
if (input.phase === "background-initial") {
  mkdirSync(backgroundWorkspace)
  const config = JSON.parse(readFileSync(paths.configFile, "utf8"))
  config.projects.push({ ...config.projects[0], id: input.projectId, name: "CodeBuddy background", path: backgroundWorkspace })
  writeFileSync(paths.configFile, JSON.stringify(config))
}
if (input.phase in backgroundLength) {
  for (const relative of backgroundFiles) {
    const destination = join(directory, relative)
    mkdirSync(dirname(destination), { recursive: true })
    const rows = readFileSync(new URL(`../../../../../adapters/codebuddy/src/fixtures/native-background-2.124.0/${relative}`, import.meta.url), "utf8")
      .replaceAll("/fixture/codebuddy-background-project", relative === `${backgroundId}.jsonl` ? backgroundWorkspace : workspace).trimEnd().split("\n")
    const length = relative === `${backgroundId}.jsonl` ? backgroundLength[input.phase] : input.phase === "background-pending" && relative.endsWith("agent-93604b67.jsonl") ? 1 : rows.length
    writeFileSync(destination, rows.slice(0, length).join("\n") + "\n")
  }
}
if (input.phase === "background-missing") rmSync(backgroundChild)
if (["background-edit", "background-lost"].includes(input.phase)) {
  const rows = readFileSync(backgroundChild, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
  rows.at(-1).content[0].text = input.phase === "background-edit" ? "CodeBuddyBackgroundPolicyNeedle" : "CodeBuddyBackgroundFrozenNeedle"
  writeFileSync(backgroundChild, rows.map(row => JSON.stringify(row) + "\n").join(""))
}
if (input.phase === "background-recover") for (const relative of backgroundFiles) rmSync(join(directory, relative))
const turnsChild = join(directory, turnsId, "subagents", "agent-6004ad24.jsonl")
const turnsFiles = [`${turnsId}.jsonl`, `${turnsId}/subagents/agent-6004ad24.jsonl`]
const turnsLength: Record<string, [number, number]> = {
  "turns-initial": [6, 3], "turns-pending": [11, 4], "turns-message": [11, 6],
  "turns-notices": [15, 6], "turns-resume": [20, 9], "turns-repair": [20, 9]
}
if (input.phase === "turns-initial") {
  mkdirSync(turnsWorkspace)
  const config = JSON.parse(readFileSync(paths.configFile, "utf8"))
  config.projects.push({ ...config.projects[0], id: input.projectId, name: "CodeBuddy continuation", path: turnsWorkspace })
  writeFileSync(paths.configFile, JSON.stringify(config))
}
if (input.phase in turnsLength) {
  for (const [index, relative] of turnsFiles.entries()) {
    const destination = join(directory, relative)
    mkdirSync(dirname(destination), { recursive: true })
    const rows = readFileSync(new URL(`../../../../../adapters/codebuddy/src/fixtures/native-background-turns-2.124.0/${relative}`, import.meta.url), "utf8")
      .replaceAll("/fixture/codebuddy-background-turns-project", index === 0 ? turnsWorkspace : workspace).trimEnd().split("\n")
    writeFileSync(destination, rows.slice(0, turnsLength[input.phase]![index]).join("\n") + "\n")
  }
}
if (input.phase === "turns-invalid") {
  const rows = readFileSync(file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
  const receipt = JSON.parse(rows[9].providerData.toolResult.content)
  receipt.routing.content = "Unproven delivery"
  rows[9].providerData.toolResult.content = JSON.stringify(receipt)
  save(rows)
}
if (input.phase === "turns-lost") {
  for (const relative of turnsFiles) {
    const destination = join(directory, relative)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(join(home, "frozen-turns", relative), destination)
  }
}
if (["turns-edit", "turns-lost"].includes(input.phase)) {
  const rows = readFileSync(turnsChild, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
  rows.at(-1).content[0].text = input.phase === "turns-edit" ? "CodeBuddyContinuingPolicyNeedle" : "CodeBuddyContinuingFrozenNeedle"
  writeFileSync(turnsChild, rows.map(row => JSON.stringify(row) + "\n").join(""))
}
if (input.phase === "turns-raw-only") {
  const rows = readFileSync(file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
  assert.ok(rows[12].content[0].text.includes("Duration: 2s"))
  rows[12].content[0].text = rows[12].content[0].text.replace("Duration: 2s", "Duration: 902s")
  save(rows)
  for (const relative of turnsFiles) {
    const destination = join(home, "frozen-turns", relative)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(join(directory, relative), destination)
  }
}
if (["turns-raw-recover", "turns-recover"].includes(input.phase)) for (const relative of turnsFiles) rmSync(join(directory, relative))
const emergencyChild = join(directory, emergencyId, "subagents", "agent-1fc648c0.jsonl")
const emergencyFiles = [emergencyId + ".jsonl", emergencyId + "/subagents/agent-1fc648c0.jsonl"]
const emergencyLength: Record<string, [number, number]> = {
  "emergency-initial": [6, 3], "emergency-root": [14, 8], "emergency-pending": [20, 12],
  "emergency-child": [20, 18], "emergency-resume": [25, 21], "emergency-repair": [25, 21]
}
if (input.phase === "emergency-initial") {
  mkdirSync(emergencyWorkspace)
  const config = JSON.parse(readFileSync(paths.configFile, "utf8"))
  config.projects.push({ ...config.projects[0], id: input.projectId, name: "CodeBuddy emergency compaction", path: emergencyWorkspace })
  writeFileSync(paths.configFile, JSON.stringify(config))
}
if (input.phase in emergencyLength) {
  for (const [index, relative] of emergencyFiles.entries()) {
    const destination = join(directory, relative)
    mkdirSync(dirname(destination), { recursive: true })
    const rows = readFileSync(new URL("../../../../../adapters/codebuddy/src/fixtures/native-emergency-2.124.0/" + relative, import.meta.url), "utf8")
      .replaceAll("/fixture/codebuddy-child-compact-project-000000000000000", emergencyWorkspace).trimEnd().split("\n").map(line => JSON.parse(line))
    let intent = ""
    for (const row of rows) {
      if (index !== 1) continue
      row.cwd = workspace // A foreign child CWD cannot reassign this family.
      if (row.type === "message" && row.role === "user") {
        if (!row.providerData?.isCompactInternal) intent = row.content[0].text
        else if (!row.providerData.isSummary) {
          // Relocating the controlled prompt changes its native 200-code-unit excerpt.
          const excerpt = intent.length > 200 ? intent.substring(0, 200) + "..." : intent
          row.content[0].text = 'Please continue based on the summarized context above. Your original task was: "' + excerpt + '" Maintain the same approach and level of detail.'
        }
      }
    }
    writeFileSync(destination, rows.slice(0, emergencyLength[input.phase]![index]).map(row => JSON.stringify(row) + "\n").join(""))
  }
}
if (input.phase === "emergency-invalid") {
  const rows = readFileSync(emergencyChild, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
  rows[12].content[0].text = "Unproven internal continuation"
  writeFileSync(emergencyChild, rows.map(row => JSON.stringify(row) + "\n").join(""))
}
if (input.phase === "emergency-lost") {
  for (const relative of emergencyFiles) {
    const destination = join(directory, relative)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(join(home, "frozen-emergency", relative), destination)
  }
}
if (["emergency-edit", "emergency-lost", "emergency-raw-only"].includes(input.phase)) {
  const rows = readFileSync(emergencyChild, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
  if (input.phase === "emergency-raw-only") rows[11].content[0].text = rows[11].content[0].text.replace("</conversation_history_summary>", "CodeBuddyEmergencyRawOnlyNeedle</conversation_history_summary>")
  else rows.at(-1).content[0].text = input.phase === "emergency-edit" ? "CodeBuddyEmergencyPolicyNeedle" : "CodeBuddyEmergencyFrozenNeedle"
  writeFileSync(emergencyChild, rows.map(row => JSON.stringify(row) + "\n").join(""))
  if (input.phase === "emergency-raw-only") for (const relative of emergencyFiles) {
    const destination = join(home, "frozen-emergency", relative)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(join(directory, relative), destination)
  }
}
if (["emergency-raw-recover", "emergency-recover"].includes(input.phase)) for (const relative of emergencyFiles) rmSync(join(directory, relative))
const multiSource = readFileSync(new URL("../../../../../adapters/codebuddy/src/fixtures/native-multitool-2.124.0.jsonl", import.meta.url), "utf8")
  .replaceAll("/fixture/codebuddy-multitool-project", multiWorkspace)
if (input.phase === "multi-initial") {
  mkdirSync(multiWorkspace)
  const config = JSON.parse(readFileSync(paths.configFile, "utf8"))
  config.projects.push({ ...config.projects[0], id: input.projectId, name: "CodeBuddy ordinary tools", path: multiWorkspace })
  writeFileSync(paths.configFile, JSON.stringify(config))
}
const multiLength: Record<string, number> = { "multi-initial": 4, "multi-pending": 9, "multi-complete": 11, "multi-resume": 14, "multi-repair": 14 }
if (input.phase in multiLength) writeFileSync(file, multiSource.trimEnd().split("\n").slice(0, multiLength[input.phase]).join("\n") + "\n")
if (input.phase === "multi-invalid") {
  const values = multiSource.trimEnd().split("\n").map(line => JSON.parse(line)); values[7].providerData.messageId = "foreign-response"; save(values)
}
if (input.phase === "multi-lost") writeFileSync(file, readFileSync(join(home, "frozen-multi.jsonl")))
if (["multi-edit", "multi-lost", "multi-raw-only"].includes(input.phase)) {
  const values = readFileSync(file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
  if (input.phase === "multi-raw-only") values[7].extraRawField = "CodeBuddyMultiRawOnlyNeedle"
  else values.at(-1).content[0].text = input.phase === "multi-edit" ? "CodeBuddyMultiPolicyNeedle" : "CodeBuddyMultiFrozenNeedle"
  save(values)
  if (input.phase === "multi-raw-only") cpSync(file, join(home, "frozen-multi.jsonl"))
}
if (["multi-raw-recover", "multi-recover"].includes(input.phase)) rmSync(file)
const forkFamilyOriginal = "atape-codebuddy-fork-child-root-21240"
const forkFamilyFiles = [forkFamilyId + ".jsonl", forkFamilyId + ".meta.json", forkFamilyOriginal + "/subagents/agent-97ab43b2.jsonl",
  forkFamilyOriginal + "/subagents/agent-d40e1747.jsonl", "dc73f83c-3107-474d-bb1e-13952cff1643/subagents/agent-375d1c88.jsonl"]
const forkFamilyLeaf = join(directory, forkFamilyFiles[4]!)
if (input.phase === "fork-family-initial") {
  mkdirSync(forkFamilyWorkspace)
  const config = JSON.parse(readFileSync(paths.configFile, "utf8"))
  config.projects.push({ ...config.projects[0], id: input.projectId, name: "CodeBuddy fork family", path: forkFamilyWorkspace })
  writeFileSync(paths.configFile, JSON.stringify(config))
}
const forkFamilyLength: Record<string, [number, number, number]> = {
  "fork-family-initial": [19, 5, 3], "fork-family-pending": [19, 4, 3], "fork-family-growth": [19, 9, 5],
  "fork-family-resume": [21, 9, 5], "fork-family-repair": [21, 9, 5]
}
if (input.phase in forkFamilyLength) {
  for (const [index, relative] of forkFamilyFiles.entries()) {
    const destination = join(directory, relative)
    mkdirSync(dirname(destination), { recursive: true })
    const text = readFileSync(new URL("../../../../../adapters/codebuddy/src/fixtures/native-fork-family-2.124.0/" + relative, import.meta.url), "utf8")
    if (index === 1) { writeFileSync(destination, text); continue }
    const values = text.trimEnd().split("\n").map(line => JSON.parse(line))
    // Only the fork's own original user CWD attributes this Project. Copied and child CWDs name a different configured Project.
    for (const row of values) row.cwd = index === 0 && row.sessionId === forkFamilyId ? forkFamilyWorkspace : workspace
    const length = forkFamilyLength[input.phase]!
    const count = index === 0 ? length[0] : index === 3 ? length[1] : index === 4 ? length[2] : values.length
    writeFileSync(destination, values.slice(0, count).map(row => JSON.stringify(row) + "\n").join(""))
  }
}
if (input.phase === "fork-family-lost") for (const relative of forkFamilyFiles) {
  const destination = join(directory, relative); mkdirSync(dirname(destination), { recursive: true })
  cpSync(join(home, "frozen-fork-family", relative), destination)
}
if (["fork-family-invalid", "fork-family-edit", "fork-family-raw-only", "fork-family-lost"].includes(input.phase)) {
  const values = readFileSync(forkFamilyLeaf, "utf8").trimEnd().split("\n").map(line => JSON.parse(line))
  if (input.phase === "fork-family-invalid") values[0].content[0].text = "unproven copied prompt"
  else if (input.phase === "fork-family-raw-only") values[1].extraRawField = "CodeBuddyForkFamilyRawOnlyNeedle"
  else values[2].content[0].text = input.phase === "fork-family-edit" ? "CodeBuddyForkFamilyPolicyNeedle" : "CodeBuddyForkFamilyFrozenNeedle"
  writeFileSync(forkFamilyLeaf, values.map(row => JSON.stringify(row) + "\n").join(""))
  if (input.phase === "fork-family-raw-only") for (const relative of forkFamilyFiles) {
    const destination = join(home, "frozen-fork-family", relative); mkdirSync(dirname(destination), { recursive: true })
    cpSync(join(directory, relative), destination)
  }
}
if (["fork-family-recover", "fork-family-raw-recover"].includes(input.phase)) for (const relative of forkFamilyFiles) rmSync(join(directory, relative))
if (["edit", "raw-off", "lose-activation", "raw-only"].includes(input.phase)) {
  const values = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line))
  if (input.phase === "edit") values.push(
    { id: "controlled-resume-user", parentId: values.at(-1).id, timestamp: 1789229300000, type: "message", role: "user", content: [{ type: "input_text", text: "CodeBuddyResumeNeedle SENSITIVE_TEST_TOKEN" }], sessionId: sourceId, cwd: workspace },
    { id: "controlled-resume-assistant", parentId: "controlled-resume-user", timestamp: 1789229300001, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "CodeBuddyResumeAnswer" }], sessionId: sourceId, cwd: workspace })
  if (input.phase === "raw-off") values.at(-1).content[0].text = "CodeBuddyPolicyNeedle"
  if (input.phase === "lose-activation") values.at(-1).content[0].text = "CodeBuddyFinalNeedle"
  if (input.phase === "raw-only") values.at(-1).extraRawField = "CodeBuddyRawOnlyNeedle"
  save(values)
}
if (input.phase === "recover-activation" || input.phase === "recover-raw") rmSync(file)
if (input.phase === "restore") {
  const saved = readFileSync(join(home, "saved.jsonl"), "utf8"); writeFileSync(file, saved)
}
if (input.phase === "malformed") writeFileSync(file, readFileSync(file, "utf8") + "unfinished")
if (input.phase === "repair") writeFileSync(file, readFileSync(join(home, "saved.jsonl"), "utf8"))
let lost = false, uploads = 0, puts = 0
const faultFetch: typeof fetch = async (url, init) => {
  const response = await fetch(url, init), target = String(url)
  if (init?.method === "PUT" && target.includes("/publications/attempts/")) puts++
  if (target.endsWith("/ingestion/raw/chunks")) uploads++
  if (!lost && (["fork-family-lost", "lose-activation", "fork-lost", "family-lost", "background-lost", "turns-lost", "multi-lost", "emergency-lost"].includes(input.phase) && target.endsWith("/activate") && response.status === 200 || ["fork-family-raw-only", "raw-only", "multi-raw-only", "compact-raw-only", "turns-raw-only", "emergency-raw-only"].includes(input.phase) && target.endsWith("/ingestion/raw/chunks") && response.status === 201)) {
    lost = true; await response.arrayBuffer(); throw new TypeError("Controlled committed response loss")
  }
  return response
}
const layer = Layer.merge(makeNodeClientLayer(paths, environment, fetch, faultFetch), makeNodeCollectorDaemonLayer(paths, binary, environment))
const result = await Effect.runPromise(Effect.gen(function*() {
  if (input.phase === "initial") {
    const credentials = yield* CLICredentialStore
    const credential: StoredCLICredential = { version: 1, instanceOrigin: input.origin, apiOrigin: input.origin, credential: input.credential,
      credentialId: "integration-credential", capabilityVersion: "atape-cli.v1", createdAt: at, user: { id: input.userId, displayName: "Fixture" } }
    yield* credentials.replace({ credential })
    assert.equal((yield* installAdapter(input.tarball)).adapter.adapterId, adapterId)
    yield* planToolChange([adapterId]).pipe(Effect.flatMap(applyToolChange))
  }
  if (input.phase === "upgrade") {
    const config = JSON.parse(readFileSync(paths.configFile, "utf8"))
    const slot = config.adapters.find((item: { adapterId: string }) => item.adapterId === adapterId)
    const fixture = join(home, "replacement")
    // Selected immutable package location is recorded by the management Interface.
    assert.ok(typeof slot.packageSlot === "string", "Installed package slot must be inspectable")
    cpSync(join(paths.adapterDirectory, "slots", slot.packageSlot, "node_modules", "@atape", "adapter-codebuddy"), fixture, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(fixture, "package.json"), "utf8")); manifest.version += "-codebuddy-replacement"
    writeFileSync(join(fixture, "package.json"), JSON.stringify(manifest))
    const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", home], { cwd: fixture, encoding: "utf8" }))
    assert.equal((yield* installAdapter(join(home, packed[0].filename))).adapter.version, manifest.version)
  }
  let observations = 0, failures = 0, diagnostics = 0
  // The console's Module Interfaces own setup; collection runs in the installed
  // executable. Every phase stops its owned process before inspecting the journal.
  if (["fork-family-initial", "fork-family-growth", "fork-family-resume", "multi-initial", "multi-complete", "multi-resume", "initial", "upgrade", "fork-initial", "fork-resume", "compact-initial", "compact-manual", "compact-resume", "compact-auto", "family-initial", "family-resume", "family-nested", "family-compact", "family-default", "background-initial", "background-complete", "background-resume", "turns-initial", "turns-message", "turns-notices", "turns-resume", "emergency-initial", "emergency-root", "emergency-child", "emergency-resume"].includes(input.phase)) {
    const before = (yield* inspectManagedCollector()).lastCycleCompletedAt
    const job = yield* Effect.acquireUseRelease(
      startManagedCollector({ intervalMs: 10000, concurrency: 1 }),
      () => Effect.gen(function*() {
        for (let attempt = 0; attempt < 200; attempt++) {
          const status = yield* inspectManagedCollector()
          assert.ok(status.running, "Installed Collector exited")
          assert.equal(status.collectorFailure, undefined)
          const current = status.jobs.find(job => job.adapterId === adapterId && job.projectId === input.projectId)
          if (status.lastCycleCompletedAt && status.lastCycleCompletedAt !== before && current && !current.hasMore) {
            assert.equal(current.state, "healthy", JSON.stringify(current))
            return current
          }
          yield* Effect.sleep(100)
        }
        throw new Error("Installed CodeBuddy Collector did not complete a cycle")
      }),
      () => stopManagedCollector().pipe(Effect.orDie)
    )
    assert.equal((yield* inspectManagedCollector()).running, false)
    if (input.phase === "upgrade") { assert.equal(job.canonicalBatches, 0); assert.equal(job.rawChunks, 0) }
    observations = job.observations ?? 0
  } else {
    for (let cycle = 0; cycle < 5; cycle++) {
      const report = yield* runCollectionCycle()
      failures += report.failures.length
      for (const job of report.jobs) { observations += job.observations; diagnostics += job.sourceFailures?.length ?? 0 }
      if (["fork-family-pending", "fork-family-invalid", "multi-pending", "multi-invalid", "malformed", "fork-invalid", "compact-pending", "family-invalid", "family-missing", "background-pending", "background-missing", "turns-pending", "turns-invalid", "emergency-pending", "emergency-invalid"].includes(input.phase)) { assert.ok(diagnostics > 0); break }
      if (lost || report.jobs.every(job => !job.hasMore)) break
      assert.ok(cycle < 4)
    }
  }
  if (["raw-only", "lose-activation"].includes(input.phase)) { assert.equal(lost, true); writeFileSync(join(home, "saved.jsonl"), readFileSync(file)) }
  if (["fork-family-lost", "fork-family-raw-only", "multi-raw-only", "fork-lost", "compact-raw-only", "family-lost", "background-lost", "turns-lost", "multi-lost", "emergency-lost", "turns-raw-only", "emergency-raw-only"].includes(input.phase)) assert.equal(lost, true)
  if (["fork-family-edit", "fork-family-raw-recover", "multi-edit", "multi-raw-recover", "noop", "raw-off", "recover-raw", "compact-edit", "compact-recover", "family-edit", "background-edit", "turns-edit", "turns-raw-recover", "emergency-edit", "emergency-raw-recover"].includes(input.phase)) assert.equal(uploads, 0)
  if (input.phase === "noop") { assert.equal(observations, 0); assert.equal(puts, 0) }
  if (["fork-family-reenable", "multi-reenable", "raw-on", "compact-reenable", "family-reenable", "background-reenable", "turns-reenable", "emergency-reenable"].includes(input.phase)) { assert.equal(puts, 0); assert.ok(uploads > 0) }
  const journals = yield* CaptureJournals, states = yield* CollectorStateStore
  const state = yield* states.snapshot(input.origin, input.userId, input.projectId, adapterId)
  const journal = yield* journals.open({ instanceOrigin: input.origin, userId: input.userId }, defaultSourceCollectionLimits.journal)
  assert.equal(state.installationId, journal.binding.installationId)
  const sources = yield* journal.sources(input.projectId, adapterId, { limit: 100 })
  assert.equal(sources.length, 1, "Foreign Project was captured")
  assert.equal(sources[0]!.sourceSessionId, sourceId)
  const owner = yield* journal.claim(sources[0]!), coverage = yield* journal.coverage(owner)
  const capture = (yield* journal.inspect(owner, coverage.canonicalCaptureId!, { kind: "canonical", limit: 1 })).capture
  const receipt = JSON.parse(capture.activationReceipt!) as { sessionId: string; head: string }
  const pending = yield* journal.pending(owner)
  const records = yield* journal.records(owner, capture.id, { kind: "event", limit: 100 })
  return { ...receipt, checkpoint: owner.checkpoint, observations, failures, diagnostics, uploads, puts, pending: pending.length,
    records: records.map(row => ({ key: row.key, revision: row.revision, rawReference: row.rawReference })) }
}).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(Logger.layer([]))))
process.stdout.write(JSON.stringify(result))
