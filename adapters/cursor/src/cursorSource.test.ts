import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { discoverCursorSources, readCursorSource, type CursorSourceLimits } from "./cursorSource.ts"

const temporaryDirectories: string[] = []
const fixtureDirectory = new URL("../fixtures/confab-derived/", import.meta.url)
const limits: CursorSourceLimits = {
  inventoryEntries: 1000, pageSources: 2, rowBytes: 16 * 1024, sourceBytes: 2 * 1024 * 1024,
  records: 10_000, subagents: 20, durationMs: 10_000
}
const user = (text: string) => ({ role: "user", message: { content: [{ type: "text", text }] } })
const lines = (rows: ReadonlyArray<unknown>) => rows.map(row => JSON.stringify(row)).join("\n") + "\n"
const sourcePath = (stateDirectory: string, workspaceSlug: string, sourceId: string) =>
  join(stateDirectory, "projects", workspaceSlug, "agent-transcripts", sourceId, `${sourceId}.jsonl`)
const addSource = async (stateDirectory: string, sourceId: string, workspaceSlug = "workspace", content = lines([user("hello")])) => {
  const path = sourcePath(stateDirectory, workspaceSlug, sourceId)
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, content)
  return path
}
const fixture = async (content?: string | Buffer) => {
  const stateDirectory = await realpath(await mkdtemp(join(tmpdir(), "atape-cursor-source-"))); temporaryDirectories.push(stateDirectory)
  const sourceId = "conversation", workspaceSlug = "workspace"
  const path = sourcePath(stateDirectory, workspaceSlug, sourceId)
  await mkdir(dirname(path), { recursive: true })
  if (content === undefined) await copyFile(new URL("conversation.jsonl", fixtureDirectory), path)
  else await writeFile(path, content)
  return { stateDirectory, sourceId, workspaceSlug, path }
}
const inspect = (f: Awaited<ReturnType<typeof fixture>>, bounds = limits) =>
  Effect.runPromise(readCursorSource({ stateDirectory: f.stateDirectory, sourceId: f.sourceId, limits: bounds }))
