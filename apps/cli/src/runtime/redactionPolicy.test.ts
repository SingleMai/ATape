import { afterEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { loadNodeRedactionPolicy } from "./redactionPolicy.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "atape-redaction-policy-"))
  directories.push(root)
  const home = join(root, "home")
  const stateFile = join(home, "state", "collector.json")
  const configFile = join(home, "config", "redaction.json")
  const write = async (configuration: unknown) => {
    await mkdir(join(home, "config"), { recursive: true })
    await writeFile(configFile, JSON.stringify(configuration))
  }
  const load = (environment: NodeJS.ProcessEnv = {}) => Effect.runPromise(loadNodeRedactionPolicy({
    mode: "collector", atapeHome: home, stateFile, environment
  }))
  return { root, home, stateFile, configFile, write, load }
}
const custom = (pattern: string) => ({ patterns: [{ name: "internal", type: "INTERNAL", pattern }] })

describe("Node redaction policy snapshots", () => {
  it("persists a private installation identity across concurrent loads and restarts", async () => {
    const f = await fixture()
    const policies = await Promise.all(Array.from({ length: 4 }, () => f.load()))
    expect(new Set(policies.map(policy => policy.policyId)).size).toBe(1)
    expect((await f.load()).policyId).toBe(policies[0]!.policyId)
    for (const path of [`${f.stateFile}.redaction-key`, `${f.stateFile}.redaction-key.json`]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
    expect(await readdir(join(f.home, "state"))).toEqual(["collector.json.redaction-key", "collector.json.redaction-key.json"])
    expect((await Effect.runPromise(policies[0]!.prepareText("Bearer synthetic-secret-value"))).value).not.toContain("synthetic-secret-value")
  })

  it("reloads global rules between immutable snapshots and binds resolved literal values", async () => {
    const f = await fixture()
    await f.write(custom("internal-one"))
    const first = await f.load({ ATAPE_REDACT_VALUES: '["literal-one","literal-two"]' })
    const equivalent = await f.load({ ATAPE_REDACT_VALUES: '["literal-two","literal-one","literal-one"]' })
    expect(equivalent.policyId).toBe(first.policyId)
    await f.write(custom("internal-two"))
    const next = await f.load({ ATAPE_REDACT_VALUES: '["literal-one","literal-two"]' })
    expect(next.policyId).not.toBe(first.policyId)
    expect((await Effect.runPromise(first.prepareText("internal-one internal-two"))).value).toBe("[REDACTED:INTERNAL] internal-two")
    expect((await Effect.runPromise(next.prepareText("internal-one internal-two"))).value).toBe("internal-one [REDACTED:INTERNAL]")
    expect((await f.load({ ATAPE_REDACT_VALUES: '["literal-three"]' })).policyId).not.toBe(next.policyId)
  })

  it("admits ambient values by length and strictly validates explicitly configured literals", async () => {
    const f = await fixture()
    const policy = await f.load({ APP_TOKEN: "ambient-value", SHORT_KEY: "tiny", ATAPE_REDACT_VALUES: "manual-value,second-value" })
    expect((await Effect.runPromise(policy.prepareText("ambient-value manual-value second-value tiny"))).value).toBe("[REDACTED] [REDACTED] [REDACTED] tiny")
    for (const value of ['["tiny"]', "123", '["okay-value",42]']) {
      await expect(f.load({ ATAPE_REDACT_VALUES: value })).rejects.toThrow("ATAPE_REDACT_VALUES must contain")
    }
  })

  it("tests the effective global policy without creating an installation or reading its identity", async () => {
    const f = await fixture()
    const policy = await Effect.runPromise(loadNodeRedactionPolicy({ mode: "test", atapeHome: f.home, environment: {} }))
    expect((await Effect.runPromise(policy.prepareText("Bearer synthetic-secret-value"))).replacements).toBeGreaterThan(0)
    expect(await readdir(f.root)).toEqual([])
    await f.write(custom("internal-value"))
    const tested = await Effect.runPromise(loadNodeRedactionPolicy({ mode: "test", atapeHome: f.home, environment: {} }))
    expect((await Effect.runPromise(tested.prepareText("internal-value"))).value).toBe("[REDACTED:INTERNAL]")
    expect(await readdir(f.home)).toEqual(["config"])
  })

  it("rejects an invalid policy before creating persistent identity files", async () => {
    const f = await fixture()
    await f.write(custom("["))
    await expect(f.load()).rejects.toThrow("Redaction policy is invalid")
    expect(await readdir(f.home)).toEqual(["config"])
    await writeFile(f.configFile, '{"patterns":[],"patterns":[]}')
    await expect(f.load()).rejects.toThrow("Redaction policy is invalid")
    expect(await readdir(f.home)).toEqual(["config"])
  })

  it("rejects unreadable, nonregular, symlinked, oversized and malformed UTF-8 configurations with safe errors", async () => {
    const f = await fixture()
    const missing = join(f.root, "private-path-with-secret")
    await expect(Effect.runPromise(loadNodeRedactionPolicy({ mode: "test", configFile: missing, environment: {} }))).rejects.toThrow("Could not read a bounded UTF-8")
    await mkdir(join(f.home, "config"), { recursive: true })
    for (const bytes of [Buffer.from([0xff]), Buffer.alloc(128 * 1024 + 1, 32)]) {
      await writeFile(f.configFile, bytes)
      await expect(f.load()).rejects.toThrow("Could not read a bounded UTF-8")
    }
    await rm(f.configFile)
    await symlink(f.root, f.configFile)
    await expect(f.load()).rejects.toThrow("Could not read a bounded UTF-8")
    await rm(f.configFile)
    await mkdir(f.configFile)
    await expect(f.load()).rejects.toThrow("Could not read a bounded UTF-8")
    expect(await readdir(f.home)).toEqual(["config"])
  })

  it("fails closed when an established key is missing or differs from its binding", async () => {
    const f = await fixture()
    await f.load()
    const keyPath = `${f.stateFile}.redaction-key`
    const binding = await readFile(`${keyPath}.json`)
    const key = await readFile(keyPath)
    await rm(keyPath)
    await expect(f.load()).rejects.toThrow("established redaction identity key is missing")
    await expect(stat(keyPath)).rejects.toMatchObject({ code: "ENOENT" })
    await writeFile(keyPath, Buffer.alloc(32, 0), { mode: 0o600 })
    await expect(f.load()).rejects.toThrow("differs from its established binding")
    expect(await readFile(`${keyPath}.json`)).toEqual(binding)
    await writeFile(keyPath, key)
    await expect(f.load()).resolves.toHaveProperty("policyId")
    await chmod(keyPath, 0o644)
    await expect(f.load()).rejects.toThrow("Could not load the private redaction identity")
  })
})
