import { afterEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { inspectRedactionSettings, saveRedactionSettings, validateRedactionSettings } from "@atape/application"
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { makeRedactionSettingsLayer } from "./redactionSettings.ts"
import { loadNodeRedactionPolicy } from "./redactionPolicy.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const configuration = (pattern: string) => ({ patterns: [{ name: "Internal", type: "INTERNAL", pattern }] })
const fixture = async (environment: NodeJS.ProcessEnv = {}) => {
  const root = await mkdtemp(join(tmpdir(), "atape-redaction-settings-"))
  directories.push(root)
  const home = join(root, "home")
  const configFile = environment.ATAPE_REDACTION_CONFIG_FILE ?? join(home, "config", "redaction.json")
  const layer = makeRedactionSettingsLayer({ atapeHome: home }, environment)
  const inspect = () => Effect.runPromise(inspectRedactionSettings().pipe(Effect.provide(layer)))
  const validate = (candidate: unknown) => Effect.runPromise(validateRedactionSettings(candidate).pipe(Effect.provide(layer)))
  const save = (expectedRevision: string, candidate: unknown) => Effect.runPromise(saveRedactionSettings({ expectedRevision, configuration: candidate }).pipe(Effect.provide(layer)))
  const write = async (content: string | Uint8Array) => { await mkdir(join(home, "config"), { recursive: true }); await writeFile(configFile, content) }
  return { root, home, configFile, layer, inspect, validate, save, write }
}

describe("Node redaction Settings through the public Interface", () => {
  it("inspects and validates missing defaults without creating any local files", async () => {
    const f = await fixture({ APP_TOKEN: "user-secret-value", ATAPE_REDACT_VALUES: '["user-secret-value","second-secret"]' })
    expect(await f.inspect()).toMatchObject({ configuration: { patterns: [] }, configFile: f.configFile,
      origin: "default", exists: false, literalCount: 2, validation: "valid" })
    expect(await f.validate(configuration("internal-value"))).toEqual(configuration("internal-value"))
    expect(await readdir(f.root)).toEqual([])
  })

  it("saves private normalized rules without Collector state and applies the same policy on reload", async () => {
    const f = await fixture()
    const before = await f.inspect()
    const saved = await f.save(before.revision, configuration("internal-value"))
    expect(saved).toMatchObject({ configuration: configuration("internal-value"), exists: true, validation: "valid" })
    expect(saved.revision).not.toBe(before.revision)
    expect((await f.inspect()).revision).toBe(saved.revision)
    expect((await stat(f.configFile)).mode & 0o777).toBe(0o600)
    expect(await readdir(f.home)).toEqual(["config"])
    expect(await readdir(join(f.home, "config"))).toEqual(["redaction.json"])
    const policy = await Effect.runPromise(loadNodeRedactionPolicy({ mode: "test", atapeHome: f.home, environment: {} }))
    expect((await Effect.runPromise(policy.prepareText("internal-value Bearer synthetic-secret-value"))).value).toBe("[REDACTED:INTERNAL] [REDACTED]")
    expect(await readdir(f.home)).toEqual(["config"])
  })

  it("respects an environment-selected configuration without writing the default", async () => {
    const root = await mkdtemp(join(tmpdir(), "atape-redaction-override-"))
    directories.push(root)
    const selected = join(root, "selected.json")
    await writeFile(selected, JSON.stringify(configuration("override-one")))
    const f = await fixture({ ATAPE_REDACTION_CONFIG_FILE: selected })
    const before = await f.inspect()
    expect(before).toMatchObject({ origin: "environment", configFile: selected, configuration: configuration("override-one") })
    await f.save(before.revision, configuration("override-two"))
    expect(JSON.parse(await readFile(selected, "utf8"))).toEqual(configuration("override-two"))
    expect(await readdir(f.root)).toEqual([])
  })

  it("keeps explicit missing selection an error and does not create a fallback", async () => {
    const f = await fixture({ ATAPE_REDACTION_CONFIG_FILE: join(tmpdir(), `missing-private-file-${Date.now()}.json`) })
    await expect(f.inspect()).rejects.toThrow("Could not safely read or write")
    expect(await readdir(f.root)).toEqual([])
  })

  it("allows invalid expressions to be inspected and repaired", async () => {
    const f = await fixture()
    await f.write(JSON.stringify(configuration("[")))
    const before = await f.inspect()
    expect(before).toMatchObject({ validation: "invalid", configuration: configuration("[") })
    await expect(f.validate(configuration("["))).rejects.toThrow("redaction configuration is invalid")
    expect((await f.save(before.revision, configuration("fixed-value"))).validation).toBe("valid")
  })

  it("does not overwrite damaged JSON, schema or invalid candidate rules", async () => {
    const f = await fixture()
    for (const text of ['{"patterns":', '{"patterns":[],"patterns":[]}', '{"disable_defaults":true}']) {
      await f.write(text)
      await expect(f.inspect()).rejects.toThrow("redaction configuration is invalid")
      await expect(f.save("missing", {})).rejects.toThrow()
      expect(await readFile(f.configFile, "utf8")).toBe(text)
    }
    await f.write(JSON.stringify(configuration("original-value")))
    const before = await f.inspect()
    for (const candidate of [configuration("["), { patterns: [{ name: "x", type: "X", pattern: "(x)", capture_group: 2 }] }, { disable_defaults: true }]) {
      await expect(f.save(before.revision, candidate)).rejects.toThrow("redaction configuration is invalid")
      expect(await readFile(f.configFile, "utf8")).toBe(JSON.stringify(configuration("original-value")))
    }
  })

  it("rejects stale revisions after observable external edits", async () => {
    const f = await fixture()
    await f.write(JSON.stringify(configuration("first-value")))
    const before = await f.inspect()
    await f.write(JSON.stringify(configuration("external-value")))
    await expect(f.save(before.revision, configuration("new-value"))).rejects.toThrow("Reload it before saving")
    expect(await readFile(f.configFile, "utf8")).toBe(JSON.stringify(configuration("external-value")))
  })

  it("detects replacement even when an external editor keeps identical bytes", async () => {
    const f = await fixture()
    const content = JSON.stringify(configuration("original-value"))
    await f.write(content)
    const before = await f.inspect()
    const replacement = join(f.root, "replacement.json")
    await writeFile(replacement, content)
    await rename(replacement, f.configFile)
    await expect(f.save(before.revision, configuration("new-value"))).rejects.toThrow("Reload it before saving")
    expect(await readFile(f.configFile, "utf8")).toBe(content)
  })

  it("serializes competing Settings writers so only one expected revision wins", async () => {
    const f = await fixture()
    const before = await f.inspect()
    const outcomes = await Promise.allSettled([f.save(before.revision, configuration("first-value")), f.save(before.revision, configuration("second-value"))])
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1)
    expect(await readdir(join(f.home, "config"))).toEqual(["redaction.json"])
  })

  it("rejects symlinks, nonregular, oversized and malformed UTF-8 files without leaking their paths", async () => {
    const f = await fixture()
    for (const bytes of [Buffer.from([0xff]), Buffer.alloc(128 * 1024 + 1, 32)]) {
      await f.write(bytes)
      await expect(f.inspect()).rejects.toThrow("Could not safely read or write")
      expect(await readFile(f.configFile)).toEqual(bytes)
    }
    await rm(f.configFile)
    const target = join(f.root, "private-source-value")
    await writeFile(target, "{}")
    await symlink(target, f.configFile)
    await expect(f.inspect()).rejects.toThrow("Could not safely read or write")
    expect(await readFile(target, "utf8")).toBe("{}")
    await rm(f.configFile)
    await mkdir(f.configFile)
    await expect(f.inspect()).rejects.toThrow("Could not safely read or write")
    expect(await readdir(f.home)).toEqual(["config"])
  })

  it("rejects invalid environment values and excessive rules without file mutation", async () => {
    const f = await fixture({ ATAPE_REDACT_VALUES: '["tiny"]' })
    await expect(f.inspect()).rejects.toThrow("effective redaction environment values are invalid")
    await expect(f.validate({})).rejects.toThrow("effective redaction environment values are invalid")
    expect(await readdir(f.root)).toEqual([])
    const valid = await fixture()
    await expect(valid.validate({ patterns: Array.from({ length: 129 }, () => configuration("test-value").patterns[0]) })).rejects.toThrow("redaction configuration is invalid")
    expect(await readdir(valid.root)).toEqual([])
  })
})
