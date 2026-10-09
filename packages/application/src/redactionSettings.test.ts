import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { inspectRedactionSettings, RedactionConfigurationStore, RedactionSettingsError, saveRedactionSettings,
  validateRedactionSettings, type RedactionConfigurationSource } from "./redactionSettings.ts"

const configuration = (pattern: string) => ({ patterns: [{ name: "Internal", type: "INTERNAL", pattern }] })
const fixture = (content: string | undefined, secretValues: ReadonlyArray<string> = []) => {
  let source: RedactionConfigurationSource = { content, secretValues, revision: "initial", configFile: "/selected/redaction.json", origin: "default", exists: content !== undefined }
  let writes = 0
  const layer = Layer.succeed(RedactionConfigurationStore, RedactionConfigurationStore.of({
    read: () => Effect.succeed(source),
    replace: (expectedRevision, normalized) => Effect.sync(() => {
      if (source.revision !== expectedRevision) throw new Error("Test Adapter received a stale write")
      source = { ...source, content: JSON.stringify(normalized), exists: true, revision: `saved-${++writes}` }
      return source
    })
  }))
  return { layer, writes: () => writes }
}

describe("redaction Settings Interface", () => {
  it("retains schema-valid invalid expressions for repair and refuses their validation or save", async () => {
    const f = fixture(JSON.stringify(configuration("[")))
    const inspected = await Effect.runPromise(inspectRedactionSettings().pipe(Effect.provide(f.layer)))
    expect(inspected.validation).toBe("invalid")
    expect(inspected.configuration).toEqual(configuration("["))
    for (const action of [validateRedactionSettings(configuration("[")).pipe(Effect.asVoid), saveRedactionSettings({ expectedRevision: inspected.revision, configuration: configuration("[") }).pipe(Effect.asVoid)]) {
      expect(await Effect.runPromise(action.pipe(Effect.flip, Effect.provide(f.layer)))).toMatchObject({ _tag: "RedactionSettingsError", reason: "configuration" })
    }
    const saved = await Effect.runPromise(saveRedactionSettings({ expectedRevision: inspected.revision, configuration: configuration("internal-value") }).pipe(Effect.provide(f.layer)))
    expect(saved).toMatchObject({ validation: "valid", revision: "saved-1", configuration: configuration("internal-value") })
    expect(f.writes()).toBe(1)
  })

  it("reports bounded effective environment failures without exposing literal values", async () => {
    const secret = "private-invalid-secret"
    const f = fixture(undefined, Array.from({ length: 2049 }, (_, index) => `${secret}-${index}`))
    const failure = await Effect.runPromise(inspectRedactionSettings().pipe(Effect.flip, Effect.provide(f.layer)))
    expect(failure).toBeInstanceOf(RedactionSettingsError)
    expect(failure.reason).toBe("environment")
    expect(JSON.stringify(failure)).not.toContain(secret)
    expect(f.writes()).toBe(0)
  })

  it("rejects damaged current JSON and stale revisions without writing", async () => {
    const f = fixture('{"patterns":[],"patterns":[]}')
    const damaged = await Effect.runPromise(saveRedactionSettings({ expectedRevision: "initial", configuration: {} }).pipe(Effect.flip, Effect.provide(f.layer)))
    expect(damaged.reason).toBe("configuration")
    const stale = await Effect.runPromise(saveRedactionSettings({ expectedRevision: "earlier", configuration: {} }).pipe(Effect.flip, Effect.provide(f.layer)))
    expect(stale.reason).toBe("conflict")
    expect(f.writes()).toBe(0)
  })
})