const discover = (stateDirectory: string, bounds = limits, cursor: string | null = null) =>
  Effect.runPromise(discoverCursorSources({ stateDirectory, cursor, limits: bounds }))

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe("Cursor candidate source reader", () => {
  it("records synthetic fixture provenance without claiming native acceptance", async () => {
    const provenance = JSON.parse(await readFile(new URL("provenance.json", fixtureDirectory), "utf8"))
    expect(provenance.kind).toBe("synthetic-derived")
    expect(provenance.nativeAuthenticatedSessionCaptured).toBe(false)
    expect(provenance.sources[0]).toMatchObject({
      ref: "8082a7ab8d3195ae8fb93545508be49bc4c8f5b7", path: "pkg/provider/cursor_test.go",
      gitBlob: "46ca9b2afb7e8ae5939a2e2898fab9ae5c5a9799"
    })
    expect(provenance.sources[1]).toMatchObject({ version: "2026.10.01-e373342", nativeRuntimeAcceptance: false })
  })

  it("discovers nested roots in pages and keeps subagents out of the root inventory", async () => {
    const f = await fixture()
    await addSource(f.stateDirectory, "second", "other-workspace")
    await addSource(f.stateDirectory, "third")
    const childPath = join(dirname(f.path), "subagents", "child.jsonl")
    await mkdir(dirname(childPath)); await writeFile(childPath, lines([user("child")]))
    await writeFile(join(dirname(dirname(f.path)), "flat.jsonl"), lines([user("unsupported flat layout")]))
    const sources = []
    let cursor: string | null = null
    for (let pageCount = 0; pageCount < 10; pageCount++) {
      const page = await discover(f.stateDirectory, { ...limits, pageSources: 1 }, cursor)
      expect(page.sources).toHaveLength(1)
      sources.push(...page.sources)
      if (page.done) break
      expect(page.cursor).not.toBeNull(); expect(page.cursor).not.toBe(cursor); cursor = page.cursor
    }
    expect(sources.map(source => source.sourceId).sort()).toEqual(["conversation", "second", "third"])
    expect(new Set(sources.map(source => source.sourceId)).size).toBe(3)
    expect(sources.find(source => source.sourceId === f.sourceId)).toEqual({ sourceId: f.sourceId, workspaceSlug: f.workspaceSlug, transcriptPath: f.path })
    const snapshot = await inspect(f)
    expect(snapshot.subagentCandidates).toEqual([{ sourceId: "child", transcriptPath: childPath }])
    expect(snapshot.records).toHaveLength(6)
  })

  it("preserves source lines, text, tool parameters and repeated messages without inventing absent facts", async () => {
    const f = await fixture(), snapshot = await inspect(f)
    const nativeLines = (await readFile(f.path, "utf8")).trimEnd().split("\n")
    expect(snapshot.origin).toEqual({ status: "unknown", reason: "creation_evidence_unavailable" })
    expect(snapshot.records.map(record => record.line)).toEqual([1, 2, 3, 4, 5, 6])
    for (const [index, record] of snapshot.records.entries()) {
      expect(record.rawJson).toBe(nativeLines[index]); expect(record.raw).toEqual(JSON.parse(nativeLines[index]!))
      expect(record.eventTime).toBeNull(); expect(record.nativeEventId).toBeNull()
    }
    const first = snapshot.records[0]!, repeated = snapshot.records[3]!
    expect(first.kind).toBe("message"); expect(repeated.kind).toBe("message")
    if (first.kind !== "message" || repeated.kind !== "message") throw new Error("expected user messages")
    expect(first.role).toBe("user"); expect(repeated.content).toEqual(first.content)
    expect(first.content).toEqual([{ type: "text", text: "<user_query>\n  Preserve 中文 🚀, tabs\tand two lines.\nSecond line stays here.  \n</user_query>" }])
    const assistant = snapshot.records[1]!
    if (assistant.kind !== "message") throw new Error("expected assistant message")
    expect(assistant.role).toBe("assistant")
    expect(assistant.content).toEqual([
      { type: "text", text: "I will write the supplied content exactly.\n" },
      { type: "tool_use", name: "write_file", toolCallId: null, input: {
        path: "notes/中文 🚀.md", content: "line one\nline two\tend  ", enabled: false, count: 0,
        nested: { items: [null, true, "$TOKEN", "`literal`"] }
      } }
    ])
    expect(snapshot.records.filter(record => record.kind === "turn_ended").map(record => record.status)).toEqual(["success", "success"])
    expect(snapshot.metadataCandidates).toEqual([])
  })

  it("keeps missing and untrusted metadata as candidates without assigning a creation origin", async () => {
    const f = await fixture()
    const metadataPath = join(f.stateDirectory, "chats", "bucket", f.sourceId, "meta.json")
    await mkdir(dirname(metadataPath), { recursive: true })
    await copyFile(new URL("meta.json", fixtureDirectory), metadataPath)
    let snapshot = await inspect(f)
    expect(snapshot.metadataCandidates).toHaveLength(1)
    expect(snapshot.metadataCandidates[0]).toMatchObject({ path: metadataPath, cwd: null, title: "Synthetic content preservation conversation", createdAtMs: 1781651890835 })
    expect(snapshot.origin.status).toBe("unknown")
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"))
    metadata.cwd = "/unproven/original/workspace"
    await writeFile(metadataPath, JSON.stringify(metadata))
    snapshot = await inspect(f)
    expect(snapshot.metadataCandidates[0]?.cwd).toBe(metadata.cwd)
    expect(snapshot.metadataCandidates[0]?.raw).toEqual(metadata)
    expect(snapshot.origin.status).toBe("unknown")
    expect(snapshot.records.every(record => record.eventTime === null)).toBe(true)
  })

  it("does not reverse workspace slugs into Project paths or merge distinct roots", async () => {
    const f = await fixture()
    await addSource(f.stateDirectory, "other", f.workspaceSlug)
    const page = await discover(f.stateDirectory)
    expect(page.sources.map(source => source.sourceId).sort()).toEqual(["conversation", "other"])
    for (const source of page.sources) {
      const snapshot = await Effect.runPromise(readCursorSource({ stateDirectory: f.stateDirectory, sourceId: source.sourceId, limits }))
      expect(snapshot.origin).toEqual({ status: "unknown", reason: "creation_evidence_unavailable" })
    }
  })

  it("retains all matching metadata candidates when independent chat buckets disagree", async () => {
    const f = await fixture()
    const candidates = [
      { bucket: "one", title: "first observed workspace", cwd: "/example/foo/bar" },
      { bucket: "two", title: "another observed workspace", cwd: "/example/foo-bar" }
    ]
    for (const candidate of candidates) {
      const path = join(f.stateDirectory, "chats", candidate.bucket, f.sourceId, "meta.json")
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify({ schemaVersion: 1, title: candidate.title, cwd: candidate.cwd }))
    }
    const snapshot = await inspect(f)
    expect(snapshot.metadataCandidates).toHaveLength(2)
    expect(snapshot.metadataCandidates.map(candidate => candidate.cwd).sort()).toEqual(candidates.map(candidate => candidate.cwd).sort())
    expect(snapshot.origin.status).toBe("unknown")
  })

  it("retains unrecognized source fields as Raw facts without adding interpreted content", async () => {
    const row = { ...user("known text"), vendorExtension: { future: [true, null, "uninterpreted"] } }
    const f = await fixture(lines([row])), snapshot = await inspect(f)
    expect(snapshot.records).toHaveLength(1)
    expect(snapshot.records[0]?.raw).toEqual(row)
    expect(snapshot.records[0]?.rawJson).toBe(JSON.stringify(row))
    const record = snapshot.records[0]!
    if (record.kind !== "message") throw new Error("expected message")
    expect(record.content).toEqual([{ type: "text", text: "known text" }])
  })

  it("reports the same source content after touch without making mtime an event timestamp or identity", async () => {
    const f = await fixture(), before = await inspect(f)
    const time = new Date("2030-01-02T03:04:05Z")
    await utimes(f.path, time, time)
    const after = await inspect(f)
    expect(after.records).toEqual(before.records)
    expect(after.source).toEqual(before.source)
    expect(after.fileObservation.sha256).toBe(before.fileObservation.sha256)
    expect(after.fileObservation.sizeBytes).toBe(before.fileObservation.sizeBytes)
    expect(after.fileObservation.modifiedAt).not.toBe(before.fileObservation.modifiedAt)
    expect(after.fileObservation.modifiedAtMeaning).toBe("filesystem_observation")
  })

  it("reads complete LF-delimited UTF-8 and preserves source files", async () => {
    const f = await fixture(lines([user("中文 🚀\r\n\t keep  ")]))
    const bytes = await readFile(f.path), before = await stat(f.path)
    const snapshot = await inspect(f)
    expect(snapshot.records[0]?.raw).toEqual(user("中文 🚀\r\n\t keep  "))
    expect(await readFile(f.path)).toEqual(bytes)
    expect((await stat(f.path)).mtimeMs).toBe(before.mtimeMs)
  })

  it.each([
    ["complete JSON without LF", Buffer.from(JSON.stringify(user("unterminated")))],
    ["partial JSON after a complete line", Buffer.from(lines([user("complete")]) + '{"role":"user"')],
    ["truncated UTF-8 tail", Buffer.concat([Buffer.from(lines([user("complete")]) + '{"role":"user","message":{"content":[{"type":"text","text":"'), Buffer.from([0xf0, 0x9f])])],
    ["invalid UTF-8 inside a terminated row", Buffer.concat([Buffer.from('{"role":"user","message":{"content":[{"type":"text","text":"'), Buffer.from([0xff]), Buffer.from('"}]}}\n')])],
    ["malformed complete JSON", Buffer.from('{"role":\n')],
    ["non-object JSON", Buffer.from("null\n")]
  ])("rejects %s instead of returning a successful partial snapshot", async (_name, bytes) => {
    const f = await fixture(bytes)
    await expect(inspect(f)).rejects.toMatchObject({ reason: "format" })
  })

  it.each([
    { type: "future_record", value: "unrecognized" },
    { role: "system", message: { content: [{ type: "text", text: "unrecognized role" }] } },
    { role: "assistant", message: { content: [{ type: "tool_result", content: "unverified shape" }] } },
    { role: "assistant", message: { content: [{ type: "image", data: "unverified image" }] } }
  ])("rejects an unsupported complete shape without silently losing its content", async row => {
    const f = await fixture(lines([user("known first row"), row]))
    await expect(inspect(f)).rejects.toMatchObject({ reason: "unsupported" })
  })

  it("rejects malformed supported content rather than coercing source values", async () => {
    const f = await fixture(lines([{ role: "user", message: { content: [{ type: "text", text: 42 }] } }]))
    await expect(inspect(f)).rejects.toMatchObject({ reason: "format" })
    await writeFile(f.path, lines([{ role: "assistant", message: { content: [{ type: "tool_use", name: 42, input: {} }] } }]))
    await expect(inspect(f)).rejects.toMatchObject({ reason: "format" })
  })

  it("enforces record, source byte, row byte, child and inventory bounds", async () => {
    const f = await fixture()
    await expect(inspect(f, { ...limits, records: 2 })).rejects.toMatchObject({ reason: "limit" })
    await expect(inspect(f, { ...limits, sourceBytes: 100 })).rejects.toMatchObject({ reason: "limit" })
    await expect(inspect(f, { ...limits, rowBytes: 100 })).rejects.toMatchObject({ reason: "limit" })
    const children = join(dirname(f.path), "subagents")
    await mkdir(children)
    await writeFile(join(children, "one.jsonl"), lines([user("one")]))
    await writeFile(join(children, "two.jsonl"), lines([user("two")]))
    await expect(inspect(f, { ...limits, subagents: 1 })).rejects.toMatchObject({ reason: "limit" })
    await expect(discover(f.stateDirectory, { ...limits, inventoryEntries: 1 })).rejects.toMatchObject({ reason: "limit" })
  })

  it("rejects malformed metadata and enforces its byte bound", async () => {
    const f = await fixture()
    const path = join(f.stateDirectory, "chats", "bucket", f.sourceId, "meta.json")
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, "{")
    await expect(inspect(f)).rejects.toMatchObject({ reason: "format" })
    await writeFile(path, JSON.stringify({ title: "x".repeat(2000) }))
    await expect(inspect(f, { ...limits, rowBytes: 1024 })).rejects.toMatchObject({ reason: "limit" })
  })

  it("bounds transcript and metadata bytes together while preserving all admitted candidates", async () => {
    const f = await fixture(lines([user("small transcript")]))
    const metadata = JSON.stringify({ schemaVersion: 1, title: "candidate".repeat(40) })
    for (const bucket of ["one", "two"]) {
      const path = join(f.stateDirectory, "chats", bucket, f.sourceId, "meta.json")
      await mkdir(dirname(path), { recursive: true }); await writeFile(path, metadata)
    }
    const transcriptBytes = (await readFile(f.path)).byteLength, metadataBytes = Buffer.byteLength(metadata)
    await expect(inspect(f, { ...limits, sourceBytes: transcriptBytes + metadataBytes })).rejects.toMatchObject({ reason: "limit" })
    const snapshot = await inspect(f, { ...limits, sourceBytes: transcriptBytes + metadataBytes * 2 })
    expect(snapshot.records).toHaveLength(1)
    expect(snapshot.metadataCandidates).toHaveLength(2)
    expect(snapshot.metadataCandidates.every(candidate => candidate.raw.title === "candidate".repeat(40))).toBe(true)
  })

  it("rejects valid JSON deeper than the structural ceiling with a typed limit", async () => {
    let nested: unknown = "leaf"
    for (let depth = 0; depth < 65; depth++) nested = { next: nested }
    const f = await fixture(lines([{ ...user("known message"), vendorExtension: nested }]))
    await expect(inspect(f)).rejects.toMatchObject({ reason: "limit" })
  })

  it("rejects valid JSON with too many structure values independently of byte and record limits", async () => {
    const f = await fixture(lines([{ ...user("known message"), vendorExtension: Array.from({ length: 100_001 }, () => null) }]))
    await expect(inspect(f, { ...limits, rowBytes: 1024 * 1024 })).rejects.toMatchObject({ reason: "limit" })
  })

  it("rejects duplicate source IDs across workspace buckets instead of choosing an arbitrary origin", async () => {
    const f = await fixture()
    await addSource(f.stateDirectory, f.sourceId, "other-workspace")
    await expect(discover(f.stateDirectory)).rejects.toMatchObject({ reason: "duplicate" })
    await expect(inspect(f)).rejects.toMatchObject({ reason: "duplicate" })
  })

  it("rejects symlink transcript files and workspace directories", async () => {
    const f = await fixture(), target = join(f.stateDirectory, "target.jsonl")
    await rename(f.path, target); await symlink(target, f.path)
    await expect(inspect(f)).rejects.toMatchObject({ reason: "unsupported" })
    await rm(f.path); await rename(target, f.path)
    const workspace = join(f.stateDirectory, "projects", f.workspaceSlug), outside = join(f.stateDirectory, "outside")
    await rename(workspace, outside); await symlink(outside, workspace)
    await expect(discover(f.stateDirectory)).rejects.toMatchObject({ reason: "unsupported" })
    await expect(inspect(f)).rejects.toMatchObject({ reason: "unsupported" })
  })

  it("rejects symlink metadata and child candidates", async () => {
    const f = await fixture()
    const metadata = join(f.stateDirectory, "chats", "bucket", f.sourceId, "meta.json")
    await mkdir(dirname(metadata), { recursive: true }); await symlink(f.path, metadata)
    await expect(inspect(f)).rejects.toMatchObject({ reason: "unsupported" })
    await rm(metadata)
    const child = join(dirname(f.path), "subagents", "child.jsonl")
    await mkdir(dirname(child)); await symlink(f.path, child)
    await expect(inspect(f)).rejects.toMatchObject({ reason: "unsupported" })
  })

  it.each(["", "/", "/."])("rejects a symlink state directory with suffix %j", async suffix => {
    const f = await fixture(), linkedState = join(f.stateDirectory, "linked-state")
    await symlink(f.stateDirectory, linkedState)
    await expect(discover(linkedState + suffix)).rejects.toMatchObject({ reason: "unsupported" })
    await expect(Effect.runPromise(readCursorSource({ stateDirectory: linkedState + suffix, sourceId: f.sourceId, limits }))).rejects.toMatchObject({ reason: "unsupported" })
  })

  it("keeps absent roots distinct from missing selected sources and rejects traversal inputs", async () => {
    const f = await fixture()
    const absent = join(f.stateDirectory, "not-installed")
    expect((await discover(absent)).sources).toEqual([])
    await expect(Effect.runPromise(readCursorSource({ stateDirectory: f.stateDirectory, sourceId: "absent", limits }))).rejects.toMatchObject({ reason: "missing" })
    for (const sourceId of ["../conversation", "/absolute", "a/b", ""]) {
      await expect(Effect.runPromise(readCursorSource({ stateDirectory: f.stateDirectory, sourceId, limits }))).rejects.toMatchObject({ reason: "invalid_input" })
    }
    await expect(discover(f.stateDirectory, { ...limits, pageSources: 0 })).rejects.toMatchObject({ reason: "invalid_input" })
  })

  it("can cancel a read and then replace and read the source again", async () => {
    const f = await fixture(lines(Array.from({ length: 5000 }, () => user("repeat"))))
    const controller = new AbortController()
    const pending = Effect.runPromise(readCursorSource({ stateDirectory: f.stateDirectory, sourceId: f.sourceId, limits }), { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toBeDefined()
    await rm(f.path); await writeFile(f.path, lines([user("replacement after cancellation")]))
    const snapshot = await inspect(f)
    expect(snapshot.records).toHaveLength(1)
    expect(snapshot.records[0]?.raw).toEqual(user("replacement after cancellation"))
  })
})
