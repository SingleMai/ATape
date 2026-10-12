import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFile, chmod, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { build } from "esbuild"
import { AdapterCollectionLimits } from "../../../packages/domain/src/collector.ts"
import { releaseBundleURL, releaseCatalogURL, mergeMigrationReleaseBundle, mergeReleaseBundle, migrationReleaseBundleSection, releaseBundleSection,
  mergeTargetReleaseBundle, targetReleaseBundleSection } from "../../../packages/domain/src/releaseCatalog.ts"

const execute = promisify(execFile)
const packages = ["@atape/cli", "@atape/adapter-codex", "@atape/adapter-claude", "@atape/adapter-opencode",
  "@atape/adapter-codebuddy", "@atape/adapter-kimi", "@atape/adapter-grok", "@atape/adapter-cursor"]
export const codexClockBaselineIntegrities = {
  "@atape/cli": "sha512-w47H6TUqDg9bWLLKvYQ8J6jgMz0zT3MLs/wzKy9ZFCkkoM+2iReNUneYEeDM/YNHb3xzKP2pbrD1jdRcCQeehw==",
  "@atape/adapter-codex": "sha512-caOzjllMYtbhyM4dU99AodrNrl48X63f3NedW09otADLyCiR5IpkpLMnNp6DOpLqiXvYVgOBs7Zha0O61RGlEw=="
}
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`
const json = async file => JSON.parse(await readFile(file, "utf8"))
const missing = cause => cause.code === "ENOENT"
const optionalBytes = file => readFile(file).catch(cause => { if (missing(cause)) return undefined; throw cause })
const alive = pid => { try { process.kill(pid, 0); return true } catch (cause) { if (cause.code === "ESRCH") return false; throw cause } }
const waitFor = async (check, description, timeout = 120_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error(description)
}
const lines = records => records.map(record => JSON.stringify(record)).join("\n") + "\n"
const item = (id, type, text, timestamp) => ({ timestamp, type: "event_msg", payload: { type: "item_completed",
  thread_id: "clock-session", item: { id, type, content: [{ type: type === "UserMessage" ? "input_text" : "output_text", text }] } } })

/** Actual published old parent and exact candidate npm archives, in a fresh HOME.
 * Test Adapters replace only remote distribution/Server HTTP and OS registration;
 * the real CLI, updater, source reader, Collector and state Interfaces execute. */
export async function verifyCodexClockUpgrade(releaseDirectory, fixtureDirectory, baselineCLI, baselineCodex, version, featureRelease) {
  for (const [name, path] of [["@atape/cli", baselineCLI], ["@atape/adapter-codex", baselineCodex]]) {
    assert.equal(integrity(await readFile(path)), codexClockBaselineIntegrities[name], `Requires the exact npm-published ${name}@0.5.9 archive`)
  }
  await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 })
  const root = await realpath(fixtureDirectory)
  const realNpm = (await execute("which", ["npm"], { encoding: "utf8" })).stdout.trim()
  assert.ok(realNpm.startsWith("/"))
  const loadPackages = async (directory, releaseVersion) => {
  const checksumLines = (await readFile(join(directory,"SHA256SUMS"),"utf8")).trim().split("\n")
  const checksums = new Map(checksumLines.map(line => {
    const match=/^([a-f0-9]{64})  ([A-Za-z0-9.-]+\.tgz)$/.exec(line)
    assert.ok(match,"Release checksums must identify bounded archive filenames")
    return [match[2],match[1]]
  }))
  assert.equal(checksums.size,packages.length)
  assert.equal(checksumLines.length,packages.length)
  const publicPackages = {}
  for (const name of packages) {
    const archive = await realpath(join(directory, `${name.replace(/^@/, "").replaceAll("/", "-")}-${releaseVersion}.tgz`))
    const manifest = JSON.parse((await execute("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8", maxBuffer: 256 * 1024 })).stdout)
    assert.equal(manifest.name, name); assert.equal(manifest.version, releaseVersion)
    const bytes = await readFile(archive)
    assert.equal(sha256(bytes),checksums.get(`${name.replace(/^@/, "").replaceAll("/", "-")}-${releaseVersion}.tgz`),"Clock transition requires the exact checksummed candidate archives")
    publicPackages[name] = { archive, manifest: { ...manifest, dist: { integrity: integrity(bytes),
      tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${releaseVersion}.tgz` } } }
  }
  return publicPackages
  }
  const publicPackages = await loadPackages(releaseDirectory, version)
  const candidateProfile = publicPackages["@atape/adapter-codex"].manifest.atapeAdapter.legacyCanonicalProfile
  const cliManifest = publicPackages["@atape/cli"].manifest
  const channel = cliManifest.atapeRuntime.releaseChannel
  assert.ok(["legacy-bridge", "target-owned"].includes(channel), "Clock transition requires an explicit packaged publication channel")
  assert.equal(channel, "legacy-bridge", "A target-owned clock candidate requires the genuine retained bridge leg; it cannot publish a legacy descriptor")
  assert.equal(candidateProfile, channel === "legacy-bridge" ? "atape.acp-centered.v3" : "atape.acp-centered.v5", "Clock projection must match the actual release channel")
  const candidateProjection = channel === "legacy-bridge" ? 5 : 7
  const bundle = { protocol: "atape.release-bundle.v2", version, captureStateContract: cliManifest.atapeRuntime.stateContract,
    updateControlProtocol: cliManifest.atapeRuntime.updateControlProtocol, migration: cliManifest.atapeRuntime.captureMigration,
    packages: packages.map(name => ({ name, ...publicPackages[name].manifest.dist })) }
  const legacyBundle = { ...bundle, protocol: "atape.release-bundle.v1" }; delete legacyBundle.migration
  const catalog = mergeMigrationReleaseBundle(undefined, bundle), legacyCatalog = mergeReleaseBundle(undefined, legacyBundle)
  let releaseBody = migrationReleaseBundleSection(bundle) + "\n" + releaseBundleSection(legacyBundle)
  let feature, bridgeTarget
  if (featureRelease) {
    assert.equal(version, "0.5.11", "The historical clock bridge must be the retained published .11 release")
    assert.equal(cliManifest.atapeRuntime.updateTargetProtocol, "atape.update-target.v1")
    bridgeTarget = { protocol: "atape.release-bundle.v3", version,
      captureStateContract: cliManifest.atapeRuntime.stateContract, updateControlProtocol: cliManifest.atapeRuntime.updateControlProtocol,
      updateTargetProtocol: cliManifest.atapeRuntime.updateTargetProtocol,
      fromCaptureStateContracts: cliManifest.atapeRuntime.fromCaptureStateContracts, packages: bundle.packages }
    releaseBody += "\n" + targetReleaseBundleSection(bridgeTarget)
    const artifacts = await loadPackages(featureRelease.directory, featureRelease.version), manifest = artifacts["@atape/cli"].manifest
    assert.equal(manifest.atapeRuntime.releaseChannel, "target-owned")
    assert.equal(manifest.atapeRuntime.updateTargetProtocol, "atape.update-target.v1")
    assert.equal(artifacts["@atape/adapter-codex"].manifest.atapeAdapter.legacyCanonicalProfile, "atape.acp-centered.v5")
    const target = { protocol: "atape.release-bundle.v3", version: featureRelease.version,
      captureStateContract: manifest.atapeRuntime.stateContract, updateControlProtocol: manifest.atapeRuntime.updateControlProtocol,
      updateTargetProtocol: manifest.atapeRuntime.updateTargetProtocol, fromCaptureStateContracts: manifest.atapeRuntime.fromCaptureStateContracts,
      packages: packages.map(name => ({ name, ...artifacts[name].manifest.dist })) }
    feature = { version: featureRelease.version, bundle: target, packages: artifacts, releaseBody: targetReleaseBundleSection(target),
      catalog: mergeTargetReleaseBundle(mergeTargetReleaseBundle(undefined, bridgeTarget), target) }
  }
  const publicRelease = join(root, "public-release.json")
  const distribution = { bundle, legacyBundle, catalog, legacyCatalog, releaseBody, packages: publicPackages, feature, clockOffsetMs: 0,
    ...(bridgeTarget ? { bridgeTarget, targetCatalog: mergeTargetReleaseBundle(undefined, bridgeTarget), featureAdvertised: false } : {}) }
  await writeFile(publicRelease, JSON.stringify({ ...distribution, serverVersion:"0.5.9", minimumCLIVersion:"0.5.9" }))
  const prefix = join(root, "prefix"), home = join(root, "home"), userHome = join(root, "user")
  const globalRoot = join(prefix, "lib", "node_modules"), bootstrap = join(globalRoot, "@atape", "cli", "dist", "atape.js")
  const trace = join(root, "entries.jsonl"), requests = join(root, "requests.jsonl"), calls = join(root, "npm.jsonl"), native = join(root, "native.jsonl")
  const captures = join(root, "captures.jsonl"), rawCaptures = join(root, "raw-captures.jsonl")
  const preload = join(root, "owned-external-adapters.mjs")
  await writeFile(preload, String.raw`import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import { basename } from "node:path";
import { syncBuiltinESMExports } from "node:module";
const root = ${JSON.stringify(root)}, entry = process.argv[1];
if (entry?.startsWith(root + "/")) appendFileSync(${JSON.stringify(trace)}, JSON.stringify({entry,args:process.argv.slice(2),pid:process.pid,
  sha256:createHash("sha256").update(readFileSync(entry)).digest("hex")})+"\n");
for (const method of ["execFile", "execFileSync", "spawn", "spawnSync"]) {
  const original=childProcess[method];
  childProcess[method]=function(file,...args) {
    if (["launchctl","systemctl","open","xdg-open","rundll32"].includes(basename(file))) {
      appendFileSync(${JSON.stringify(native)},JSON.stringify({method,file,args:args[0],rejected:true})+"\n");
      throw new Error("Native OS registration/browser commands are forbidden in isolated transition acceptance");
    }
    return Reflect.apply(original,this,[file,...args]);
  };
}
syncBuiltinESMExports();
const realNow=Date.now;
Date.now=()=>realNow()+(JSON.parse(readFileSync(${JSON.stringify(publicRelease)},"utf8")).clockOffsetMs??0);
const realFetch = globalThis.fetch;
const saved = file => existsSync(file) ? readFileSync(file,"utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
globalThis.fetch=async (input,init)=> {
 const address=String(input);
 if(address.startsWith("data:"))return realFetch(input,init);
 const fixture=JSON.parse(readFileSync(${JSON.stringify(publicRelease)},"utf8"));
 appendFileSync(${JSON.stringify(requests)},JSON.stringify({address,pid:process.pid})+"\n");
 if(address===${JSON.stringify(releaseCatalogURL("atape.update-catalog.v3"))})return fixture.bridgeTarget?
  Response.json(fixture.featureAdvertised?fixture.feature.catalog:fixture.targetCatalog):new Response(null,{status:404});
 if(address===${JSON.stringify(releaseBundleURL(version,"atape.release-bundle.v3"))})return fixture.bridgeTarget?Response.json(fixture.bridgeTarget):new Response(null,{status:404});
 if(fixture.feature&&address===${JSON.stringify(feature && releaseBundleURL(feature.version,"atape.release-bundle.v3"))})return fixture.featureAdvertised?Response.json(fixture.feature.bundle):new Response(null,{status:404});
 if(fixture.feature&&${JSON.stringify(feature ? [releaseBundleURL(feature.version,"atape.release-bundle.v1"),releaseBundleURL(feature.version,"atape.release-bundle.v2")] : [])}.includes(address))return new Response(null,{status:404});
 for (const protocol of ["atape.release-bundle.v2","atape.release-bundle.v1"]) {
   const migration=protocol.endsWith("v2");
   const catalogURL=migration?${JSON.stringify(releaseCatalogURL("atape.update-catalog.v2"))}:${JSON.stringify(releaseCatalogURL("atape.update-catalog.v1"))};
   const versionURL=migration?${JSON.stringify(releaseBundleURL(version,"atape.release-bundle.v2"))}:${JSON.stringify(releaseBundleURL(version,"atape.release-bundle.v1"))};
   if(address===catalogURL)return Response.json(migration?fixture.catalog:fixture.legacyCatalog);
   if(address===versionURL)return Response.json(migration?fixture.bundle:fixture.legacyBundle);
 }
 if(address==="https://api.github.com/repos/SingleMai/ATape/releases/latest")return Response.json({tag_name:${JSON.stringify(`v${version}`)},prerelease:false,draft:false,published_at:"2026-10-12T00:00:00Z"});
 if(address===${JSON.stringify(`https://api.github.com/repos/SingleMai/ATape/releases/tags/v${version}`)})return Response.json({tag_name:${JSON.stringify(`v${version}`)},prerelease:false,draft:false,published_at:"2026-10-12T00:00:00Z",body:fixture.releaseBody});
 if(fixture.feature&&address==="https://api.github.com/repos/SingleMai/ATape/releases/tags/v"+fixture.feature.version)return Response.json({tag_name:"v"+fixture.feature.version,prerelease:false,draft:false,published_at:"2026-10-12T00:00:00Z",body:fixture.feature.releaseBody});
 const allPackages=[...Object.values(fixture.packages),...Object.values(fixture.feature?.packages??{})];
 const artifact=allPackages.find(item=>item.manifest.dist.tarball===address);
 if(artifact)return new Response(readFileSync(artifact.archive));
 const url=new URL(address), path=decodeURIComponent(url.pathname);
 if(url.origin==="https://registry.npmjs.org") {
  for(const item of allPackages)if(path==="/"+item.manifest.name+"/"+item.manifest.version)return Response.json(item.manifest);
  for(const [name,item] of Object.entries(fixture.packages))if(path==="/"+name+"/latest")return Response.json(item.manifest);
  for(const [name,item] of Object.entries(fixture.feature?.packages??{}))if(path==="/"+name+"/atape-managed")return Response.json(item.manifest);
 }
 if(url.origin==="https://upgrade-fixture.invalid") {
  if(path==="/api/v1/instance")return Response.json({protocol:"atape.instance.v1",instance_origin:url.origin,web_origin:url.origin,api_origin:url.origin,
   protocols:["atape-cli.v1"],release_version:fixture.serverVersion,auth_epoch:"auth-v1",minimum_cli_version:fixture.minimumCLIVersion});
  if(new Headers(init?.headers).get("authorization")!=="Bearer atc_v1_synthetic_upgrade_credential")throw Error("Fixture Server requires the installed credential");
  if(path==="/api/v1/ingestion/canonical/capabilities") {
   const requested=(new Headers(init?.headers).get("ATape-Accept-Canonical-Profile")??"").split(",").map(item=>item.trim());
   return Response.json({protocol:"atape.canonical-capabilities.v1",canonicalProfiles:["atape.acp-centered.v2","atape.acp-centered.v3","atape.acp-centered.v4",...(requested.includes("atape.acp-centered.v5")?["atape.acp-centered.v5"]:[])]});
  }
  if(path==="/api/v1/publications/capabilities")return Response.json({status:503,code:"unavailable"},{status:503});
  if(path==="/api/v1/projects/upgrade-project/raw-capture")return Response.json({teamPolicy:"personal",userPreference:"enable",enabled:true});
  if(path==="/api/v1/users/me")return Response.json({id:"upgrade-user",displayName:"Upgrade fixture"});
  if(path==="/api/v1/ingestion/canonical/batches") {
   const body=JSON.parse(init.body);
   if(!["atape.acp-centered.v2","atape.acp-centered.v3","atape.acp-centered.v4","atape.acp-centered.v5"].includes(body.canonicalProfileVersion))throw Error("Unsupported Canonical profile");
   if(body.canonicalProfileVersion==="atape.acp-centered.v2"&&(body.session.updatedAt===null||body.events.some(event=>event.occurredAt===null)))throw Error("Legacy v2 cannot claim nullable clocks");
   appendFileSync(${JSON.stringify(captures)},JSON.stringify(body)+"\n");
   return Response.json({sessionId:"s_clock_fixture",sessionCreated:saved(${JSON.stringify(captures)}).length===1,insertedEvents:body.events.length,updatedEvents:0,unchangedEvents:0,staleEvents:0,replayed:false},{status:201});
  }
  if(path==="/api/v1/ingestion/raw/chunks") {
   const body=JSON.parse(init.body), previous=saved(${JSON.stringify(rawCaptures)});
   const content=Buffer.from(body.contentBase64,"base64");
   if(createHash("sha256").update(content).digest("hex")!==body.sha256)throw Error("Raw digest mismatch");
   const duplicate=previous.find(item=>item.sourceObjectId===body.sourceObjectId&&item.generation===body.generation&&item.sourceChunkId===body.sourceChunkId);
   if(duplicate&&JSON.stringify(duplicate)!==JSON.stringify(body))throw Error("Raw retry changed acknowledged receipt metadata");
   if(!duplicate) {
    const same=previous.filter(item=>item.sourceObjectId===body.sourceObjectId&&item.generation===body.generation);
    const size=same.length?same.at(-1).offset+Buffer.from(same.at(-1).contentBase64,"base64").length:0;
    if(size!==body.offset)throw Error("Raw upload skipped or rewound receipt offset");
    appendFileSync(${JSON.stringify(rawCaptures)},JSON.stringify(body)+"\n");
   }
   return Response.json({objectId:"r_clock_fixture",generation:body.generation,sizeBytes:body.offset+content.length,finalized:body.final,replayed:!!duplicate},{status:201});
  }
 }
 throw new Error("Unexpected external request in clock transition acceptance: "+address);
};
`)
  const bin = join(root, "bin"); await mkdir(bin, { recursive: true })
  await writeFile(join(bin, "npm"), String.raw`#!/usr/bin/env node
