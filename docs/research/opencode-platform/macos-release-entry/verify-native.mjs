import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.argv[3] ?? '/evidence';
const dirs=(await readdir(root)).filter(x=>x.startsWith('atape-opencode-native-11830-'));
assert.equal(dirs.length,1);
const evidence=join(root,dirs[0]), manifest=JSON.parse(await readFile(join(evidence,'manifest.json'),'utf8'));
assert.equal(manifest.officialExportMatchesAPI,true);assert.equal(manifest.officialExportMatchesSQLite,true);
assert.equal(manifest.compactionError,undefined);assert.ok(manifest.modelStubRequests.length>0);
const db=manifest.dbPath;
async function snapshot(){const result={};for(const suffix of ['', '-wal','-shm']){try{const p=db+suffix,s=await stat(p);result[suffix]={bytes:s.size,mtimeMs:s.mtimeMs,sha256:createHash('sha256').update(await readFile(p)).digest('hex')};}catch(e){if(e.code!=='ENOENT')throw e;}}return result;}
const before=await snapshot();process.env.OPENCODE_DB=db;
const packageManifest=JSON.parse(await readFile(join(dirname(process.argv[2]),'../package.json'),'utf8'));
assert.equal(packageManifest.name,'@atape/adapter-opencode');assert.equal(packageManifest.version,process.argv[4]);
assert.equal(packageManifest.atapeAdapter.sourceCapture,'atape.source-capture.v1');
const {createAtapeAdapter}=await import(pathToFileURL(process.argv[2]).href);
const lifetime=new AbortController(),signal=AbortSignal.timeout(60000);
const runtime=await createAtapeAdapter({protocolVersion:'atape.adapter.v1alpha1',adapter:{id:'opencode',version:packageManifest.version},project:{id:'controlled',type:'directory',path:manifest.projectPath},signal:lifetime.signal});
const limits={rowBytes:65536,pageBytes:262144,pageRows:1,records:1000,threads:20,durationMs:10000};
const projection={events:1000,usage:1000,pageItems:2,pageBytes:262144};
const result={package:{name:packageManifest.name,version:packageManifest.version,private:packageManifest.private??false,manifest:packageManifest.atapeAdapter},platform:process.platform,arch:process.arch,node:process.version,artifactSHA256:createHash('sha256').update(await readFile(process.argv[2])).digest('hex'),discovery:[],captures:[]};
try{
 let cursor=null,done=false,pages=0;
 while(!done&&pages++<20){const page=await runtime.sourceCapture.discover({cursor,limits,signal});assert.ok(page.sources.length<=1);assert.deepEqual(page.sourceFailures,[]);result.discovery.push(...page.sources);done=page.done;if(!done){assert.notEqual(page.cursor,cursor);cursor=page.cursor;}}
 assert.equal(done,true);assert.deepEqual(result.discovery.map(s=>s.sourceId).sort(),[manifest.rootID,manifest.forkID].sort());assert.ok(result.discovery.every(s=>s.cwd===manifest.projectPath));result.discoveryPages=pages;
 for(const name of ['root','fork']){
  const captures=[];
  for(const rawEnabled of [false,true]){
   const view=await runtime.sourceCapture.open({sourceId:manifest[name+'ID'],rawEnabled,limits,projection,signal});
   const frames=[];let done=false,pages=0;
   try{
    assert.equal(view.origin.cwd,manifest.projectPath);
    assert.deepEqual(view.threads.map(t=>t.sourceThreadId).sort(),(name==='root'?[manifest.rootID,manifest.childID]:[manifest.forkID]).sort());
    if(name==='root')assert.equal(view.threads.find(t=>t.sourceThreadId===manifest.childID).parentSourceThreadId,manifest.rootID);
    while(!done&&pages++<100){const page=await view.read(signal);assert.ok(page.frames.length<=2);assert.ok(Buffer.byteLength(JSON.stringify(page))<=projection.pageBytes);frames.push(...page.frames);done=page.done;}
    assert.equal(done,true);assert.equal(frames.flatMap(f=>f.events).length,view.target.events);assert.equal(frames.flatMap(f=>f.usage).length,view.target.usage);
    assert.equal(frames.filter(f=>f.raw!==undefined).length,rawEnabled?frames.length:0);
    if(rawEnabled){
     const raw=frames.map(f=>f.raw);
     for(const sessionName of name==='root'?['root','child']:['fork']){
      const sid=manifest[sessionName+'ID'];
      const messages=raw.filter(r=>r.session_id===sid&&r.message_id===undefined).sort((a,b)=>a.time_created-b.time_created||a.id.localeCompare(b.id));
      const hydrated=messages.map(r=>({info:{...JSON.parse(r.data),id:r.id,sessionID:r.session_id},parts:raw.filter(p=>p.message_id===r.id).sort((a,b)=>a.id.localeCompare(b.id)).map(p=>({...JSON.parse(p.data),id:p.id,sessionID:p.session_id,messageID:p.message_id}))}));
      const exported=JSON.parse(await readFile(join(evidence,'exports',sessionName+'-export.json'),'utf8'));
      assert.deepEqual(hydrated,exported.messages,sessionName+' Adapter Raw rows must equal official export');
     }
     assert.ok(raw.some(r=>typeof r.data==='string'&&r.data.includes('raw-only-unknown-字段')));
    }
    captures.push({rawEnabled,frames:frames.length,pages,origin:view.origin,threads:view.threads,target:view.target,events:frames.flatMap(f=>f.events),usage:frames.flatMap(f=>f.usage)});
   }finally{await view.close();}
  }
  assert.deepEqual(captures[0].events,captures[1].events);assert.deepEqual(captures[0].usage,captures[1].usage);
  if(name==='root'){
   assert.equal(captures[0].target.events,6);
   assert.ok(captures[0].events.some(e=>e.update.sessionUpdate==='tool_call_update'&&e.update.status==='completed'&&e.update.rawOutput.includes('native tool fixture')));
   assert.ok(captures[0].events.some(e=>e.fidelity==='derived'&&e.update.content?.text?.includes('No real model was called')));
  }
  result.captures.push({name,...{rawOff:captures[0],rawOn:captures[1]}});
 }
}finally{await runtime.close();}
const after=await snapshot();for(const suffix of ['', '-wal'])assert.deepEqual(after[suffix],before[suffix],'Adapter must not mutate database or WAL');assert.equal(after['-shm']?.sha256,before['-shm']?.sha256);result.sharedMemoryMtimeChanged=after['-shm']?.mtimeMs!==before['-shm']?.mtimeMs;
Object.assign(result,{status:'PASS',officialExportMatchesAdapterRaw:true,rawOffOnCanonicalEqual:true,databaseAndWALUnchanged:true,sharedMemoryBytesUnchanged:true,dbFilesBefore:before,dbFilesAfter:after});
await writeFile(join(root,'adapter-results.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,platform:result.platform,arch:result.arch,node:result.node,artifactSHA256:result.artifactSHA256,discoveryPages:result.discoveryPages,captures:result.captures.map(c=>({name:c.name,frames:c.rawOn.frames,target:c.rawOn.target})),officialExportMatchesAdapterRaw:true,databaseAndWALUnchanged:true,sharedMemoryBytesUnchanged:true},null,2));
