/** THROWAWAY: real Collector/Node state/redaction/wire, controlled loopback receiver.
 * node packages/application/prototypes/opencode-collector/probe.ts MANIFEST.json
 * Does NOT implement the selected pending/publication capability or authenticate.
 */
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync, backup } from "node:sqlite"
import { Effect, Layer, Schema } from "effect"
import { AdapterCollectionPage, emptyClientConfig, type ClientConfig } from "@atape/domain"
import { AdapterRuntimes, AdapterRuntimeError, makeSecretRedactorLayer, runCollectionCycle } from "../../src/collector.ts"
import { ClientConfigStore } from "../../src/clientManagement.ts"
import { makeCollectorStateLayer, makeCollectorTransportLayer } from "../../../../apps/cli/src/runtime/collectorLayers.ts"
import { AuthenticatedHTTPClient, AuthenticatedHTTPError } from "../../../../apps/cli/src/runtime/authenticatedHTTPClient.ts"
import { readNativePage, takeReaderMetrics } from "./reader.ts"

const io = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: error => error })
const sync = <A>(work: () => A) => Effect.try({ try: work, catch: error => error })
const stamp = "2026-09-10T06:00:00.000Z"
const secret = "controlled-secret-115"
type Settings = {
  dbPath: string; rootID: string; projectPath: string; originCwd?: string;
  ledgerPath: string; statePath: string; origin: string; maxRecordBytes?: number
}

const child = (settingsPath: string) => Effect.gen(function*() {
  const settings: Settings = JSON.parse(yield* io(() => readFile(settingsPath, "utf8")))
  const config: ClientConfig = {
    ...emptyClientConfig(), toolsConfigured: true, enabledAdapterIds: ["opencode-prototype"],
    projects: [{ id: "prototype", instanceOrigin: settings.origin, userId: "synthetic-user",
      teamId: "synthetic-team", teamSlug: "synthetic", teamName: "Synthetic", name: "PROTOTYPE",
      type: "directory", path: settings.projectPath, createdAt: stamp }],
    adapters: [{ adapterId: "opencode-prototype", packageName: "@prototype/opencode", upgradeSpec: "@prototype/opencode",
      displayName: "OpenCode prototype", version: "0.0.0", installedAt: stamp, updatedAt: stamp }]
  }
  const controlledHTTP = Layer.succeed(AuthenticatedHTTPClient, {
    request: input => Effect.tryPromise({
      try: async signal => {
        const response = await fetch(`${settings.origin}${input.path}`, {
          method: input.method, headers: { "content-type": "application/json", "x-probe-epoch": process.env.ATAPE_PROBE_EPOCH! },
          ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }), signal
        })
        return { status: response.status, body: await response.json() }
      },
      catch: () => new AuthenticatedHTTPError({ reason: "network", message: "Controlled receiver unavailable" })
    })
  })
  const pageMetrics: Array<ReturnType<typeof takeReaderMetrics>> = []
  const layers = Layer.mergeAll(
    Layer.succeed(ClientConfigStore, { transact: change => change(config).pipe(Effect.map(result => result.value)) }),
    makeCollectorStateLayer(settings.statePath), makeSecretRedactorLayer([secret]),
    makeCollectorTransportLayer().pipe(Layer.provide(controlledHTTP)),
    Layer.succeed(AdapterRuntimes, { open: () => Effect.succeed({
      collect: request => readNativePage({ ...settings, rawEnabled: request.rawCaptureEnabled !== false,
        cursor: request.cursor, observedAt: stamp, pageSize: 2 }).pipe(
        Effect.tap(() => Effect.sync(() => { pageMetrics.push(takeReaderMetrics()) })),
        Effect.flatMap(page => Schema.decodeUnknownEffect(AdapterCollectionPage)(page)),
        Effect.mapError(error => new AdapterRuntimeError({ reason: "collect", adapterId: "opencode-prototype",
          retryable: false, message: String(error) }))
      )
    }) })
  )
  const report = yield* runCollectionCycle().pipe(Effect.provide(layers))
  yield* sync(() => console.log(JSON.stringify({ report, pageMetrics, peakRssKiB: process.resourceUsage().maxRSS })))
})