const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process"),crypto=require("node:crypto"),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+"\n");
if(args[0]==="root"&&args.includes("--global"))console.log(${JSON.stringify(globalRoot)});
else if(args[0]==="prefix"&&args.includes("--global"))console.log(${JSON.stringify(prefix)});
else if(args[0]==="config"&&args[1]==="get"&&args[2]==="registry")console.log("https://registry.npmjs.org/");
else if(args[0]==="install") {
 if(!args.includes("--ignore-scripts"))throw Error("Lifecycle scripts must remain disabled");
 const destination=args[args.indexOf("--prefix")+1];
 if(!destination?.startsWith(${JSON.stringify(root + "/")}))throw Error("npm install escaped isolated root");
 const archive=args.find(value=>/\.tgz$/.test(value)&&fs.existsSync(value.replace(/^file:/,"")))?.replace(/^file:/,"");
 if(!archive)throw Error("Production acquisition must supply an exact downloaded archive");
 const fixture=JSON.parse(fs.readFileSync(${JSON.stringify(publicRelease)},"utf8"));
 const digest="sha512-"+crypto.createHash("sha512").update(fs.readFileSync(archive)).digest("base64");
 const match=fixture.bundle.packages.find(item=>item.integrity===digest);
 const featureMatch=fixture.feature?.bundle.packages.find(item=>item.integrity===digest);
 if(!match&&!featureMatch&&digest!==${JSON.stringify(codexClockBaselineIntegrities["@atape/adapter-codex"])})throw Error("Unverified npm archive");
 if(args.includes("--global")&&(destination!==${JSON.stringify(prefix)}||match?.name!=="@atape/cli"))throw Error("Invalid global install");
 cp.execFileSync(${JSON.stringify(realNpm)},["install",...(args.includes("--global")?["--global"]:[]),"--prefix",destination,archive,"--offline","--ignore-scripts","--engine-strict","--no-audit","--no-fund"],
  {env:{...process.env,PATH:process.env.CODEX_CLOCK_ORIGINAL_PATH,NODE_OPTIONS:""},stdio:"pipe",timeout:120000});
} else throw Error("Unexpected npm operation: "+JSON.stringify(args));
`)
  await chmod(join(bin, "npm"), 0o755)
  const environment = { PATH: `${bin}:${process.env.PATH}`, HOME: userHome, TMPDIR: root,
    LANG: "en_US.UTF-8", ATAPE_LANG: "en", ATAPE_HOME: home, ATAPE_BOOTSTRAP_ENTRY: bootstrap, ATAPE_RUNTIME_DIRECT: "1",
    XDG_CONFIG_HOME: join(root,"xdg-config"), XDG_DATA_HOME: join(root,"xdg-data"), XDG_STATE_HOME: join(root,"xdg-state"),
    ATAPE_CLAUDE_HOME: join(root,"absent-claude"), ATAPE_CODEX_HOME: join(root,"codex"), ATAPE_GROK_HOME: join(root,"absent-grok"),
    ATAPE_KIMI_HOME: join(root,"absent-kimi"), ATAPE_CODEBUDDY_HOME: join(root,"absent-codebuddy"), OPENCODE_DB: join(root,"absent-opencode.db"),
    ATAPE_REDACT_VALUES:"[]", npm_config_prefix:prefix, npm_config_cache:join(root,"npm-cache"),
    npm_config_userconfig:join(root,"npm-user.conf"), npm_config_globalconfig:join(root,"npm-global.conf"),
    TOOL_UPGRADE_NODE:process.execPath, CODEX_CLOCK_ORIGINAL_PATH:process.env.PATH, NODE_OPTIONS:`--import=${pathToFileURL(preload).href}` }
  for (const directory of [userHome,home,join(environment.ATAPE_CODEX_HOME,"sessions"),join(environment.ATAPE_CODEX_HOME,"archived_sessions"),join(root,"workspace")]) await mkdir(directory,{recursive:true,mode:0o700})
  const source = join(environment.ATAPE_CODEX_HOME,"sessions","clock.jsonl")
  await writeFile(source,lines([{timestamp:"2026-10-11T00:00:00Z",type:"session_meta",payload:{id:"clock-session",session_id:"clock-session",timestamp:"2026-10-11T00:00:00Z",cwd:join(root,"workspace"),source:{},git:{}}},
    item("clock-user","UserMessage","A source input with a recorded clock","2026-10-11T00:00:01Z"),
    item("clock-unknown","AgentMessage","A source answer without a valid clock","invalid-source-clock"),
    item("clock-answer","AgentMessage","A later recorded answer","2026-10-11T00:00:02Z"),
    { timestamp: "2026-10-11T00:00:02Z", type: "event_msg", payload: { type: "item_completed", thread_id: "clock-session",
      item: { id: "clock-files", type: "CommandExecution", command: "cat src/main.ts && rg needle src", exit_code: 0,
        parsed_cmd: [{ type: "read", path: "src/main.ts" }, { type: "search", path: "src" }] } } }]))
  for (const file of [environment.npm_config_userconfig,environment.npm_config_globalconfig]) await writeFile(file,"",{mode:0o600})
  const npm = args => execute(realNpm,args,{cwd:root,env:{...environment,PATH:process.env.PATH,NODE_OPTIONS:""},encoding:"utf8",timeout:120_000,maxBuffer:4*1024*1024})
  await npm(["install","--global","--prefix",prefix,baselineCLI,"--offline","--ignore-scripts","--no-audit","--no-fund"])
  await npm(["install","--prefix",join(home,"releases","0.5.9"),baselineCLI,"--offline","--ignore-scripts","--no-audit","--no-fund"])
  const entryHash = sha256(await readFile(bootstrap))
  assert.equal((await json(join(dirname(dirname(bootstrap)),"package.json"))).version,"0.5.9")
  const helper = join(root,"caller.mjs")
  await build({entryPoints:[fileURLToPath(new URL("../src/runtime/fixtures/codex-clock-bootstrap-transition.ts",import.meta.url))],outfile:helper,bundle:true,
    // This helper only inspects or starts the selected installed executable. Its
    // identity remains capable of reading the final feature's execution floor.
    platform:"node",format:"esm",target:"node24",define:{__ATAPE_CLI_VERSION__:JSON.stringify(feature?.version ?? version),__ATAPE_CAPTURE_STATE_CONTRACT__:JSON.stringify("atape.client.v3-capture.v2"),"process.env.NODE_ENV":'"production"'},
    banner:{js:'import { createRequire as __atapeCreateRequire } from "node:module"; const require = __atapeCreateRequire(import.meta.url);'},logLevel:"silent"})
  const requestFile = join(root,"caller-request.json")
  const invoke = async phase => {
    await writeFile(requestFile,JSON.stringify({phase,root,baselineCodexTarball:await realpath(baselineCodex),bootstrap,version}))
    const result=await execute(process.execPath,[helper,requestFile],{cwd:root,env:environment,encoding:"utf8",timeout:120_000,maxBuffer:4*1024*1024})
    return JSON.parse(result.stdout)
  }
  const terminal = fileURLToPath(new URL("verify-codex-clock-upgrade-terminal.py",import.meta.url))
  const pty = (phase, expectedVersion = version) => execute("python3",[terminal,bootstrap,root,phase,expectedVersion],{cwd:root,env:environment,encoding:"utf8",timeout:180_000,maxBuffer:2*1024*1024})
  const entries = async()=> (await optionalBytes(trace))?.toString("utf8").split("\n").filter(Boolean).map(JSON.parse) ?? []
  const captured = async file => (await optionalBytes(file))?.toString("utf8").split("\n").filter(Boolean).map(JSON.parse) ?? []
  const protectedFiles = [join(home,"config","client.json"),join(home,"state","collector.json"),join(home,"state","collector-process.json.desired.json"),
    join(home,"updates","runtime.json"),join(home,"updates","control.json")]
  const credentialFiles = async () => (await readdir(join(home,"credentials"),{withFileTypes:true}).catch(cause=>{if(missing(cause))return [];throw cause}))
    .filter(entry=>entry.isFile()&&entry.name.endsWith(".json")).map(entry=>join(home,"credentials",entry.name))
  const snapshot = async()=> new Map(await Promise.all([...protectedFiles,...await credentialFiles()].map(async path=>[path,await optionalBytes(path)])))
  const unchanged = async previous => {for(const [file,bytes] of previous)assert.deepEqual(await optionalBytes(file),bytes,`Protected state changed: ${file}`)}
  const collect = () => invoke("collect")
  try {
    await invoke("setup")
    const status=await invoke("snapshot"), originalPid=status.status.pid
    assert.equal(status.status.running,true); assert.equal(status.selection.version,"0.5.9")
    assert.equal(status.effective.adapters[0].version,"0.5.9")
    const oldDaemon=(await entries()).find(entry=>entry.args[0]==="__collector-daemon"&&entry.pid===originalPid)
    assert.equal(oldDaemon?.sha256,entryHash,"Collector must execute genuine 0.5.9 bytes")
    assert.equal(JSON.parse(Buffer.from(status.state.checkpoint.cursor,"base64url").toString("utf8")).eventProjectionVersion,4)
    assert.equal(status.state.checkpoint.rawObjects.length,1); assert.ok(status.state.checkpoint.rawObjects[0].serverOffset>0)
    const oldEvents=(await captured(captures)).flatMap(batch=>batch.events)
    assert.equal(oldEvents.length,4); assert.equal(oldEvents.find(event=>event.sourceEventId==="clock-unknown").occurredAt,"1970-01-01T00:00:00.000Z")
    assert.ok((await captured(captures)).every(batch=>batch.canonicalProfileVersion==="atape.acp-centered.v2"))
    // Match the deployed release/minimum metadata for every upgrade action;
    // lower historical metadata applies only while seeding the real old capture.
    await writeFile(publicRelease,JSON.stringify({ ...distribution,serverVersion:feature?.version ?? version,minimumCLIVersion:feature?.version ?? version }))
    await invoke("enable-auto")
    const beforeAuto=await snapshot(); beforeAuto.set(join(home,"state","collector-process.json"),await readFile(join(home,"state","collector-process.json")))
    await invoke("dispatch")
    await waitFor(async()=>{
      const state=await json(join(home,"updates","state.json")).catch(cause=>{if(missing(cause))return undefined;throw cause})
      const workers=(await entries()).filter(entry=>entry.args[0]==="__automatic-update")
      assert.equal((await json(join(home,"state","collector-process.json"))).pid,originalPid)
      assert.equal(await optionalBytes(join(home,"state","collector-process.json.maintenance.json")),undefined)
      return state?.failures===1&&state.failure==="handoff"&&workers.length>0&&workers.every(worker=>!alive(worker.pid))
    },"Genuine old automatic updater did not reject before pause")
    await unchanged(beforeAuto)
    assert.ok((await entries()).filter(entry=>entry.args[0]==="__automatic-update").every(entry=>entry.sha256===entryHash))
    await invoke("disable-auto")
    const beforeUI=await snapshot(); beforeUI.set(join(home,"state","collector-process.json"),await readFile(join(home,"state","collector-process.json")))
    assert.equal(JSON.parse((await pty("reject")).stdout).rejectionVisible,true)
    await unchanged(beforeUI); assert.equal((await invoke("snapshot")).status.pid,originalPid)
    await invoke("stop")
    const stopped=await invoke("snapshot")
    assert.equal(stopped.wanted,false);assert.equal(stopped.status.running,false)
    const progress=await readFile(join(home,"state","collector.json")), configBefore=stopped.config
    const credentialBefore = new Map(await Promise.all((await credentialFiles()).map(async file=>[file,await readFile(file)])))
    assert.equal(JSON.parse((await pty("complete")).stdout).exit,0)
    const final=await invoke("snapshot")
    assert.equal(final.selection.version,version);assert.equal(final.wanted,false);assert.equal(final.status.running,false)
    assert.equal(final.effective.adapters[0].version,version)
    assert.deepEqual(final.config.projects,configBefore.projects); assert.deepEqual(final.config.enabledAdapterIds,configBefore.enabledAdapterIds)
    assert.equal(final.config.autoUpdateEnabled,false);assert.equal(final.config.autoStartEnabled,false)
    assert.deepEqual(await readFile(join(home,"state","collector.json")),progress)
    await unchanged(credentialBefore)
    const control=await json(join(home,"updates","control.json"))
    assert.equal(control.phase,"completed");assert.equal(control.floor.minimumRuntimeVersion,version)
    const candidateEntry = join(home,"releases",version,"node_modules","@atape","cli","dist","atape.js")
    const candidateEntryHash=sha256(await readFile(candidateEntry))
    const packedEntry=(await execute("tar",["-xOf",publicPackages["@atape/cli"].archive,"package/dist/atape.js"],{encoding:"buffer",maxBuffer:16*1024*1024})).stdout
    assert.equal(candidateEntryHash,sha256(packedEntry))
    const rawBefore=await readFile(rawCaptures), oldRawObjects=final.state.checkpoint.rawObjects
    const captureCount=(await captured(captures)).length
    await collect()
    const replay=await invoke("snapshot"), corrected=(await captured(captures)).slice(captureCount)
    assert.ok(corrected.length>0);assert.ok(corrected.every(batch=>batch.canonicalProfileVersion===candidateProfile))
    const newEvents=corrected.flatMap(batch=>batch.events)
    assert.deepEqual(new Set(newEvents.map(event=>event.sourceEventId)),new Set(oldEvents.map(event=>event.sourceEventId)))
    for(const event of newEvents){assert.equal(event.projectionRevision,candidateProjection);assert.ok(event.revision>oldEvents.find(old=>old.sourceEventId===event.sourceEventId).revision)}
    assert.equal(newEvents.find(event=>event.sourceEventId==="clock-unknown").occurredAt,null)
    if (candidateProjection >= 7) {
      const files = newEvents.filter(event => event.toolUpdateJson).map(event => JSON.parse(event.toolUpdateJson))
        .find(update => update.toolCallId === "clock-files")
      assert.ok(files, "Installed replay must preserve the native file call")
      assert.deepEqual(files._meta["atape.dev/file-activity"], [{ operation: "read", path: "src/main.ts" }, { operation: "search", path: "src" }])
      assert.deepEqual(files.rawInput, { parsed_cmd: [{ type: "read", path: "src/main.ts" }, { type: "search", path: "src" }] })
    }
    assert.equal(corrected[0].session.updatedAt,"2026-10-11T00:00:02Z")
    assert.deepEqual(replay.state.checkpoint.rawObjects,oldRawObjects);assert.deepEqual(await readFile(rawCaptures),rawBefore)
    assert.equal(JSON.parse(Buffer.from(replay.state.checkpoint.cursor,"base64url").toString("utf8")).eventProjectionVersion,candidateProjection)
    assert.equal(replay.wanted,false);assert.equal(replay.status.running,false)
    const beforeNoOp=(await captured(captures)).length
    await collect();assert.equal((await captured(captures)).length,beforeNoOp)
    await appendFile(source,lines([item("clock-appended","AgentMessage","A forward continuation","2026-10-11T00:00:03Z")]))
    await collect()
    const continued=await invoke("snapshot"), appended=(await captured(captures)).slice(beforeNoOp).flatMap(batch=>batch.events)
    assert.deepEqual(appended.map(event=>event.sourceEventId),["clock-appended"])
    assert.ok(continued.state.checkpoint.rawObjects[0].serverOffset>oldRawObjects[0].serverOffset)
    assert.equal(continued.state.checkpoint.rawObjects[0].sourceGeneration,oldRawObjects[0].sourceGeneration)
    assert.equal(continued.wanted,false);assert.equal(continued.status.running,false)
    const candidateDaemons=(await entries()).filter(entry=>entry.args[0]==="__collector-daemon"&&entry.pid!==originalPid)
    assert.equal(candidateDaemons.length,3)
    assert.ok(candidateDaemons.every(entry=>entry.sha256===candidateEntryHash),"Replay, no-op and append must run the exact installed candidate executable")
    const retained = join(root,"retained-codex")
    await npm(["install","--prefix",retained,baselineCodex,"--offline","--ignore-scripts","--no-audit","--no-fund"])
    const oldCheck=join(root,"old-adapter-caller.mjs")
    const assertOldAdapterRefuses = async (checkpoint, projection) => {
    const oldRequest={protocolVersion:"atape.adapter.v1alpha1",cursor:checkpoint.cursor,
      rawProgress:checkpoint.rawObjects,limits:AdapterCollectionLimits,rawCaptureEnabled:true}
    await writeFile(oldCheck,`import assert from "node:assert/strict";\nimport { createAtapeAdapter } from ${JSON.stringify(pathToFileURL(join(retained,"node_modules","@atape","adapter-codex","dist","index.js")).href)};\nconst runtime=await createAtapeAdapter({protocolVersion:"atape.adapter.v1alpha1",adapter:{id:"codex",version:"0.5.9"},project:{id:"upgrade-project",type:"directory",path:${JSON.stringify(join(root,"workspace"))}},signal:AbortSignal.timeout(5000)});\ntry{await assert.rejects(runtime.collect({...${JSON.stringify(oldRequest)},signal:AbortSignal.timeout(5000)}),error=>error.reason==="cursor"&&/cursor is invalid/i.test(error.message));process.stdout.write("old-adapter-refused-v${projection}");}finally{await runtime.close?.()}\n`)
    assert.equal((await execute(process.execPath,[oldCheck],{cwd:root,env:environment,encoding:"utf8",timeout:15_000,maxBuffer:1024*1024})).stdout,`old-adapter-refused-v${projection}`)
    assert.equal(JSON.parse(Buffer.from(checkpoint.cursor,"base64url").toString("utf8")).eventProjectionVersion,projection)
    }
    await assertOldAdapterRefuses(continued.state.checkpoint,candidateProjection)
    await unchanged(credentialBefore); assert.equal(await optionalBytes(native),undefined)
    let featureEvidence
    if (feature) {
      const bridgeBootstrapBytes = await readFile(bootstrap)
      assert.equal(sha256(bridgeBootstrapBytes),candidateEntryHash,"Second leg must retain the genuine installed bridge bootstrap")
      const bridgeManifestBytes = await readFile(join(dirname(dirname(bootstrap)),"package.json"))
      assert.equal(JSON.parse(bridgeManifestBytes).version,version)
      const beforeFeature = await invoke("snapshot"), preceding = await captured(captures), precedingEvents = preceding.flatMap(batch=>batch.events)
      const precedingRaw = await readFile(rawCaptures), beforeFeatureNpmCalls = (await captured(calls)).length
      const beforeFeatureEntryCount = (await entries()).length
      const assertNoRegisteredCaptureJournal = async () => {
        assert.equal(await optionalBytes(join(home,"state","collector.json.capture-installation.json")),undefined)
        assert.equal(await readdir(join(home,"state","collector.json.captures")).catch(cause=>{if(missing(cause))return undefined;throw cause}),undefined)
      }
      // Codex uses the Legacy Canonical runtime even for profile v5. It never
      // registers a SourceCapture account; the real coordinator completes an
      // empty journal inventory while the Adapter separately replays projection.
      await assertNoRegisteredCaptureJournal()
      // The published bridge's manual UI refreshes the global command even for
      // a target-owned bundle. Exercise its genuine automatic worker instead.
      // Advance only the external clock Seam so the ordinary durable retry and
      // discovery cache expire; do not edit the updater's private state.
      distribution.featureAdvertised = true
      distribution.clockOffsetMs += 2 * 24 * 60 * 60 * 1000
      await writeFile(publicRelease,JSON.stringify({ ...distribution,serverVersion:feature.version,minimumCLIVersion:feature.version }))
      const enabled = await invoke("enable-auto")
      assert.equal(enabled.config.autoUpdateEnabled,true)
      assert.equal(enabled.wanted,false);assert.equal(enabled.status.running,false)
      await invoke("dispatch")
      await waitFor(async()=>{
        const state=await json(join(home,"updates","state.json")).catch(cause=>{if(missing(cause))return undefined;throw cause})
        const workers=(await entries()).slice(beforeFeatureEntryCount).filter(entry=>entry.args[0]==="__automatic-update")
        const settled=workers.length>0&&workers.every(worker=>!alive(worker.pid))
        if(settled&&state?.failures>0)throw new Error(`Genuine installed bridge automatic update failed: ${state.failure}`)
        const selection=await json(join(home,"updates","runtime.json"))
        return settled&&state?.version===feature.version&&state.failures===0&&selection.version===feature.version&&
          await optionalBytes(join(home,"updates","target-update.json"))===undefined
      },"Genuine installed bridge automatic worker did not settle at the target-owned feature")
      const selected = await invoke("snapshot"), targetControl = await json(join(home,"updates","control.json"))
      const bridgeWorkers = (await entries()).slice(beforeFeatureEntryCount).filter(entry=>entry.args[0]==="__automatic-update")
      assert.ok(bridgeWorkers.length>0&&bridgeWorkers.every(entry=>entry.sha256===candidateEntryHash),
        "Feature update must execute the exact installed bridge automatic worker")
      assert.equal(selected.selection.version,feature.version);assert.equal(selected.effective.adapters[0].version,feature.version)
      assert.equal(selected.wanted,false);assert.equal(selected.status.running,false)
      assert.equal(selected.config.autoUpdateEnabled,true);assert.equal(selected.config.autoStartEnabled,false)
      assert.deepEqual(selected.config.projects,beforeFeature.config.projects);assert.deepEqual(selected.config.enabledAdapterIds,beforeFeature.config.enabledAdapterIds)
      assert.deepEqual(selected.state.checkpoint.rawObjects,beforeFeature.state.checkpoint.rawObjects)
      assert.equal((await captured(captures)).length,preceding.length,"Stopped target-owned selection must not capture native history")
      assert.deepEqual(await readFile(rawCaptures),precedingRaw)
      assert.equal(targetControl.phase,"completed");assert.equal(targetControl.floor.minimumRuntimeVersion,feature.version)
      assert.equal(targetControl.target.version,feature.version);assert.equal(targetControl.forwardOnly,true)
      assert.equal(await optionalBytes(join(home,"updates","target-update.json")),undefined)
      assert.equal(await optionalBytes(join(home,"updates","pending.json")),undefined)
      assert.equal(await optionalBytes(join(home,"state","collector-process.json.maintenance.json")),undefined)
      assert.deepEqual(await readdir(join(home,"updates","target-capture-intents")).catch(cause=>{if(missing(cause))return [];throw cause}),[])
      assert.deepEqual(await readFile(bootstrap),bridgeBootstrapBytes,"Target-owned update must preserve the installed bridge bootstrap")
      assert.deepEqual(await readFile(join(dirname(dirname(bootstrap)),"package.json")),bridgeManifestBytes)
      const featureNpmCalls = (await captured(calls)).slice(beforeFeatureNpmCalls)
      const featureGlobalInstalls = featureNpmCalls.filter(args=>args[0]==="install"&&args.includes("--global"))
      assert.deepEqual(featureGlobalInstalls,[],`Feature update may not rewrite the global npm installation: ${JSON.stringify(featureGlobalInstalls)}`)
      const featureEntry = join(home,"releases",feature.version,"node_modules","@atape","cli","dist","atape.js")
      const featureEntryHash = sha256(await readFile(featureEntry)), packedFeature = (await execute("tar",["-xOf",feature.packages["@atape/cli"].archive,"package/dist/atape.js"],{encoding:"buffer",maxBuffer:16*1024*1024})).stdout
      assert.equal(featureEntryHash,sha256(packedFeature))
      const migration = await json(join(home,"updates","capture-migration.json")), requirement = migration.required.requirement, receipt = migration.receipt
      assert.equal(migration.protocol,"atape.capture-migration.v1");assert.equal(migration.phase,"completed")
      assert.equal(migration.attempt,undefined)
      assert.deepEqual(migration.required,await json(join(home,"updates","capture-migration.required.json")))
      assert.equal(requirement.outerKey,targetControl.key);assert.equal(requirement.source.version,version)
      assert.deepEqual(requirement.target,targetControl.target)
      assert.deepEqual(requirement.bundle.packages,feature.bundle.packages)
      assert.deepEqual(requirement.inventory,[],"Legacy Canonical Codex must have no registered SourceCapture journal inventory")
      assert.equal(receipt.protocol,"atape.capture-migration-receipt.v1");assert.equal(receipt.planId,"journal-v7-to-v8")
      assert.equal(receipt.outerKey,targetControl.key);assert.equal(receipt.requirementHash,requirement.hash)
      assert.equal(receipt.bundleFingerprint,requirement.bundleFingerprint)
      assert.deepEqual(receipt.target,{version:feature.version,captureStateContract:feature.bundle.captureStateContract})
      assert.deepEqual(receipt.accounts,[]);assert.deepEqual(migration.progress,[])
      await assertNoRegisteredCaptureJournal()
      const targetOwner = await json(join(home,"updates","target-owner.json"))
      assert.equal(targetOwner.protocol,"atape.update-target.v1");assert.deepEqual(targetOwner.bundle,feature.bundle)
      assert.equal(targetOwner.entrySha256,featureEntryHash);assert.equal(targetOwner.bootstrapEntry,bootstrap)
      assert.equal(targetOwner.paths.atapeHome,home)
      const targetEntries = (await entries()).filter(entry=>entry.args[0]==="__update-target")
      assert.ok(targetEntries.some(entry=>entry.args.at(-1)==="prepare")&&targetEntries.some(entry=>entry.args.at(-1)==="activate"))
      assert.ok(targetEntries.every(entry=>entry.sha256===featureEntryHash),"Preparation and activation must execute the exact installed target")
      await collect()
      const replayed = (await captured(captures)).slice(preceding.length), events = replayed.flatMap(batch=>batch.events), featureReplay = await invoke("snapshot")
      assert.ok(replayed.length>0&&replayed.every(batch=>batch.canonicalProfileVersion==="atape.acp-centered.v5"))
      assert.deepEqual(new Set(events.map(event=>event.sourceEventId)),new Set(precedingEvents.map(event=>event.sourceEventId)))
      for(const event of events){assert.equal(event.projectionRevision,7);assert.ok(event.revision>Math.max(...precedingEvents.filter(old=>old.sourceEventId===event.sourceEventId).map(old=>old.revision)))}
      assert.equal(events.find(event=>event.sourceEventId==="clock-unknown").occurredAt,null)
      const files = events.filter(event=>event.toolUpdateJson).map(event=>JSON.parse(event.toolUpdateJson)).find(update=>update.toolCallId==="clock-files")
      assert.deepEqual(files._meta["atape.dev/file-activity"],[{operation:"read",path:"src/main.ts"},{operation:"search",path:"src"}])
      assert.deepEqual(files.rawInput,{parsed_cmd:[{type:"read",path:"src/main.ts"},{type:"search",path:"src"}]})
      assert.equal(replayed[0].session.updatedAt,"2026-10-11T00:00:03Z")
      assert.deepEqual(featureReplay.state.checkpoint.rawObjects,beforeFeature.state.checkpoint.rawObjects)
      assert.deepEqual(await readFile(rawCaptures),precedingRaw)
      assert.equal(JSON.parse(Buffer.from(featureReplay.state.checkpoint.cursor,"base64url").toString("utf8")).eventProjectionVersion,7)
      const featureNoOpCount = (await captured(captures)).length
      await collect();assert.equal((await captured(captures)).length,featureNoOpCount)
      await appendFile(source,lines([item("clock-feature-appended","AgentMessage","A feature continuation","2026-10-11T00:00:04Z")]))
      await collect()
      const featureContinued = await invoke("snapshot"), featureAppend = (await captured(captures)).slice(featureNoOpCount).flatMap(batch=>batch.events)
      assert.deepEqual(featureAppend.map(event=>event.sourceEventId),["clock-feature-appended"])
      assert.ok(featureContinued.state.checkpoint.rawObjects[0].serverOffset>beforeFeature.state.checkpoint.rawObjects[0].serverOffset)
      assert.equal(featureContinued.state.checkpoint.rawObjects[0].sourceGeneration,beforeFeature.state.checkpoint.rawObjects[0].sourceGeneration)
      assert.equal(featureContinued.wanted,false);assert.equal(featureContinued.status.running,false)
      assert.equal(featureContinued.config.autoUpdateEnabled,true)
      const featureDaemons = (await entries()).filter(entry=>entry.args[0]==="__collector-daemon"&&entry.sha256===featureEntryHash)
      assert.equal(featureDaemons.length,3,"Replay, no-op and append must execute the actual installed feature")
      await assertOldAdapterRefuses(featureContinued.state.checkpoint,7)
      const disabled = await invoke("disable-auto")
      assert.equal(disabled.config.autoUpdateEnabled,false)
      assert.equal(disabled.wanted,false);assert.equal(disabled.status.running,false)
      assert.equal(disabled.selection.version,feature.version)
      assert.deepEqual(disabled.state.checkpoint,featureContinued.state.checkpoint)
      await assertNoRegisteredCaptureJournal()
      await unchanged(credentialBefore)
      assert.deepEqual(await readFile(bootstrap),bridgeBootstrapBytes)
      const requested = await captured(requests)
      assert.ok(requested.some(request=>request.address===releaseCatalogURL("atape.update-catalog.v3")&&bridgeWorkers.some(worker=>worker.pid===request.pid)))
      assert.ok(requested.every(request=>![releaseBundleURL(feature.version,"atape.release-bundle.v1"),
        releaseBundleURL(feature.version,"atape.release-bundle.v2")].includes(request.address)),"Target-owned feature discovery must not request a legacy descriptor")
      const nativeProbes = await captured(native)
      assert.ok(nativeProbes.every(call=>call.rejected===true&&call.method==="execFile"&&Array.isArray(call.args)&&
        (basename(call.file)==="launchctl"&&call.args.length===2&&call.args[0]==="print"&&/^gui\/\d+$/.test(call.args[1])||
         basename(call.file)==="systemctl"&&JSON.stringify(call.args)===JSON.stringify(["--user","show-environment"]))),"Native OS registration remains forbidden")
      featureEvidence = {version:feature.version,entrySha256:featureEntryHash,cliIntegrity:feature.packages["@atape/cli"].manifest.dist.integrity,
        codexIntegrity:feature.packages["@atape/adapter-codex"].manifest.dist.integrity,bundle:feature.bundle,
        actualInstalledBridgeAutomaticWorker:true,actualTargetPrepareAndActivate:true,captureMigrationReceiptVerified:true,
        emptyInventoryLegacyCodex:true,noNonEmptyJournalMigrationClaim:true,targetOwnerVerified:true,featureLegacyDescriptorsAdvertised:false,
        npmLatestRetainedBridge:true,globalBridgeBootstrapBytesPreserved:true,globalNpmInstalls:featureGlobalInstalls.length,
        globalNpmReadQueries:featureNpmCalls.filter(args=>["root","prefix"].includes(args[0])&&args.includes("--global")).length,
        automaticUpdatesExplicitlyEnabled:true,
        automaticUpdatesEnabledThroughReplay:true,automaticUpdatesExplicitlyDisabledAfterReplay:true,automaticUpdatesOffAtEnd:true,stopIntentPreserved:true,
        explicitNullReplayed:true,eventIDsPreserved:true,revisionsAdvanced:true,rawReceiptsPreservedAcrossReplay:true,
        installedNativeFileActivityReplayed:true,noOpContinuationPassed:true,appendedContinuationPassed:true,genuineOldAdapterRejectedProjection7:true,
        installedCandidateDaemonCycles:3,readerFloor:targetControl.floor}
    }
    const bridgeRecord={baselineVersion:"0.5.9",baselineIntegrities:codexClockBaselineIntegrities,baselineEntrySha256:entryHash,
      candidateVersion:version,candidateEntrySha256:candidateEntryHash,candidateCLIIntegrity:publicPackages["@atape/cli"].manifest.dist.integrity,
      candidateCodexIntegrity:publicPackages["@atape/adapter-codex"].manifest.dist.integrity,candidateBundlePackages:bundle.packages,
      genuineOldAutomaticRejectedBeforePause:true,genuineOldUIRejectedBeforePause:true,genuineOldCollectorCapturedProjection4:true,
      installedStoppedWholeBundleMenuCompleted:true,stopIntentPreserved:true,projectsAndToolsPreserved:true,credentialBytesPreserved:true,
      checkpointBytesPreservedAtSelection:true,rawReceiptsPreservedAcrossReplay:true,explicitNullReplayed:true,eventIDsPreserved:true,
      revisionsAdvanced:true,noOpContinuationPassed:true,appendedContinuationPassed:true,[`genuineOldAdapterRejectedProjection${candidateProjection}`]:true,
      releaseChannel:channel,candidateCanonicalProfile:candidateProfile,candidateProjectionVersion:candidateProjection,
      ...(candidateProjection >= 7 ? { installedNativeFileActivityReplayed: true } : {}),
      installedCandidateDaemonCycles:3,upgradeServerRelease:feature?.version ?? version,upgradeServerMinimumCLI:feature?.version ?? version,
      readerFloor:control.floor,retainedRuntimeRollbackAfterNewCursor:"unsupported; recover forward with target runtime",
      providerCaptureTested:"constructed native-format source through genuine installed readers",realOSRegistrationTested:false,
      server:"owned HTTP Test Adapter for Canonical v2/v3/v4/v5 and Raw; Publication unavailable; no deployed Instance touched"}
    const record = feature ? {baselineVersion:"0.5.9",releaseVersion:feature.version,releaseChannel:"target-owned",clockBridge:bridgeRecord,feature:featureEvidence,
      fullChain:"passed-with-genuine-published-bridge-and-controlled-installed-candidate-artifacts",realOSRegistrationTested:false,
      server:bridgeRecord.server} : bridgeRecord
    await writeFile(join(root,"codex-clock-upgrade-acceptance.json"),JSON.stringify(record,null,2)+"\n",{mode:0o600})
    return record
  } finally {await invoke("cleanup")}
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const [releaseDirectory,fixtureDirectory,baselineCLI,baselineCodex,version,featureDirectory,featureVersion]=process.argv.slice(2)
 if(!version||Boolean(featureDirectory)!==Boolean(featureVersion))throw new Error("usage: verify-codex-clock-upgrade.mjs bridge-dir fixture-dir genuine-cli-0.5.9.tgz genuine-codex-0.5.9.tgz bridge-version [feature-dir feature-version]")
 process.stdout.write(JSON.stringify(await verifyCodexClockUpgrade(releaseDirectory,fixtureDirectory,baselineCLI,baselineCodex,version,
  featureDirectory?{directory:featureDirectory,version:featureVersion}:undefined))+"\n")
}
