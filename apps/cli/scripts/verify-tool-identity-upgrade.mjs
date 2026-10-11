import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { build } from "esbuild"
import { releaseBundleURL, releaseCatalogURL, mergeMigrationReleaseBundle, mergeReleaseBundle, migrationReleaseBundleSection, releaseBundleSection } from "../../../packages/domain/src/releaseCatalog.ts"

const execute = promisify(execFile)
const packages = ["@atape/cli", "@atape/adapter-codex", "@atape/adapter-claude", "@atape/adapter-opencode",
  "@atape/adapter-codebuddy", "@atape/adapter-kimi", "@atape/adapter-grok", "@atape/adapter-cursor"]
export const toolIdentityBaselineIntegrities = {
  "@atape/cli": "sha512-zSoXd95XwgXVy6ulGbFrtH5uDAPHossC5MU6Sxl3IG85MvxGgFA+Shae9bVMRI7bfX+/AhuCde67Gv9N6sIzlw==",
  "@atape/adapter-claude": "sha512-oepXN4VV+WtoXd7MonxUIO0+JJbFpwgcVU0okPzjTfEnFWj5QiR5EkMJIoGSoFKpjA4UXWxVPq/N/OYVdzVvjQ=="
}
const baseline = toolIdentityBaselineIntegrities
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

/** Published old parent, real isolated npm installs and current exact candidate
 * archives. Only external HTTP/npm acquisition and OS registration are Test
 * Adapters; no runtime/control/process/checkpoint JSON is hand-written. */