type Receiver = {
  origin: string; epoch: number; rawEnabled: boolean; killAtRaw: boolean; rejectRaw: boolean; process?: ChildProcess;
  requests: Array<{ path: string; body: any }>; close: () => Promise<void>
}
const receiver = () => io(() => new Promise<Receiver>(done => {
  const state: Receiver = { origin: "", epoch: 0, rawEnabled: true, killAtRaw: false, rejectRaw: false, requests: [], close: async () => {} }
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 5 * 1024 * 1024) throw Error("oversized request")
        chunks.push(chunk)
      }
      const body = size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined
      const path = request.url ?? ""
      response.setHeader("content-type", "application/json")
      // Fault-harness fencing only: a late request from a dead child is never
      // misclassified as a restarted child's replay. This is not production auth.
      if (Number(request.headers["x-probe-epoch"]) !== state.epoch) {
        response.statusCode = 409; response.end('{}'); return
      }
      if (path.endsWith("/raw-capture")) {
        response.end(JSON.stringify({ teamPolicy: "personal", userPreference: state.rawEnabled ? "enable" : "disable", enabled: state.rawEnabled })); return
      }
      if (path.endsWith("/raw/chunks") && state.killAtRaw) {
        state.killAtRaw = false
        state.rejectRaw = true
        state.process?.kill("SIGKILL")
        response.destroy(); return
      }
      if (path.endsWith("/raw/chunks") && state.rejectRaw) { response.destroy(); return }
      state.requests.push({ path, body })
      if (path.endsWith("/canonical/batches")) {
        response.end(JSON.stringify({ sessionId: "s_prototype", sessionCreated: false, insertedEvents: body.events.length,
          updatedEvents: 0, unchangedEvents: 0, staleEvents: 0, replayed: false }))
      } else if (path.endsWith("/raw/chunks")) {
        response.end(JSON.stringify({ objectId: `r_${body.sourceObjectId}`, generation: body.generation,
          sizeBytes: body.offset + Buffer.from(body.contentBase64, "base64").length, finalized: body.final, replayed: false }))
      } else { response.statusCode = 404; response.end("{}") }
    } catch { response.destroy() }
  })
  server.listen(0, "127.0.0.1", () => {
    const address = server.address(); assert(address && typeof address !== "string")
    state.origin = `http://127.0.0.1:${address.port}`
    state.close = () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
    done(state)
  })
}))

const launch = (settingsPath: string, remote: Receiver, killed = false) => io(() => new Promise<any>((resolve, reject) => {
  remote.epoch++
  const subprocess = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", settingsPath], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ATAPE_PROBE_EPOCH: String(remote.epoch) }
  })
  remote.process = subprocess
  let out = "", err = ""
  const timer = setTimeout(() => { subprocess.kill("SIGKILL"); reject(Error("Collector probe exceeded 30s")) }, 30_000)
  subprocess.stdout.on("data", chunk => { out += chunk })
  subprocess.stderr.on("data", chunk => { err += chunk })
  subprocess.on("error", error => { clearTimeout(timer); reject(error) })
  subprocess.on("close", (code, signal) => {
    clearTimeout(timer)
    if (killed && signal === "SIGKILL") { resolve({ signal }); return }
    if (code !== 0) { reject(Error(`Collector child exit ${code}/${signal}: ${err}\n${out}`)); return }
    try { resolve(JSON.parse(out.trim().split("\n").at(-1)!)) } catch { reject(Error(`Invalid child output: ${out}\n${err}`)) }
  })
}))

