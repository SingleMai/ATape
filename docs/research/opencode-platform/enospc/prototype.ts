import { Effect } from "effect"
import { openCaptureJournal } from "atape-journal-probe-source"
import { DatabaseSync } from "node:sqlite"
import { openSync,writeSync,closeSync,fsyncSync,unlinkSync,statfsSync,existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
const path="/disk/capture.sqlite",fill="/disk/fill.bin"
const binding={instanceOrigin:"https://enospc.example.test",userId:"synthetic-user",installationId:"synthetic-installation"}
const limits={unitBytes:4*1024*1024,targetBytes:32*1024*1024,pendingBytes:64*1024*1024,unitsPerTarget:100,recordsPerTarget:1000,metadataEntries:10000}
const scope={projectId:"synthetic-project",adapterId:"synthetic-adapter",sourceSessionId:"baseline",originKey:"synthetic-origin"}
const nextScope={...scope,sourceSessionId:"next-source"}
const payload=Buffer.alloc(512*1024,0x61),newPayload=Buffer.alloc(2*1024*1024,0x62)
const sha=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex")
const fsState=()=>{const s=statfsSync("/disk");return{blockSize:s.bsize,totalBytes:s.blocks*s.bsize,availableBytes:s.bavail*s.bsize}}
const errorInfo=(e:any)=>({_tag:e?._tag,reason:e?.reason,message:e?.message,code:e?.code,errcode:e?.errcode})
const sqlErrors:any[]=[]
const originalExec=DatabaseSync.prototype.exec
DatabaseSync.prototype.exec=function(sql:string){try{return originalExec.call(this,sql)}catch(e){sqlErrors.push({method:"exec",statement:sql,...errorInfo(e),isTransaction:this.isTransaction});throw e}}
const probe=new DatabaseSync(":memory:"),statementPrototype=Object.getPrototypeOf(probe.prepare("SELECT 1")),originalRun=statementPrototype.run
statementPrototype.run=function(...args:any[]){try{return originalRun.apply(this,args)}catch(e){sqlErrors.push({method:"run",...errorInfo(e)});throw e}}
probe.close()
const snap=(j:any,o:any)=>Effect.gen(function*(){const inspected=yield* j.inspect(o,"frozen",{kind:"canonical",limit:10}),bytes=yield* j.read(o,"frozen","canonical",0);return{checkpoint:o.checkpoint,coverage:yield* j.coverage(o),capture:inspected.capture,units:inspected.units,session:yield* j.recordStatus(o,"frozen",{kind:"session",key:"baseline"}),thread:yield* j.recordStatus(o,"frozen",{kind:"thread",key:"root"}),payload:{bytes:bytes.byteLength,sha256:sha(bytes)}}})
const run=(work:any)=>Effect.runPromise(Effect.scoped(work))
const open=(mode:"create"|"open")=>openCaptureJournal({path,mode,binding,limits})
const fillDisk=()=>{const fd=openSync(fill,"wx",0o600);let written=0;let result:any;try{for(const size of[65536,4096,1]){const block=Buffer.alloc(size,0x66);for(;;){try{written+=writeSync(fd,block)}catch(e:any){if(e.code!=="ENOSPC")throw e;result={...errorInfo(e),writtenBytes:written};break}}}fsyncSync(fd)}finally{closeSync(fd)}return{...result,fs:fsState()}}
const readPhysical=()=>{const db=new DatabaseSync(path,{readOnly:true});try{return{format:db.prepare("PRAGMA user_version").get(),integrity:db.prepare("PRAGMA integrity_check").all(),binding:db.prepare("SELECT retained_bytes,metadata_entries FROM binding").get(),captures:db.prepare("SELECT id,state,activation_receipt,record_count,retained_bytes FROM captures ORDER BY id").all(),versions:db.prepare("SELECT kind,record_key,revision,fingerprint FROM source_record_versions ORDER BY kind,record_key").all()}}finally{db.close()}}
const phase=process.argv[2]
let out:any={phase,node:process.version,platform:process.platform,arch:process.arch}
try{
 if(phase==="seed")out.result=await run(Effect.gen(function*(){const j=yield* open("create"),o=yield* j.claim(scope),n=yield* j.claim(nextScope);yield* j.reserve(o,{id:"frozen",expectedCheckpoint:null,beginJson:"{}",rawEnabled:false,trackRecords:true});yield* j.record(o,"frozen",{kind:"session",key:"baseline",fingerprint:sha(Buffer.from("session-v1")),projectionVersion:"synthetic.v1"});yield* j.record(o,"frozen",{kind:"thread",key:"root",fingerprint:sha(Buffer.from("thread-v1")),projectionVersion:"synthetic.v1"});yield* j.append(o,"frozen",{kind:"canonical",ordinal:0,bytes:payload});for(const[kind,key]of[["session","baseline"],["thread","root"]])yield* j.bindRecord(o,"frozen",{kind,key},{_tag:"Unit",ordinal:0});yield* j.seal(o,"frozen",{canonicalUnits:1,rawUnits:0,nextCheckpoint:"not-activated",manifestJson:"{}",records:{canonical:{session:1,thread:1,event:0,usage:0}}});yield* j.reserve(n,{id:"new-write",expectedCheckpoint:null,beginJson:"{}",rawEnabled:false});return{before:yield* snap(j,o),fs:fsState()}}))
 else if(phase==="fill-write")out.result=await run(Effect.gen(function*(){const j=yield* open("open"),o=yield* j.claim(scope),n=yield* j.claim(nextScope);const before=yield* snap(j,o);const fillResult=yield* Effect.sync(fillDisk);const error=yield* j.append(n,"new-write",{kind:"canonical",ordinal:0,bytes:newPayload}).pipe(Effect.match({onSuccess:()=>({unexpectedSuccess:true}),onFailure:errorInfo}));const after=yield* snap(j,o).pipe(Effect.match({onSuccess:value=>value,onFailure:error=>({readFailure:errorInfo(error)})}));const next=yield* j.inspect(n,"new-write",{kind:"canonical",limit:10}).pipe(Effect.match({onSuccess:value=>value,onFailure:error=>({inspectFailure:errorInfo(error)})}));return{before,fillResult,error,sqlErrors:[...sqlErrors],after,next}}))
 else if(phase==="reopen-full")out.result=await run(Effect.gen(function*(){const j=yield* open("open"),o=yield* j.claim(scope);return yield* snap(j,o)}))
 else if(phase==="free"){out.before=fsState();unlinkSync(fill);out.after=fsState()}
 else if(phase==="recover")out.result=await run(Effect.gen(function*(){const j=yield* open("open"),o=yield* j.claim(scope),n=yield* j.claim(nextScope);const before=yield* snap(j,o);yield* j.append(n,"new-write",{kind:"canonical",ordinal:0,bytes:newPayload});yield* j.seal(n,"new-write",{canonicalUnits:1,rawUnits:0,nextCheckpoint:"still-not-activated",manifestJson:"{}"});const fresh=yield* j.read(n,"new-write","canonical",0);return{before,after:yield* snap(j,o),nextPayload:{bytes:fresh.byteLength,sha256:sha(fresh)},next:yield* j.inspect(n,"new-write",{kind:"canonical",limit:10}),fs:fsState()}}))
 else if(phase==="physical")out.result=readPhysical()
 else if(phase==="orchestrate"){const outputs=[];for(const stage of["seed","physical","fill-write","reopen-full","free","recover","physical"]){const child=spawnSync(process.execPath,[process.argv[1],stage],{encoding:"utf8",timeout:30000,maxBuffer:1024*1024});outputs.push({stage,status:child.status,signal:child.signal,stdout:child.stdout.trim(),stderr:child.stderr.trim()});if(child.error)outputs.push({childError:errorInfo(child.error)})}console.log(JSON.stringify({results:outputs}));process.exit(0)}
 else throw new Error("unknown phase")
}catch(e){out.error=errorInfo(e);out.sqlErrors=sqlErrors}
console.log(JSON.stringify(out))
