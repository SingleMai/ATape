import { rm } from "node:fs/promises"
import { CaptureJournal, PublicationTransport, beginPublicationCapture, deliverPublicationCapture,
  publicationPreparationContext } from "@atape/application"
import { type PublicationAttempt } from "@atape/domain"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { directories, fixture, scope } from "./fixtures/publication-test-support.ts"

afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

// A Test Adapter for the owned remote Interface, backed by the same durable
// SQLite journal used by delivery callers. Each delivery slice reopens it.
const validationSequence = async (f: Awaited<ReturnType<typeof fixture>>, progress: ReadonlyArray<Partial<PublicationAttempt>>) => {
  const remote = await f.run(Effect.gen(function*() { return yield* PublicationTransport }))
  const observed: PublicationAttempt[] = []
  const transport = PublicationTransport.of({ ...remote, validate: () => Effect.sync(() => {
    const next = progress[observed.length]
    if (next === undefined) throw new Error("Unexpected additional validation request")
    f.change(next)
    const attempt = f.snapshot(); observed.push(attempt)
    return attempt
  }) })
  const deliver = () => f.run(Effect.gen(function*() {
    const journal = yield* CaptureJournal
    return yield* deliverPublicationCapture(yield* journal.claim(scope), "capture", 3)
  }).pipe(Effect.provideService(PublicationTransport, transport)))
  const unchanged = () => f.run(Effect.gen(function*() {
    const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
    expect(owner.checkpoint).toBeNull()
    expect((yield* journal.inspect(owner, "capture", { kind: "canonical" })).capture.state).toBe("sealed")
    expect(yield* journal.reclaim(owner, "capture")).toBe(0)
  }))
  return { deliver, observed, unchanged }
}

describe("retained Thread publication delivery", () => {
  it("finishes wire validation, advances retained parts across recovery slices, then activates", async () => {
    const f = await fixture(); await f.prepare()
    const sequence = await validationSequence(f, [
      { state: "validating", validatedParts: 1, retainedParts: 0 },
      { state: "validating", validatedParts: 1, retainedParts: 1 },
      { state: "validating", validatedParts: 1, retainedParts: 2 },
      { state: "validated", validatedParts: 1, retainedParts: 2 }
    ])
    let activated = false
    for (let n = 0; n < 10; n++) {
      const result = await sequence.deliver()
      expect(result.operations).toBeLessThanOrEqual(3)
      if (result.state === "activated") { activated = true; break }
      expect(result.state).toBe("pending"); await sequence.unchanged()
    }
    expect(activated).toBe(true)
    expect(sequence.observed.map(attempt => [attempt.state, attempt.validatedParts, attempt.retainedParts])).toEqual([
      ["validating", 1, 0], ["validating", 1, 1], ["validating", 1, 2], ["validated", 1, 2]
    ])
    expect(f.sent).toHaveLength(1)
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      expect(owner.checkpoint).toBe("capture-next")
      const { capture } = yield* journal.inspect(owner, "capture", { kind: "canonical" })
      expect(capture.state).toBe("completed")
      expect(JSON.parse(capture.activationReceipt!).captureId).toBe("capture")
    }))
  })

  it.each([
    ["retained progress regresses", { state: "validating", validatedParts: 1, retainedParts: 1 }],
    ["wire progress regresses", { state: "validating", validatedParts: 0, retainedParts: 3 }],
    ["validation stalls", { state: "validating", validatedParts: 1, retainedParts: 2 }]
  ] satisfies ReadonlyArray<readonly [string, Partial<PublicationAttempt>]>)("preserves the sealed capture when %s", async (_, invalid) => {
    const f = await fixture(); await f.prepare()
    const sequence = await validationSequence(f, [
      { state: "validating", validatedParts: 1, retainedParts: 2 }, invalid
    ])
    for (let n = 0; sequence.observed.length === 0 && n < 6; n++) expect(await sequence.deliver()).toMatchObject({ state: "pending" })
    expect(sequence.observed).toHaveLength(1)
    await expect(sequence.deliver()).rejects.toMatchObject({ reason: "invalid_response" })
    expect(sequence.observed).toHaveLength(2)
    await sequence.unchanged(); expect(f.sent).toHaveLength(1)
  })

  it.each(["open", "sealed"] as const)("rejects a validation response returning %s even when retained progress advances", async state => {
    const f = await fixture(); await f.prepare()
    const sequence = await validationSequence(f, [{ state, validatedParts: 0, retainedParts: 1 }])
    for (let n = 0; f.snapshot().state === "open" && n < 6; n++) expect(await sequence.deliver()).toMatchObject({ state: "pending" })
    expect(f.snapshot().state).toBe("sealed")
    await expect(sequence.deliver()).rejects.toMatchObject({ reason: "invalid_response" })
    expect(sequence.observed).toHaveLength(1)
    await sequence.unchanged(); expect(f.sent).toHaveLength(1)
  })

  it("begins adoption with a baseline larger than 32 KiB while persisting only its revision floor in Begin", async () => {
    const baselineThreads = [
      { sourceThreadId: "root", revision: 900, label: "Main", summary: "", captureStatus: "complete" as const },
      ...Array.from({ length: 20 }, (_, index) => ({ sourceThreadId: `child-${index}`, parentSourceThreadId: "root", revision: 900,
        label: "Prior child", summary: "prior metadata ".repeat(200), captureStatus: "complete" as const }))
    ]
    const metadataJson = JSON.stringify({ threads: baselineThreads })
    expect(Buffer.byteLength(metadataJson)).toBeGreaterThan(32 * 1024)
    const f = await fixture(4096, {}, { v2: true, adoption: { revisionFloor: 900, baselineThreads } })
    const started = await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      return yield* beginPublicationCapture(owner, { captureId: "adoption", baseHead: "", transformVersion: "projection-v2",
        rawEnabled: false, trackRecords: true, adoptLegacy: true })
    }))
    expect(started.adoption?.baselineThreads).toEqual(baselineThreads)
    expect(f.adoptions()).toBe(1); expect(f.reservations()).toBe(0); expect(f.snapshot().state).toBe("open")
    await f.run(Effect.gen(function*() {
      const journal = yield* CaptureJournal, owner = yield* journal.claim(scope)
      const { capture } = yield* journal.inspect(owner, "adoption", { kind: "canonical" })
      expect(Buffer.byteLength(capture.beginJson)).toBeLessThan(32 * 1024)
      expect(JSON.parse(capture.beginJson).adoption).toEqual({ revisionFloor: 900 })
      expect(yield* journal.sourceMetadata(owner, null)).toBe(metadataJson)
      expect(yield* journal.recordFloor(owner)).toBe(900)
      expect((yield* publicationPreparationContext(owner, "adoption")).intent.adoption).toEqual({ revisionFloor: 900 })
    }))
  })
})