export async function verifyToolIdentityUpgrade(releaseDirectory, fixtureDirectory, baselineCLI, baselineClaude) {
  for (const [name, path] of [["@atape/cli", baselineCLI], ["@atape/adapter-claude", baselineClaude]]) {
    assert.equal(integrity(await readFile(path)), baseline[name], `Requires the exact npm-published ${name}@0.5.8 archive`)
  }
  await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 })
  const root = await realpath(fixtureDirectory), version = "0.5.9"
  const realNpm = (await execute("which", ["npm"], { encoding: "utf8" })).stdout.trim()
  assert.ok(realNpm.startsWith("/"))
  const publicPackages = {}
  for (const name of packages) {
    const archive = await realpath(join(releaseDirectory, `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`))
    const manifest = JSON.parse((await execute("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8", maxBuffer: 256 * 1024 })).stdout)
    assert.equal(manifest.name, name); assert.equal(manifest.version, version)
    const bytes = await readFile(archive)
    publicPackages[name] = { archive, manifest: { ...manifest, dist: { integrity: integrity(bytes),
      tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${version}.tgz` } } }
  }
  assert.equal(publicPackages["@atape/adapter-claude"].manifest.atapeAdapter.publicationTargetProfile, "atape.publication-target.v4")
  const cliManifest = publicPackages["@atape/cli"].manifest
  const bundle = { protocol: "atape.release-bundle.v2", version, captureStateContract: cliManifest.atapeRuntime.stateContract,
    updateControlProtocol: cliManifest.atapeRuntime.updateControlProtocol, migration: cliManifest.atapeRuntime.captureMigration,
    packages: packages.map(name => ({ name, ...publicPackages[name].manifest.dist })) }
  const legacyBundle = { ...bundle, protocol: "atape.release-bundle.v1" }; delete legacyBundle.migration
  const catalog = mergeMigrationReleaseBundle(undefined, bundle), legacyCatalog = mergeReleaseBundle(undefined, legacyBundle)
  const releaseBody = migrationReleaseBundleSection(bundle) + "\n" + releaseBundleSection(legacyBundle)
  const publicRelease = join(root, "public-release.json")
  await writeFile(publicRelease, JSON.stringify({ bundle, legacyBundle, catalog, legacyCatalog, releaseBody, packages: publicPackages }))
  const prefix = join(root, "prefix"), home = join(root, "home"), userHome = join(root, "user")
  const globalRoot = join(prefix, "lib", "node_modules"), bootstrap = join(globalRoot, "@atape", "cli", "dist", "atape.js")
  const trace = join(root, "entries.jsonl"), requests = join(root, "requests.jsonl"), calls = join(root, "npm.jsonl"), native = join(root, "native.jsonl")
  const preload = join(root, "owned-external-adapters.mjs")
  await writeFile(preload, String.raw`import { appendFileSync, readFileSync } from "node:fs";
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
      appendFileSync(${JSON.stringify(native)},JSON.stringify({method,file})+"\n");
      throw new Error("Native OS registration/browser commands are forbidden in isolated transition acceptance");
    }
    return Reflect.apply(original,this,[file,...args]);
  };
}
syncBuiltinESMExports();
const inMemoryFetch = globalThis.fetch;
globalThis.fetch=async (input,init)=> {
 const address=String(input);
 if(address.startsWith("data:"))return inMemoryFetch(input,init);
 const fixture=JSON.parse(readFileSync(${JSON.stringify(publicRelease)},"utf8"));
 appendFileSync(${JSON.stringify(requests)},JSON.stringify({address,pid:process.pid})+"\n");
 for (const protocol of ["atape.release-bundle.v2","atape.release-bundle.v1"]) {
   const migration=protocol.endsWith("v2"), catalog=migration?"atape.update-catalog.v2":"atape.update-catalog.v1";
   const selected=migration?fixture.bundle:fixture.legacyBundle;
   const catalogURL=migration?${JSON.stringify(releaseCatalogURL("atape.update-catalog.v2"))}:${JSON.stringify(releaseCatalogURL("atape.update-catalog.v1"))};
   const versionURL=migration?${JSON.stringify(releaseBundleURL(version,"atape.release-bundle.v2"))}:${JSON.stringify(releaseBundleURL(version,"atape.release-bundle.v1"))};
   if(address===catalogURL)return Response.json(migration?fixture.catalog:fixture.legacyCatalog);
   if(address===versionURL)return Response.json(selected);
 }
 if(address==="https://api.github.com/repos/SingleMai/ATape/releases/latest")return Response.json({tag_name:"v0.5.9",prerelease:false,draft:false,published_at:"2026-10-11T00:00:00Z"});
 if(address==="https://api.github.com/repos/SingleMai/ATape/releases/tags/v0.5.9")return Response.json({tag_name:"v0.5.9",prerelease:false,draft:false,published_at:"2026-10-11T00:00:00Z",body:fixture.releaseBody});
 const artifact=Object.values(fixture.packages).find(item=>item.manifest.dist.tarball===address);
 if(artifact)return new Response(readFileSync(artifact.archive));
 const url=new URL(address), path=decodeURIComponent(url.pathname);
 if(url.origin==="https://registry.npmjs.org") {
  for(const [name,item] of Object.entries(fixture.packages)) if(path==="/"+name+"/0.5.9"||path==="/"+name+"/latest")return Response.json(item.manifest);
 }
 if(url.origin==="https://upgrade-fixture.invalid") {
  if(path==="/api/v1/instance")return Response.json({protocol:"atape.instance.v1",instance_origin:url.origin,web_origin:url.origin,api_origin:url.origin,
   protocols:["atape-cli.v1"],release_version:"0.5.9",auth_epoch:"auth-v1",minimum_cli_version:"0.5.8"});
  if(path==="/api/v1/publications/capabilities") {
   const accepted=(new Headers(init?.headers).get("ATape-Accept-Publication-Target")??"").split(",").map(item=>item.trim());
   return Response.json({protocol:"atape.publication.v1",targetProfile:"atape.publication-target.v1",targetProfiles:["atape.publication-target.v1","atape.publication-target.v2",...accepted.filter(item=>["atape.publication-target.v3","atape.publication-target.v4"].includes(item))],legacyAdoption:true,
   limits:{partBytes:4*1024*1024,targetBytes:128*1024*1024,userPendingBytes:256*1024*1024,parts:4096,reservations:64,reservationLifetimeMs:86400000,leaseLifetimeMs:600000},statusPageSize:100,reclaimPageSize:32});
  }
  if(path==="/api/v1/projects/upgrade-project/raw-capture")return Response.json({enabled:false,authority:{protocol:"atape.raw-publication.v1",teamRevision:1,userRevision:0}});
  if(path==="/api/v1/users/me")return Response.json({id:"upgrade-user",displayName:"Upgrade fixture"});
 }
 throw new Error("Unexpected external request in transition acceptance: "+address);
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
 if(!match&&digest!==${JSON.stringify(baseline["@atape/adapter-claude"])})throw Error("Unverified npm archive");
 if(args.includes("--global")&&(destination!==${JSON.stringify(prefix)}||match?.name!=="@atape/cli"))throw Error("Invalid global install");
 cp.execFileSync(${JSON.stringify(realNpm)},["install",...(args.includes("--global")?["--global"]:[]),"--prefix",destination,archive,"--offline","--ignore-scripts","--engine-strict","--no-audit","--no-fund"],
  {env:{...process.env,PATH:process.env.TOOL_UPGRADE_ORIGINAL_PATH,NODE_OPTIONS:""},stdio:"pipe",timeout:120000});
} else throw Error("Unexpected npm operation: "+JSON.stringify(args));
`)
  await chmod(join(bin, "npm"), 0o755)
  const environment = { PATH: `${bin}:${process.env.PATH}`, HOME: userHome, TMPDIR: root,
    LANG: "en_US.UTF-8", ATAPE_LANG: "en", ATAPE_HOME: home, ATAPE_BOOTSTRAP_ENTRY: bootstrap, ATAPE_RUNTIME_DIRECT: "1",
    XDG_CONFIG_HOME: join(root,"xdg-config"), XDG_DATA_HOME: join(root,"xdg-data"), XDG_STATE_HOME: join(root,"xdg-state"),
    ATAPE_CLAUDE_HOME: join(root,"absent-claude"), ATAPE_CODEX_HOME: join(root,"absent-codex"), ATAPE_GROK_HOME: join(root,"absent-grok"),
    ATAPE_KIMI_HOME: join(root,"absent-kimi"), ATAPE_CODEBUDDY_HOME: join(root,"absent-codebuddy"), OPENCODE_DB: join(root,"absent-opencode.db"),
    ATAPE_REDACT_VALUES:"[]", npm_config_prefix:prefix, npm_config_cache:join(root,"npm-cache"),
    npm_config_userconfig:join(root,"npm-user.conf"), npm_config_globalconfig:join(root,"npm-global.conf"),
    TOOL_UPGRADE_NODE:process.execPath, TOOL_UPGRADE_ORIGINAL_PATH:process.env.PATH, NODE_OPTIONS:`--import=${pathToFileURL(preload).href}` }
  for (const directory of [userHome,home]) await mkdir(directory,{recursive:true,mode:0o700})
  for (const file of [environment.npm_config_userconfig,environment.npm_config_globalconfig]) await writeFile(file,"",{mode:0o600})
  const npm = args => execute(realNpm,args,{cwd:root,env:{...environment,PATH:process.env.PATH,NODE_OPTIONS:""},encoding:"utf8",timeout:120_000,maxBuffer:4*1024*1024})
  await npm(["install","--global","--prefix",prefix,baselineCLI,"--offline","--ignore-scripts","--no-audit","--no-fund"])
  await npm(["install","--prefix",join(home,"releases","0.5.8"),baselineCLI,"--offline","--ignore-scripts","--no-audit","--no-fund"])
  const entryHash = sha256(await readFile(bootstrap))
  assert.equal((await json(join(dirname(dirname(bootstrap)),"package.json"))).version,"0.5.8")
  const helper = join(root,"caller.mjs")
  await build({entryPoints:[fileURLToPath(new URL("../src/runtime/fixtures/tool-identity-bootstrap-transition.ts",import.meta.url))],outfile:helper,bundle:true,
    platform:"node",format:"esm",target:"node24",define:{__ATAPE_CLI_VERSION__:JSON.stringify(version),__ATAPE_CAPTURE_STATE_CONTRACT__:JSON.stringify("atape.client.v3-capture.v2"),"process.env.NODE_ENV":'"production"'},
    banner:{js:'import { createRequire as __atapeCreateRequire } from "node:module"; const require = __atapeCreateRequire(import.meta.url);'},logLevel:"silent"})
  // The fixture request is an ordinary file, never a production state record.
  const requestFile = join(root,"caller-request.json")
  const invoke = async phase => {
    await writeFile(requestFile,JSON.stringify({phase,root,baselineClaudeTarball:await realpath(baselineClaude),bootstrap,version}))
    const result=await execute(process.execPath,[helper,requestFile],{cwd:root,env:environment,encoding:"utf8",timeout:120_000,maxBuffer:4*1024*1024})
    return JSON.parse(result.stdout)
  }
  const terminal = fileURLToPath(new URL("verify-tool-identity-upgrade-terminal.py",import.meta.url))
  const pty = (phase, entry = bootstrap) => execute("python3",[terminal,entry,root,phase,version],{cwd:root,env:environment,encoding:"utf8",timeout:180_000,maxBuffer:2*1024*1024})
  const entries = async()=> (await optionalBytes(trace))?.toString("utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line)) ?? []
  const protectedFiles = [join(home,"config","client.json"),join(home,"state","collector.json"),join(home,"state","collector-process.json.desired.json"),
    join(home,"updates","runtime.json"),join(home,"updates","control.json")]
  const credentialFiles = async () => (await readdir(join(home,"credentials"),{withFileTypes:true}).catch(cause=>{if(missing(cause))return [];throw cause}))
    .filter(entry=>entry.isFile()&&entry.name.endsWith(".json")).map(entry=>join(home,"credentials",entry.name))
  const snapshot = async()=> new Map(await Promise.all([...protectedFiles,...await credentialFiles()].map(async path=>[path,await optionalBytes(path)])))
  const unchanged = async previous => {for(const [file,bytes] of previous)assert.deepEqual(await optionalBytes(file),bytes,`Protected state changed: ${file}`)}
  let started = false
  try {
    started=true; await invoke("setup")
    const status=await invoke("snapshot"), originalPid=status.status.pid
    assert.equal(status.status.running,true)
    assert.equal(status.selection.version,"0.5.8")
    assert.equal(status.effective.adapters[0].version,"0.5.8")
    const oldDaemon=(await entries()).find(item=>item.args[0]==="__collector-daemon"&&item.pid===originalPid)
    assert.equal(oldDaemon?.sha256,entryHash,"Collector must execute genuine 0.5.8 bytes")
    await invoke("enable-auto")
    const beforeAuto=await snapshot()
    beforeAuto.set(join(home,"state","collector-process.json"),await readFile(join(home,"state","collector-process.json")))
    await invoke("dispatch")
    await waitFor(async()=>{
      const state=await json(join(home,"updates","state.json")).catch(cause=>{if(missing(cause))return undefined;throw cause})
      const workers=(await entries()).filter(item=>item.args[0]==="__automatic-update")
      assert.equal((await invoke("snapshot")).status.pid,originalPid)
      assert.equal(await optionalBytes(join(home,"state","collector-process.json.maintenance.json")),undefined)
      return state?.failures===1&&state.failure==="prepare"&&workers.length>0&&workers.every(worker=>!alive(worker.pid))
    },"Genuine old automatic updater did not reject before pause")
    await unchanged(beforeAuto)
    const workers=(await entries()).filter(item=>item.args[0]==="__automatic-update")
    assert.ok(workers.every(item=>item.sha256===entryHash),"Automatic parent must retain published 0.5.8 bytes")
    await invoke("disable-auto")
    const beforeUI=await snapshot()
    beforeUI.set(join(home,"state","collector-process.json"),await readFile(join(home,"state","collector-process.json")))
    const rejection=JSON.parse((await pty("reject")).stdout)
    assert.equal(rejection.rejectionVisible,true)
    await unchanged(beforeUI)
    assert.equal((await invoke("snapshot")).status.pid,originalPid)
    await invoke("stop"); started=false
    const stopped=await invoke("snapshot")
    assert.equal(stopped.wanted,false);assert.equal(stopped.status.running,false)
    const progress=await readFile(join(home,"state","collector.json"))
    const configBefore=stopped.config
    const credentialBefore = new Map(await Promise.all((await credentialFiles()).map(async file=>[file,await readFile(file)])))
    await npm(["install","--global","--prefix",prefix,publicPackages["@atape/cli"].archive,"--offline","--ignore-scripts","--engine-strict","--no-audit","--no-fund"])
    const candidateEntryHash = sha256(await readFile(bootstrap))
    assert.notEqual(candidateEntryHash,entryHash)
    const packedEntry = (await execute("tar",["-xOf",publicPackages["@atape/cli"].archive,"package/dist/atape.js"],{encoding:"buffer",maxBuffer:16*1024*1024})).stdout
    assert.equal(candidateEntryHash,sha256(packedEntry),"npm must install exact candidate executable bytes")
    const firstNew=(await entries()).length
    const rebound=JSON.parse((await pty("rebound")).stdout)
    assert.equal(rebound.versionShown,version)
    const afterRebind=await invoke("snapshot")
    assert.equal(afterRebind.selection.version,version,"External entry refresh must recover to its actual new runtime")
    assert.equal(afterRebind.wanted,false);assert.equal(afterRebind.status.running,false)
    assert.equal(afterRebind.effective.adapters[0].version,"0.5.8")
    assert.deepEqual(afterRebind.config,configBefore)
    assert.deepEqual(await readFile(join(home,"state","collector.json")),progress)
    assert.ok((await entries()).slice(firstNew).some(item=>item.entry===bootstrap&&item.args.length===0&&item.sha256!==entryHash),"Real new console must execute")
    // The final positive action is the actual installed CLI menu, not the helper.
    const completed=JSON.parse((await pty("complete")).stdout)
    assert.equal(completed.exit,0)
    const final=await invoke("snapshot")
    assert.equal(final.selection.version,version);assert.equal(final.wanted,false);assert.equal(final.status.running,false)
    assert.equal(final.effective.adapters[0].version,version)
    assert.deepEqual(final.config.projects,configBefore.projects)
    assert.equal(final.config.autoUpdateEnabled,false);assert.equal(final.config.autoStartEnabled,false)
    assert.deepEqual(await readFile(join(home,"state","collector.json")),progress)
    const control=await json(join(home,"updates","control.json"))
    assert.equal(control.phase,"completed");assert.equal(control.floor.minimumRuntimeVersion,version)
    assert.equal(control.forwardOnly,true)
    await unchanged(credentialBefore)
    assert.equal(await optionalBytes(native),undefined,"No OS/browser registration should have been attempted")
    const beforeOldReader = await snapshot()
    const fenced = JSON.parse((await pty("old-fenced",join(home,"releases","0.5.8","node_modules","@atape","cli","dist","atape.js"))).stdout)
    assert.equal(fenced.oldRuntimeRejected,true)
    await unchanged(beforeOldReader)
    const record={baselineVersion:"0.5.8",baselineIntegrities:baseline,baselineEntrySha256:entryHash,
      candidateVersion:version,candidateEntrySha256:candidateEntryHash,candidateCLIIntegrity:publicPackages["@atape/cli"].manifest.dist.integrity,
      candidateClaudeIntegrity:publicPackages["@atape/adapter-claude"].manifest.dist.integrity,
      genuineOldAutomaticRejectedBeforePause:true,genuineOldUIRejectedBeforePause:true,
      genuineOldManagedCollectorPreserved:true,externalRealNpmEntryRefresh:true,newRuntimeConsoleVerified:true,
      installedWholeBundleMenuCompleted:true,stopIntentPreserved:true,configAndProgressPreserved:true,credentialBytesPreserved:true,
      readerFloor:control.floor,genuineOldRuntimeRejectedByFloor:true,providerCaptureTested:false,realOSRegistrationTested:false,
      server:"controlled owned HTTP Test Adapter advertising required publication targets; no deployed Instance touched"}
    await writeFile(join(root,"tool-identity-upgrade-acceptance.json"),JSON.stringify(record,null,2)+"\n",{mode:0o600})
    process.stdout.write(JSON.stringify(record)+"\n")
    return record
  } finally {if(started)await invoke("cleanup").catch(()=>{})}
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const [releaseDirectory,fixtureDirectory,baselineCLI,baselineClaude]=process.argv.slice(2)
 if(!baselineClaude)throw new Error("usage: verify-tool-identity-upgrade.mjs release-dir fixture-dir genuine-cli-0.5.8.tgz genuine-claude-0.5.8.tgz")
 await verifyToolIdentityUpgrade(releaseDirectory,fixtureDirectory,baselineCLI,baselineClaude)
}