const main = (manifestPath: string) => Effect.acquireUseRelease(
  io(() => mkdtemp(join(tmpdir(), "atape-opencode-collector-PROTOTYPE-"))),
  scratch => Effect.acquireUseRelease(receiver(), remote => Effect.gen(function*() {
    const manifest = JSON.parse(yield* io(() => readFile(manifestPath, "utf8")))
    const nativeDB: string = manifest.dbPath
    const rootID: string = manifest.rootID
    const projectPath: string = manifest.projectPath
    assert(nativeDB && rootID && projectPath, "Expected normalized manifest dbPath/rootID/projectPath")
    const dbPath = join(scratch, "controlled-source.db")
    yield* io(async () => {
      const source = new DatabaseSync(nativeDB, { readOnly: true })
      try { await backup(source, dbPath) } finally { source.close() }
    })
    // Only mutate this independently backed-up native fixture, never the native or personal source.
    const target = yield* sync(() => {
      const db = new DatabaseSync(dbPath)
      try {
        const row = db.prepare("SELECT id,data FROM part WHERE session_id=? AND json_extract(data,'$.type')='text' ORDER BY id LIMIT 1").get(rootID) as {id:string,data:string}|undefined
        assert(row, "Fixture requires one root text part")
        const data = JSON.parse(row.data); data.text = `SOURCE_A 中文🙂 ${secret}`; data.rawOnlyProbe = "RAW_ONLY_SENTINEL_115"
        db.prepare("UPDATE part SET data=? WHERE id=?").run(JSON.stringify(data), row.id)
        return { id: row.id, data }
      } finally { db.close() }
    })
    const settings: Settings = { dbPath, rootID, projectPath, originCwd: projectPath,
      ledgerPath: join(scratch, "ledger.db"), statePath: join(scratch, "state.json"), origin: remote.origin }
    const settingsPath = join(scratch, "settings.json")
    yield* io(() => writeFile(settingsPath, JSON.stringify(settings)))
    remote.killAtRaw = true
    const crash = yield* launch(settingsPath, remote, true)
    assert.equal(crash.signal, "SIGKILL")
    const stateAfterCrash = JSON.parse(yield* io(() => readFile(settings.statePath, "utf8")))
    assert.equal(stateAfterCrash.checkpoints.length, 0)
    const first = remote.requests.filter(r => r.path.endsWith("/canonical/batches"))
    assert(first.length >= 1 && first.some(r => JSON.stringify(r.body).includes("SOURCE_A")))
    assert(!JSON.stringify(first).includes(secret), "real redactor must mask source secret")
    assert.equal(remote.requests.filter(r => r.path.endsWith("/raw/chunks")).length, 0)
    yield* sync(() => {
      const db = new DatabaseSync(dbPath)
      try { db.prepare("UPDATE part SET data=? WHERE id=?").run(JSON.stringify({ ...target.data, text: `SOURCE_B 中文🙂 ${secret}` }), target.id) }
      finally { db.close() }
    })
    const boundary = remote.requests.length
    remote.rejectRaw = false
    const resumed = yield* launch(settingsPath, remote)
    assert.equal(resumed.report.failures.length, 0, JSON.stringify(resumed))
    const replay = remote.requests.slice(boundary)
    assert(replay.some(r => r.path.endsWith("/canonical/batches") && JSON.stringify(r.body).includes("SOURCE_B")))
    assert(!replay.some(r => r.path.endsWith("/canonical/batches") && JSON.stringify(r.body).includes("SOURCE_A")))
    const oldEvent = first.flatMap(r => r.body.events).find(e => e.text.includes("SOURCE_A"))
    const newEvent = replay.filter(r => r.path.endsWith("/canonical/batches")).flatMap(r => r.body.events).find(e => e.sourceEventId === oldEvent.sourceEventId)
    assert.equal(newEvent.occurredAt, oldEvent.occurredAt)
    assert(newEvent.revision > oldEvent.revision)
    const raw = replay.filter(r => r.path.endsWith("/raw/chunks")).map(r => Buffer.from(r.body.contentBase64,"base64").toString("utf8")).join("")
    assert(raw.includes("SOURCE_B") && !raw.includes("SOURCE_A") && !raw.includes(secret))
    const after = JSON.parse(yield* io(() => readFile(settings.statePath, "utf8")))
    assert(after.checkpoints[0].cursor && after.checkpoints[0].rawObjects.length)

    remote.rawEnabled = false
    const offSettings = { ...settings, statePath: join(scratch,"off-state.json"), ledgerPath: join(scratch,"off-ledger.db") }
    yield* io(() => writeFile(settingsPath, JSON.stringify(offSettings)))
    const offStart = remote.requests.length
    const off = yield* launch(settingsPath, remote)
    assert.equal(off.report.failures.length,0,JSON.stringify(off))
    assert(off.pageMetrics.every((m: ReturnType<typeof takeReaderMetrics>) => m.wholeDataReads === 0))
    const offRequests = remote.requests.slice(offStart)
    assert(!offRequests.some(r=>r.path.endsWith("/raw/chunks")))
    assert(!JSON.stringify(offRequests).includes("RAW_ONLY_SENTINEL_115"))
    assert(offRequests.flatMap(r=>r.body.events).every(e=>e.rawRef.type==='unavailable'))
    const offState=JSON.parse(yield* io(()=>readFile(offSettings.statePath,"utf8")))
    assert.deepEqual(offState.checkpoints[0].rawObjects,[])
    // Direct Adapter behavior: fixed key/time with another A after B is revision 3,
    // not hash ordering or a millisecond-based revision. No production publication claim.
    const pages = (options: Partial<Parameters<typeof readNativePage>[0]> = {}) => Effect.gen(function*() {
      let cursor: string | null = null
      const all: Array<typeof AdapterCollectionPage.Type> = []
      for (let count=0;count<50;count++) {
        const page: typeof AdapterCollectionPage.Type = yield* readNativePage({ ...settings, cursor, observedAt: stamp, rawEnabled: true, pageSize:2, ...options })
        all.push(page)
        if (!page.hasMore) return all
        cursor=page.nextCursor
      }
      throw Error('Reader failed to finish bounded fixture in 50 pages')
    })
    yield* sync(()=>{const db=new DatabaseSync(dbPath);try{db.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify(target.data),target.id)}finally{db.close()}})
    const backToA = yield* pages()
    const third = backToA.flatMap(p=>p.observations.flatMap(o=>o.events)).find(e=>e.sourceEventId===oldEvent.sourceEventId)
    assert(third && third.revision>newEvent.revision && third.occurredAt===oldEvent.occurredAt)
    const missingOrigin = yield* pages({originCwd:undefined})
    assert(missingOrigin.every(p=>p.observations.length===0))
    assert(missingOrigin.some(p=>p.sourceFailures?.some(f=>f.reason==='attribution')))
    const limited = yield* pages({maxRecordBytes:64})
    assert(limited.some(p=>p.sourceFailures?.some(f=>f.reason==='limit')))
    const result = {
      status: "expected existing-interface recovery gap reproduced; basic integration passed",
      runtime: process.version, sqlite: yield* sync(()=>{const db=new DatabaseSync(':memory:');try{return db.prepare('select sqlite_version() version').get()}finally{db.close()}}),
      nativeFixture: manifestPath,
      checks: ["real Collector + checkpoint + redactor + final wire + loopback HTTP", "SIGKILL after Canonical acceptance before Raw acceptance keeps cursor uncommitted",
        "same source ID/time; source A to B generates newer revision but cannot replay lost A", "Raw-off sends Canonical only, no Raw-only sentinel or fabricated receipts",
        "A to B to A reserves an increasing revision", "missing Origin is an attribution diagnostic", "oversized source values report a limit"],
      measurements: { resumed, rawOff: off },
      notProven: ["full pending target/final-wire journal", "atomic publication or production server", "package manifest/import/close", "authentication", "arbitrary source coverage, platforms or bounds"],
      sourceMutations: "Controlled native database copy; A/B, secret and unknown-field additions are synthetic perturbations, not native OpenCode actions."
    }
    yield* sync(()=>console.log(JSON.stringify(result,null,2)))
    if (process.env.ATAPE_PROTOTYPE_RESULT) yield* io(()=>writeFile(process.env.ATAPE_PROTOTYPE_RESULT!,JSON.stringify(result,null,2)+"\n"))
  }), remote => io(()=>remote.close())),
  scratch => io(()=>rm(scratch,{recursive:true,force:true}))
)

if (process.argv[2] === "--child") await Effect.runPromise(child(process.argv[3]!))
else {
  assert(process.argv[2], "Pass a controlled native fixture manifest; no personal source discovery is performed")
  await Effect.runPromise(main(resolve(process.argv[2])))
}
