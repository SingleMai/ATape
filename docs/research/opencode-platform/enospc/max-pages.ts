import { Effect } from "effect"
import { openCaptureJournal } from "atape-journal-probe-source"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp,rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
const root=await mkdtemp(join(tmpdir(),"atape-maxpages-probe-")),path=join(root,"journal.sqlite")
const binding={instanceOrigin:"https://example.test",userId:"synthetic-user",installationId:"synthetic-installation"}
const limits={unitBytes:4*1024*1024,targetBytes:8*1024*1024,pendingBytes:16*1024*1024,unitsPerTarget:100,recordsPerTarget:100,metadataEntries:1000}
const scope={projectId:"synthetic-project",adapterId:"test",sourceSessionId:"source",originKey:"origin"}
try{console.log(JSON.stringify(await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
 const j=yield* openCaptureJournal({path,mode:"create",binding,limits});const o=yield* j.claim(scope);yield* j.reserve(o,{id:"capture",expectedCheckpoint:null,beginJson:"{}",rawEnabled:false})
 const other=new DatabaseSync(path);const pages=other.prepare("PRAGMA page_count").get().page_count;const maxBefore=other.prepare("PRAGMA max_page_count").get().max_page_count
 const bounded=other.prepare(`PRAGMA max_page_count=${pages}`).get().max_page_count
 const separate=new DatabaseSync(path);const separateMax=separate.prepare("PRAGMA max_page_count").get().max_page_count;separate.close()
 const append=yield* j.append(o,"capture",{kind:"canonical",ordinal:0,bytes:Buffer.alloc(2*1024*1024,0x61)}).pipe(Effect.match({onSuccess:()=>"succeeded",onFailure:e=>({reason:e.reason,message:e.message})}))
 const finalPages=other.prepare("PRAGMA page_count").get().page_count;other.close()
 const reopened=new DatabaseSync(path);const reopenMax=reopened.prepare("PRAGMA max_page_count").get().max_page_count;reopened.close()
 return {node:process.version,platform:process.platform,arch:process.arch,initialPageCount:pages,maxBefore,otherConnectionMax:bounded,separateConnectionMax:separateMax,publicJournalAppend2MiB:append,finalPageCount:finalPages,reopenedMax:reopenMax}
})))))}finally{await rm(root,{recursive:true,force:true})}
