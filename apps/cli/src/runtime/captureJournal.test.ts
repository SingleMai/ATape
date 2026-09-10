import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { CaptureJournal, CaptureJournalError, type CaptureOwner } from "@atape/application"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { makeCaptureJournalLayer } from "./captureJournal.ts"

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const binding = { instanceOrigin: "https://atape.test", userId: "user", installationId: "installation" }
const scope = { projectId: "project", adapterId: "opencode", sourceSessionId: "root", originKey: "created-root" }
const bytes = (text: string) => new TextEncoder().encode(text)
const limits = { unitBytes: 128, targetBytes: 256, pendingBytes: 384, unitsPerTarget: 8 }
const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), "atape-journal-test-")); temporary.push(directory)
  return join(directory, "capture.sqlite")
}
const run = <A, E>(path: string, mode: "create" | "open", work: Effect.Effect<A, E, CaptureJournal>) =>
  Effect.runPromise(work.pipe(Effect.provide(makeCaptureJournalLayer({ path, mode, binding, limits }))))
const reason = <A>(work: Effect.Effect<A, CaptureJournalError>) => work.pipe(Effect.match({
  onFailure: error => error.reason, onSuccess: () => "unexpected-success"
}))
const reserve = (journal: CaptureJournal["Service"], owner: CaptureOwner, id = "capture", checkpoint: string | null = null, rawEnabled = true) =>
  journal.reserve(owner, { id, expectedCheckpoint: checkpoint, beginJson: '{"token":"reservation"}', rawEnabled })
const fill = (journal: CaptureJournal["Service"], owner: CaptureOwner) => Effect.gen(function*() {
  yield* reserve(journal, owner)
  yield* journal.append(owner, "capture", { kind: "canonical", ordinal: 0, bytes: bytes("Canonical A") })
  yield* journal.append(owner, "capture", { kind: "raw", ordinal: 0, bytes: bytes("Raw A") })
  yield* journal.seal(owner, "capture", { canonicalUnits: 1, rawUnits: 1, nextCheckpoint: "cursor-1", manifestJson: '{"head":"target"}' })
})

const downgradeToV3 = (db: DatabaseSync) => db.exec(`DROP TABLE capture_records; DROP TABLE source_record_versions;
  DROP INDEX known_source_scopes; ALTER TABLE captures DROP COLUMN track_records; ALTER TABLE captures DROP COLUMN record_count;
  ALTER TABLE scopes DROP COLUMN records_initialized; ALTER TABLE scopes DROP COLUMN canonical_coverage;
  DROP INDEX unactivated_source_capture; ALTER TABLE scopes DROP COLUMN observed_canonical; ALTER TABLE scopes DROP COLUMN observed_raw; PRAGMA user_version=3`)

