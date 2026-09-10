import { readFileSync,statSync } from "node:fs"
import { mkdtemp,rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect,Layer } from "effect"
import { CaptureJournal,PublicationTransport,PublicationError,beginPublicationCapture,preparePublicationCanonical,deliverPublicationCapture,makeSecretRedactorLayer } from "capacity-application"
import { PublicationProtocol,PublicationTargetProfile } from "capacity-domain"
import { openOpenCodeCapture } from "capacity-source-capture"
import { openCodeOriginKey } from "capacity-source-origin"
import { makeCaptureJournalLayer } from "capacity-journal"
const [countArg,rawArg,mode="normal"]=process.argv.slice(2),count=Number(countArg),rawEnabled=rawArg==="on"
const dir=await mkdtemp(join(tmpdir(),"atape-capacity-case-")),sourcePath=join(dir,"source.sqlite"),journalPath=join(dir,"journal.sqlite")
const MiB=1024*1024,at="2026-09-11T00:00:00Z"
const sourceLimits={rowBytes:MiB,pageBytes:4*MiB,pageRows:100,records:100000,threads:20,durationMs:115000}
const projection={events:20000,usage:20000,pageItems:100,pageBytes:4*MiB}
const journalLimits={unitBytes:5*MiB,targetBytes:128*MiB,pendingBytes:256*MiB,unitsPerTarget:4096,recordsPerTarget:100000,metadataEntries:1000000}
const rawLimits={objectBytes:3*MiB,wireBytes:5*MiB,targetBytes:96*MiB,units:4096}
const binding={instanceOrigin:"https://capacity.example.test",userId:"synthetic-user",installationId:"synthetic-installation"}
const native=JSON.parse(readFileSync(new URL("./native-fixture.json",import.meta.url),"utf8"))
const root=native.rows.session.find((v:any)=>v.id===native.rootID),creation=native.rows.event.find((v:any)=>v.aggregate_id===native.rootID)
const scope={projectId:"synthetic-project",adapterId:"opencode",sourceSessionId:native.rootID,originKey:openCodeOriginKey(native.rootID,creation.id)}
const errorInfo=(e:any)=>({_tag:e?._tag,reason:e?.reason,message:e?.message})
const size=(p:string)=>{try{return statSync(p).size}catch{return 0}}
const files=()=>({db:size(journalPath),wal:size(journalPath+"-wal"),shm:size(journalPath+"-shm")})
const stats=()=>{const d=new DatabaseSync(journalPath,{readOnly:true});try{return{files:files(),account:d.prepare("SELECT retained_bytes,metadata_entries FROM binding").get(),tables:Object.fromEntries(["scopes","captures","units","source_record_versions","capture_records"].map(t=>[t,d.prepare(`SELECT count(*) n FROM ${t}`).get().n])),units:d.prepare("SELECT kind,count(*) units,sum(byte_count) bytes FROM units GROUP BY kind").all()}}finally{d.close()}}
function populate(n:number){const db=new DatabaseSync(sourcePath);try{if(n===1&&mode==="target-limit"||!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session'").get()){db.exec("PRAGMA foreign_keys=OFF");for(const ddl of native.ddl)db.exec(ddl);for(const row of native.rows.project??[])insert(db,"project",row);insert(db,"session",{...root,revert:null,time_updated:root.time_created+count+1000});insert(db,"event",creation)}db.exec("BEGIN");db.exec("DELETE FROM part;DELETE FROM message");const m=db.prepare("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)"),p=db.prepare("INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)");for(let i=0;i<n;i++){const id="msg_capacity_"+String(i).padStart(8,"0"),part="prt_capacity_"+String(i).padStart(8,"0"),time=root.time_created+100+i;const prefix=`观察 ${String(i).padStart(8,"0")} 🚀 `;const text=prefix+"x".repeat(1024-Buffer.byteLength(prefix));m.run(id,native.rootID,time,time,JSON.stringify({role:"user",time:{created:time},agent:"build",model:{providerID:"synthetic",modelID:"capacity"}}));p.run(part,id,native.rootID,time,time,JSON.stringify({type:"text",text,metadata:{capacityFixture:true}}))}db.exec("COMMIT")}finally{db.close()}}
function insert(db:any,t:string,row:any){const k=Object.keys(row);db.prepare(`INSERT INTO ${t} (${k.map(x=>`"${x}"`).join(",")}) VALUES (${k.map(()=>"?").join(",")})`).run(...Object.values(row))}
const caps:any={protocol:PublicationProtocol,targetProfile:PublicationTargetProfile,limits:{partBytes:4*MiB,targetBytes:128*MiB,userPendingBytes:256*MiB,parts:4096,reservations:10,reservationLifetimeMs:60000,leaseLifetimeMs:60000},statusPageSize:100,reclaimPageSize:32}
let serial=0,attempt:any,contentTransportCalls=0
const remote=Layer.succeed(PublicationTransport,PublicationTransport.of({capabilities:()=>Effect.succeed(caps),reserve:()=>Effect.sync(()=>({id:"attempt-"+(++serial),sessionId:"synthetic-session",expiresAt:at})),begin:(_:any,b:any)=>Effect.sync(()=>{attempt={...b,id:b.reservationId,sessionId:"synthetic-session",fence:serial,leaseUntil:at,expiresAt:at,state:"open",parts:0,retainedBytes:0,seal:null,validatedParts:0,candidateEvents:0,candidateUsage:0,activation:null};return structuredClone(attempt)}),status:()=>Effect.succeed(structuredClone(attempt)),renew:()=>Effect.succeed(structuredClone(attempt)),put:(_:any,_id:any,part:any)=>Effect.sync(()=>{contentTransportCalls++;attempt.parts++;attempt.retainedBytes+=part.bytes;return part}),seal:(_:any,_id:any,manifest:any)=>Effect.sync(()=>{contentTransportCalls++;attempt.state="sealed";attempt.seal=manifest;return structuredClone(attempt)}),validate:()=>Effect.sync(()=>{contentTransportCalls++;attempt.validatedParts=attempt.parts;attempt.state="validated";return structuredClone(attempt)}),activate:()=>Effect.sync(()=>{contentTransportCalls++;const receipt={head:attempt.id,sessionId:attempt.sessionId,captureId:attempt.captureId,baseHead:attempt.baseHead,fence:attempt.fence,transformVersion:attempt.transformVersion,manifest:attempt.seal,activatedAt:at};attempt.state="activated";attempt.activation=receipt;return receipt}),reject:()=>Effect.fail(new PublicationError({reason:"unavailable",message:"unexpected reject in capacity fixture"}))}))
const source=()=>openOpenCodeCapture({path:sourcePath,sessionId:native.rootID,rawEnabled,limits:sourceLimits,projection})
const authority={protocol:"atape.raw-publication.v1",teamRevision:1,userRevision:1} as const
let output:any={case:{count,rawEnabled,mode,textBytesPerEvent:1024},node:process.version,platform:process.platform,arch:process.arch,limits:{source:sourceLimits,projection,journal:journalLimits,raw:rawLimits,remote:structuredClone(caps.limits)}}
try{
 const fixtureStart=performance.now();populate(mode==="target-limit"?1:count);output.fixtureMs=performance.now()-fixtureStart
 output.result=await Effect.runPromise(Effect.gen(function*(){const j=yield* CaptureJournal;let owner=yield* j.claim(scope);let baseline:any=null
 if(mode==="target-limit"){yield* beginPublicationCapture(owner,{captureId:"baseline",baseHead:"",transformVersion:"capacity-v1",rawEnabled:false,trackRecords:true});yield* preparePublicationCanonical(owner,"baseline",{adapterVersion:"0.0.0",observedAt:at,nextCheckpoint:"baseline-head",source:source()});yield* deliverPublicationCapture(owner,"baseline",64);owner=yield* j.claim(scope);baseline={checkpoint:owner.checkpoint,coverage:yield* j.coverage(owner)};yield* Effect.sync(()=>populate(count));caps.limits.targetBytes=MiB}
 const capturedId="measured";yield* beginPublicationCapture(owner,{captureId:capturedId,baseHead:baseline?"attempt-1":"",transformVersion:"capacity-v1",rawEnabled,trackRecords:true,...(rawEnabled?{rawAuthority:authority}:{})})
 const start=performance.now();const prepared=yield* preparePublicationCanonical(owner,capturedId,{adapterVersion:"0.0.0",observedAt:at,nextCheckpoint:"measured-head",source:source(),...(rawEnabled?{rawLimits}:{})}).pipe(Effect.match({onSuccess:value=>({ok:true,value}),onFailure:error=>({ok:false,error:errorInfo(error)})}));const elapsedMs=performance.now()-start
 const capture=(yield* j.inspect(owner,capturedId,{kind:"canonical",limit:1})).capture;const coverage=yield* j.coverage(owner);const nextOwner=yield* j.claim(scope)
 return{elapsedMs,prepared,captureState:capture.state,seal:capture.seal,activationReceipt:capture.activationReceipt,baseline,coverage,checkpoint:nextOwner.checkpoint,stats:yield* Effect.sync(stats),contentTransportCalls,sourceBytes:yield* Effect.sync(()=>size(sourcePath))}
 }).pipe(Effect.provide(Layer.mergeAll(remote,makeSecretRedactorLayer(),makeCaptureJournalLayer({path:journalPath,mode:"create",binding,limits:journalLimits})))))
 output.afterClose=files()
}catch(e){output.error=errorInfo(e)}finally{output.nodeResourceUsage=process.resourceUsage();await rm(dir,{recursive:true,force:true})}
console.log(JSON.stringify(output))