describe("Capture journal Interface", () => {
  it("upgrades v4 after binding verification and finds the new Canonical attempt behind older Raw obligations", async () => {
    const path = await setup()
    await run(path, "create", Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      yield* fill(j, owner)
      yield* j.settle(owner, "capture", { _tag: "Activated", receiptJson: '{"head":1}' })
      yield* reserve(j, owner, "later", "cursor-1", false)
    }))
    const old = new DatabaseSync(path)
    old.exec("DROP INDEX unactivated_source_capture; PRAGMA user_version=4"); old.close()
    await expect(Effect.runPromise(CaptureJournal.pipe(Effect.provide(makeCaptureJournalLayer({ path, mode: "open",
      binding: { ...binding, userId: "other" }, limits }))))).rejects.toMatchObject({ reason: "binding" })
    const unchanged = new DatabaseSync(path)
    expect(unchanged.prepare("PRAGMA user_version").get()?.user_version).toBe(4); unchanged.close()
    await run(path, "open", Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect((yield* j.pending(owner, undefined, 1))[0]?.id).toBe("capture")
      expect((yield* j.unactivated(owner))?.id).toBe("later")
      expect(yield* j.read(owner, "capture", "raw", 0)).toEqual(bytes("Raw A"))
      expect(owner.checkpoint).toBe("cursor-1")
      const current = yield* j.claim(scope)
      expect(yield* reason(j.unactivated(owner))).toBe("conflict")
      expect(yield* reason(reserve(j, current, "competing", "cursor-1", false))).toBe("conflict")
      yield* j.settle(current, "later", { _tag: "AbandonUnsealed" })
      expect(yield* j.unactivated(current)).toBeNull()
    }))
    const upgraded = new DatabaseSync(path)
    expect(upgraded.prepare("PRAGMA user_version").get()?.user_version).toBe(5); upgraded.close()
  })
  it("verifies binding before upgrading v3 and preserves its independent Raw obligations", async () => {
    const path = await setup()
    await run(path, "create", Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      yield* fill(j, owner)
      yield* j.settle(owner, "capture", { _tag: "Activated", receiptJson: '{"head":1}' })
      yield* j.settle(owner, "capture", { _tag: "RawCancellationStarted", reason: "disabled" })
    }))
    const old = new DatabaseSync(path); downgradeToV3(old); old.close()
    await expect(Effect.runPromise(CaptureJournal.pipe(Effect.provide(makeCaptureJournalLayer({ path, mode: "open",
      binding: { ...binding, userId: "other" }, limits }))))).rejects.toMatchObject({ reason: "binding" })
    const unchanged = new DatabaseSync(path)
    expect(unchanged.prepare("PRAGMA user_version").get()?.user_version).toBe(3); unchanged.close()
    await run(path, "open", Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect(owner.checkpoint).toBe("cursor-1")
      expect((yield* j.inspect(owner, "capture", { kind: "raw" })).capture).toMatchObject({
        trackRecords: false, activationReceipt: '{"head":1}', rawCancelReason: "disabled" })
      expect(yield* j.read(owner, "capture", "raw", 0)).toEqual(bytes("Raw A"))
      expect(yield* j.coverage(owner)).toEqual({ canonicalCaptureId: null, observedCanonicalCaptureId: null, observedRawCaptureId: null })
      expect(yield* j.sources(scope.projectId, scope.adapterId, {})).toEqual([scope])
    }))
  })
  it("upgrades v2 without changing existing bytes, receipts, or publication purpose", async () => {
    const path = await setup()
    await run(path, "create", Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope); yield* fill(j, owner)
      yield* j.settle(owner, "capture", { _tag: "Activated", receiptJson: '{"head":1}' })
    }))
    const db = new DatabaseSync(path)
    downgradeToV3(db)
    db.exec("ALTER TABLE captures DROP COLUMN purpose; PRAGMA user_version=2"); db.close()
    await run(path, "open", Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      const page = yield* j.inspect(owner, "capture", { kind: "raw" })
      expect(page.capture).toMatchObject({ purpose: "publication", activationReceipt: '{"head":1}', state: "activated" })
      expect(owner.checkpoint).toBe("cursor-1")
      expect(yield* j.read(owner, "capture", "raw", 0)).toEqual(bytes("Raw A"))
    }))
  })
  it("migrates a bound v1 journal and persists Canonical receipts without advancing coverage or GC", async () => {
    const path = await setup()
    await run(path,"create",Effect.gen(function*(){ const j=yield* CaptureJournal; yield* fill(j,yield* j.claim(scope)) }))
    const db = new DatabaseSync(path)
    downgradeToV3(db)
    db.exec("ALTER TABLE captures DROP COLUMN purpose; DROP INDEX pending_units; PRAGMA user_version=1"); db.close()
    await run(path,"open",Effect.gen(function*(){
      const j=yield* CaptureJournal, owner=yield* j.claim(scope)
      expect(j.binding).toEqual(binding)
      yield* j.settle(owner,"capture",{_tag:"CanonicalAcknowledged",ordinal:0,receiptJson:'{"ordinal":0}'})
      expect((yield* j.inspect(owner,"capture",{kind:"canonical",pendingOnly:true})).units).toEqual([])
      expect(yield* j.reclaim(owner,"capture")).toBe(0)
      expect(owner.checkpoint).toBeNull()
    }))
    await run(path,"open",Effect.gen(function*(){
      const j=yield* CaptureJournal, owner=yield* j.claim(scope)
      expect(owner.checkpoint).toBeNull()
      expect((yield* j.inspect(owner,"capture",{kind:"canonical"})).units[0]).toMatchObject({disposition:"acknowledged",retained:true,receiptJson:'{"ordinal":0}'})
      expect(yield* reason(j.settle(owner,"capture",{_tag:"CanonicalAcknowledged",ordinal:0,receiptJson:'{"ordinal":1}'}))).toBe("conflict")
      expect(yield* j.read(owner,"capture","canonical",0)).toEqual(bytes("Canonical A"))
    }))
  })
  it("recovers exactly the sealed bytes in a fresh runtime and preserves unfinished Raw", async () => {
    const path = await setup()
    await run(path, "create", Effect.gen(function*() { const j = yield* CaptureJournal; yield* fill(j, yield* j.claim(scope)) }))
    await run(path, "open", Effect.gen(function*() {
      const j = yield* CaptureJournal, owner = yield* j.claim(scope)
      expect(owner.checkpoint).toBeNull()
      expect(new TextDecoder().decode(yield* j.read(owner,"capture","canonical",0))).toBe("Canonical A")
      expect(yield* reason(j.read(owner,"capture","raw",0))).toBe("state")
      yield* j.settle(owner,"capture",{ _tag:"Activated",receiptJson:'{"head":1}' })
      expect(yield* j.reclaim(owner,"capture")).toBe(1)
      expect(new TextDecoder().decode(yield* j.read(owner,"capture","raw",0))).toBe("Raw A")
    }))
    await run(path,"open",Effect.gen(function*(){
      const j=yield* CaptureJournal, owner=yield* j.claim(scope)
      expect(owner.checkpoint).toBe("cursor-1")
      yield* j.settle(owner,"capture",{_tag:"RawAcknowledged",ordinal:0,receiptJson:'{"offset":5}'})
      expect(yield* j.reclaim(owner,"capture")).toBe(1)
      expect(yield* j.pending(owner)).toEqual([])
    }))
  })
  it("rejects incomplete seals, changed identities, and body replacement on retry", async()=>{
    const path=await setup()
    await run(path,"create",Effect.gen(function*(){
      const j=yield* CaptureJournal, owner=yield* j.claim(scope)
      yield* reserve(j,owner)
      yield* j.append(owner,"capture",{kind:"canonical",ordinal:0,bytes:bytes("A")})
      expect(yield* reason(j.read(owner,"capture","canonical",0))).toBe("state")
      expect(yield* reason(j.seal(owner,"capture",{canonicalUnits:2,rawUnits:0,nextCheckpoint:"next",manifestJson:"{}"}))).toBe("state")
      expect(yield* reason(j.append(owner,"capture",{kind:"canonical",ordinal:0,bytes:bytes("B")}))).toBe("conflict")
      expect(yield* reason(j.reserve(owner,{id:"capture",expectedCheckpoint:null,beginJson:'{"different":1}',rawEnabled:true}))).toBe("conflict")
      expect(yield* j.reclaim(owner,"capture")).toBe(0)
      yield* j.settle(owner,"capture",{_tag:"AbandonUnsealed"})
      expect(yield* j.reclaim(owner,"capture")).toBe(1)
    }))
  })
  it("fences old owners including reclamation and refuses changed Origin",async()=>{
    const path=await setup()
    await run(path,"create",Effect.gen(function*(){
      const j=yield* CaptureJournal, old=yield* j.claim(scope)
      yield* fill(j,old)
      const current=yield* j.claim(scope)
      expect(yield* reason(j.read(old,"capture","canonical",0))).toBe("conflict")
      expect(yield* reason(j.reclaim(old,"capture"))).toBe("conflict")
      expect(yield* reason(j.claim({...scope,originKey:"guessed-origin"}))).toBe("binding")
      expect((yield* j.pending(current)).length).toBe(1)
    }))
  })
  it("does not roll a later checkpoint back when an old activation is replayed",async()=>{
    const path=await setup()
    await run(path,"create",Effect.gen(function*(){
      const j=yield* CaptureJournal, owner=yield* j.claim(scope)
      yield* fill(j,owner)
      yield* j.settle(owner,"capture",{_tag:"Activated",receiptJson:'{"head":1}'})
      yield* reserve(j,owner,"later","cursor-1",false)
      yield* j.append(owner,"later",{kind:"canonical",ordinal:0,bytes:bytes("B")})
      yield* j.seal(owner,"later",{canonicalUnits:1,rawUnits:0,nextCheckpoint:"cursor-2",manifestJson:"{}"})
      yield* j.settle(owner,"later",{_tag:"Activated",receiptJson:'{"head":2}'})
      yield* j.settle(owner,"capture",{_tag:"Activated",receiptJson:'{"head":1}'})
      expect((yield* j.claim(scope)).checkpoint).toBe("cursor-2")
    }))
  })
  it("rejects Raw in disabled captures; cancellation cannot fabricate a receipt",async()=>{
    const path=await setup()
    await run(path,"create",Effect.gen(function*(){
      const j=yield* CaptureJournal, owner=yield* j.claim(scope)
      yield* reserve(j,owner,"off",null,false)
      expect(yield* reason(j.append(owner,"off",{kind:"raw",ordinal:0,bytes:bytes("secret")}))).toBe("state")
      yield* j.settle(owner,"off",{_tag:"AbandonUnsealed"})
      yield* fill(j,owner)
      yield* j.settle(owner,"capture",{_tag:"Activated",receiptJson:'{"head":1}'})
      yield* j.settle(owner,"capture",{_tag:"RawCanceled",reason:"policy disabled"})
      const canceled=yield* j.inspect(owner,"capture",{kind:"raw"})
      expect(canceled.capture.rawCancelReason).toBe("policy disabled")
      expect(canceled.units[0]).toMatchObject({disposition:"canceled",receiptJson:null})
      expect(yield* reason(j.read(owner,"capture","raw",0))).toBe("state")
      expect(yield* j.reclaim(owner,"capture")).toBe(2)
      // A later genuine receipt may still be recorded; cancellation is not one.
      yield* j.settle(owner,"capture",{_tag:"RawAcknowledged",ordinal:0,receiptJson:'{"offset":5}'})
      expect((yield* j.inspect(owner,"capture",{kind:"raw"})).units[0]).toMatchObject({disposition:"acknowledged",receiptJson:'{"offset":5}',retained:false})
      expect(yield* reason(j.settle(owner,"capture",{_tag:"RawAcknowledged",ordinal:0,receiptJson:'{"offset":6}'}))).toBe("conflict")
    }))
  })
  it("applies global byte backpressure without evicting another capture",async()=>{
    const path=await setup()
    await run(path,"create",Effect.gen(function*(){
      const j=yield* CaptureJournal, a=yield* j.claim(scope), b=yield* j.claim({...scope,sourceSessionId:"other"})
      yield* reserve(j,a); yield* reserve(j,b)
      for(let n=0;n<2;n++)yield* j.append(a,"capture",{kind:"canonical",ordinal:n,bytes:new Uint8Array(128)})
      yield* j.append(b,"capture",{kind:"canonical",ordinal:0,bytes:new Uint8Array(128)})
      expect(yield* reason(j.append(b,"capture",{kind:"canonical",ordinal:1,bytes:new Uint8Array(1)}))).toBe("capacity")
      expect((yield* j.pending(a))[0]?.retainedBytes).toBe(256)
      yield* j.settle(a,"capture",{_tag:"AbandonUnsealed"}); yield* j.reclaim(a,"capture",1)
      yield* j.append(b,"capture",{kind:"canonical",ordinal:1,bytes:new Uint8Array(1)})
    }))
  })
  it("never silently recreates a missing journal or accepts a different installation",async()=>{
    const path=await setup()
    await expect(run(path,"open",CaptureJournal)).rejects.toMatchObject({reason:"missing"})
    await run(path,"create",Effect.gen(function*(){ const j=yield* CaptureJournal; yield* j.claim(scope) }))
    await expect(Effect.runPromise(CaptureJournal.pipe(Effect.provide(makeCaptureJournalLayer({path,mode:"open",binding:{...binding,installationId:"other"},limits}))))).rejects.toMatchObject({reason:"binding"})
    await expect(run(path,"create",CaptureJournal)).rejects.toMatchObject({reason:"conflict"})
  })
  it.each([false,true])("cancels Raw independently of activation (sealed=%s)",async(sealed)=>{
    const path=await setup()
    await run(path,"create",Effect.gen(function*(){
      const j=yield* CaptureJournal, owner=yield* j.claim(scope)
      yield* reserve(j,owner)
      yield* j.append(owner,"capture",{kind:"canonical",ordinal:0,bytes:bytes("A")})
      yield* j.append(owner,"capture",{kind:"raw",ordinal:0,bytes:bytes("private")})
      if(sealed) yield* j.seal(owner,"capture",{canonicalUnits:1,rawUnits:1,nextCheckpoint:"next",manifestJson:"{}"})
      yield* j.settle(owner,"capture",{_tag:"RawCanceled",reason:"disabled before activation"})
      expect(yield* j.reclaim(owner,"capture")).toBe(1)
      expect(yield* reason(j.append(owner,"capture",{kind:"raw",ordinal:1,bytes:bytes("more")}))).toBe("state")
    }))
    await run(path,"open",Effect.gen(function*(){
      const j=yield* CaptureJournal, owner=yield* j.claim(scope)
      const snapshot=yield* j.inspect(owner,"capture",{kind:"raw"})
      expect(snapshot.capture).toMatchObject({activationReceipt:null,retainedBytes:1,rawCancelReason:"disabled before activation"})
      expect(snapshot.units[0]).toMatchObject({disposition:"canceled",receiptJson:null,retained:false})
      if(!sealed) yield* j.seal(owner,"capture",{canonicalUnits:1,rawUnits:1,nextCheckpoint:"next",manifestJson:"{}"})
      expect(yield* j.read(owner,"capture","canonical",0)).toEqual(bytes("A"))
      yield* j.settle(owner,"capture",{_tag:"Activated",receiptJson:"{}"})
      expect((yield* j.pending(owner))[0]?.state).toBe("completed")
      yield* j.reclaim(owner,"capture")
      expect(yield* j.pending(owner)).toEqual([])
    }))
  })
  it("retains a sealed attempt until authoritative rejection then permits recapture without advancing its checkpoint",async()=>{
    const path=await setup()
    await run(path,"create",Effect.gen(function*(){
      const j=yield* CaptureJournal, owner=yield* j.claim(scope)
      yield* fill(j,owner)
      expect(yield* reason(j.settle(owner,"capture",{_tag:"AbandonUnsealed"}))).toBe("state")
      expect(yield* j.reclaim(owner,"capture")).toBe(0)
      yield* j.settle(owner,"capture",{_tag:"Rejected",receiptJson:'{"terminal":"not-activated"}'})
      expect(yield* reason(j.settle(owner,"capture",{_tag:"Activated",receiptJson:"{}"}))).toBe("state")
    }))
    await run(path,"open",Effect.gen(function*(){
      const j=yield* CaptureJournal, owner=yield* j.claim(scope)
      expect(owner.checkpoint).toBeNull()
      expect((yield* j.pending(owner))[0]?.state).toBe("abandoned")
      expect((yield* j.inspect(owner,"capture",{kind:"canonical"})).capture.rejectionReceipt).toBe('{"terminal":"not-activated"}')
      yield* reserve(j,owner,"new-attempt")
      expect(yield* j.reclaim(owner,"capture")).toBe(2)
    }))
  })
  it("pages bounded metadata after reclamation and preserves original identities",async()=>{
    const path=await setup()
    await run(path,"create",Effect.gen(function*(){
      const j=yield* CaptureJournal, owner=yield* j.claim(scope)
      yield* reserve(j,owner)
      for(let n=0;n<3;n++) yield* j.append(owner,"capture",{kind:"canonical",ordinal:n,bytes:bytes(String(n))})
      yield* j.settle(owner,"capture",{_tag:"AbandonUnsealed"})
      expect(yield* j.reclaim(owner,"capture",1)).toBe(1)
      const first=yield* j.inspect(owner,"capture",{kind:"canonical",limit:1})
      expect(first.units).toHaveLength(1)
      expect(first.units[0]).toMatchObject({ordinal:0,retained:false,byteCount:1})
      const later=yield* j.inspect(owner,"capture",{kind:"canonical",afterOrdinal:0,limit:2})
      expect(later.units.map(unit=>unit.ordinal)).toEqual([1,2])
      expect(yield* reason(j.append(owner,"capture",{kind:"canonical",ordinal:0,bytes:bytes("changed")}))).toBe("conflict")
    }))
  })
  it("fails closed on a corrupt journal",async()=>{
    const path=await setup()
    await writeFile(path,"not a sqlite database")
    await expect(run(path,"open",CaptureJournal)).rejects.toMatchObject({reason:"corrupt"})
  })
  it("fences an already-open connection after a second runtime takes ownership",async()=>{
    const path=await setup()
    await run(path,"create",Effect.gen(function*(){
      const first=yield* CaptureJournal, old=yield* first.claim(scope)
      yield* fill(first,old)
      yield* Effect.promise(()=>run(path,"open",Effect.gen(function*(){
        const second=yield* CaptureJournal, current=yield* second.claim(scope)
        yield* second.settle(current,"capture",{_tag:"Activated",receiptJson:"{}"})
      })))
      expect(yield* reason(first.read(old,"capture","raw",0))).toBe("conflict")
      expect(yield* reason(first.settle(old,"capture",{_tag:"RawCanceled",reason:"stale policy"}))).toBe("conflict")
      expect(yield* reason(first.reclaim(old,"capture"))).toBe("conflict")
      const current=yield* first.claim(scope)
      expect(current.checkpoint).toBe("cursor-1")
      expect(yield* first.read(current,"capture","raw",0)).toEqual(bytes("Raw A"))
    }))
  })
  it("recovers committed activation and pending Raw after SIGKILL without a finalizer",async()=>{
    const path=await setup()
    const implementation=new URL("./captureJournal.ts",import.meta.url).href
    const script=`
      import { Effect } from 'effect';
      import { CaptureJournal } from '@atape/application';
      import { makeCaptureJournalLayer } from ${JSON.stringify(implementation)};
      await Effect.runPromise(Effect.gen(function*(){
        const j=yield* CaptureJournal, owner=yield* j.claim(${JSON.stringify(scope)});
        yield* j.reserve(owner,{id:'capture',expectedCheckpoint:null,beginJson:'{}',rawEnabled:true});
        yield* j.append(owner,'capture',{kind:'canonical',ordinal:0,bytes:new TextEncoder().encode('Canonical A')});
        yield* j.append(owner,'capture',{kind:'raw',ordinal:0,bytes:new TextEncoder().encode('Raw A')});
        yield* j.seal(owner,'capture',{canonicalUnits:1,rawUnits:1,nextCheckpoint:'cursor-1',manifestJson:'{}'});
        yield* j.settle(owner,'capture',{_tag:'Activated',receiptJson:'{"head":1}'});
        process.stdout.write('READY');
        yield* Effect.never;
      }).pipe(Effect.provide(makeCaptureJournalLayer(${JSON.stringify({path,mode:"create",binding,limits})}))));`
    const child=spawn(process.execPath,["--input-type=module","-e",script],{stdio:["ignore","pipe","pipe"]})
    await new Promise<void>((resolve,reject)=>{
      let output="", errors="", killed=false
      const timeout=setTimeout(()=>{ child.kill("SIGKILL"); reject(new Error(`Child did not become ready: ${errors}`)) },15_000)
      child.stderr.on("data",chunk=>{ errors+=chunk.toString() })
      child.stdout.on("data",chunk=>{
        output+=chunk.toString()
        if(output.includes("READY")&&!killed){ killed=true; child.kill("SIGKILL") }
      })
      child.on("error",error=>{clearTimeout(timeout);reject(error)})
      child.on("close",(_code,signal)=>{
        clearTimeout(timeout)
        if(killed&&signal==="SIGKILL")resolve()
        else reject(new Error(`Child exited before kill: ${errors}`))
      })
    })
    await run(path,"open",Effect.gen(function*(){
      const j=yield* CaptureJournal, owner=yield* j.claim(scope)
      expect(owner.checkpoint).toBe("cursor-1")
      const snapshot=yield* j.inspect(owner,"capture",{kind:"raw"})
      expect(snapshot.capture.activationReceipt).toBe('{"head":1}')
      expect(snapshot.units[0]).toMatchObject({disposition:"pending",receiptJson:null,retained:true})
      expect(yield* j.read(owner,"capture","raw",0)).toEqual(bytes("Raw A"))
      expect(yield* j.reclaim(owner,"capture")).toBe(1)
    }))
  },20_000)
})
