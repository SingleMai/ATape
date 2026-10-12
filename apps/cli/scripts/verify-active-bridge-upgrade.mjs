import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { appendFile, chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { build } from "esbuild"
import { releaseBundleURL, releaseCatalogURL, mergeMigrationReleaseBundle, mergeReleaseBundle, migrationReleaseBundleSection, releaseBundleSection, mergeTargetReleaseBundle, targetReleaseBundleSection } from "../../../packages/domain/src/releaseCatalog.ts"

const execute = promisify(execFile)
const packages = ["@atape/cli", "@atape/adapter-codex", "@atape/adapter-claude", "@atape/adapter-opencode",
  "@atape/adapter-codebuddy", "@atape/adapter-kimi", "@atape/adapter-grok", "@atape/adapter-cursor"]
export const activeBridgeBaselineIntegrities = {
  "@atape/cli": "sha512-edQJ66nr0VMaKgxYaRDOCiSwJeueEVRTRtBQFk815skIPt7sBOR8ZCfFNhMhOHQ+nU/iY8BEsUxQHoO/LPSCJQ==",
  "@atape/adapter-codex": "sha512-tgiD29qMmiH+3DlXtm94XOYBZlVT/N8uXTgX739r9FruGG0Xi4T4M705xbNmhpnrigH9KtzLmyEinEaVHMvfKA==",
  "@atape/adapter-claude": "sha512-VDtK5uXgp2vSyhfqKNedpDxFa91R4nfJgrOXH2Hs0O16LhT7RS1dKxiFPhao1q3UReD31xHPnXQcmC8v4oUWYw=="
}
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`
const json = async file => JSON.parse(await readFile(file, "utf8"))
const missing = cause => cause.code === "ENOENT"
const optionalBytes = file => readFile(file).catch(cause => { if (missing(cause)) return undefined; throw cause })
const journalVersion = path => {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return Number(db.prepare("PRAGMA user_version").get().user_version) } finally { db.close() }
}
const alive = pid => { try { process.kill(pid, 0); return true } catch (cause) { if (cause.code === "ESRCH") return false; throw cause } }
const waitFor = async (check, description, timeout = 120_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error(description)
}
const lines = records => records.map(record => JSON.stringify(record)).join("\n") + "\n"
const item = (id, type, text, timestamp) => ({ timestamp, type: "event_msg", payload: { type: "item_completed",
  thread_id: "clock-session", item: { id, type, content: [{ type: type === "UserMessage" ? "input_text" : "output_text", text }] } } })

/** Real published .10 -> actual bridge -> optional actual feature archives.
 * Only distribution/Server HTTP and native OS registration are Test Adapters.
 * The real installed CLI, automatic workers, npm, readers and Collector execute. */
export async function verifyActiveBridgeUpgrade(releaseDirectory, fixtureDirectory, baselineCLI, baselineCodex,
  baselineClaude, version, featureRelease) {
  const faultPoint = featureRelease?.faultPoint
  if (faultPoint && !["control-synced", "first-private-ledger", "before-readiness", "orphan-apply"].includes(faultPoint))
    throw new Error("Unknown installed bridge fault point")
  for (const [name, path] of [["@atape/cli", baselineCLI], ["@atape/adapter-codex", baselineCodex], ["@atape/adapter-claude", baselineClaude]]) {
    assert.equal(integrity(await readFile(path)), activeBridgeBaselineIntegrities[name], `Requires the exact npm-published ${name}@0.5.10 archive`)
  }
  await mkdir(fixtureDirectory, { recursive: true, mode: 0o700 })
  const root = await realpath(fixtureDirectory)
  const realNpm = (await execute("which", ["npm"], { encoding: "utf8" })).stdout.trim()
  assert.ok(realNpm.startsWith("/"))
  const loadPackages = async (directory, releaseVersion) => {
    const checksumLines = (await readFile(join(directory, "SHA256SUMS"), "utf8")).trim().split("\n")
    const checksums = new Map(checksumLines.map(line => {
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9.-]+\.tgz)$/.exec(line)
      assert.ok(match, "Release checksums must identify bounded archive filenames")
      return [match[2], match[1]]
    }))
    assert.equal(checksums.size, packages.length); assert.equal(checksumLines.length, packages.length)
    const result = {}
    for (const name of packages) {
      const filename = `${name.replace(/^@/, "").replaceAll("/", "-")}-${releaseVersion}.tgz`
      const archive = await realpath(join(directory, filename))
      const manifest = JSON.parse((await execute("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8", maxBuffer: 256 * 1024 })).stdout)
      assert.equal(manifest.name, name); assert.equal(manifest.version, releaseVersion)
      const bytes = await readFile(archive)
      assert.equal(sha256(bytes), checksums.get(filename), "Automatic transition requires exact checksummed candidate archives")
      result[name] = { archive, manifest: { ...manifest, dist: { integrity: integrity(bytes),
        tarball: `https://registry.npmjs.org/${name}/-/${name.slice("@atape/".length)}-${releaseVersion}.tgz` } } }
    }
    return result
  }
  const publicPackages = await loadPackages(releaseDirectory, version)
  const cliManifest = publicPackages["@atape/cli"].manifest
  assert.equal(cliManifest.atapeRuntime.releaseChannel, "legacy-bridge")
  assert.equal(publicPackages["@atape/adapter-codex"].manifest.atapeAdapter.legacyCanonicalProfile, "atape.acp-centered.v3")
  assert.equal(publicPackages["@atape/adapter-claude"].manifest.atapeAdapter.publicationTargetProfile, "atape.publication-target.v4")
  assert.equal(cliManifest.atapeRuntime.updateTargetProtocol, "atape.update-target.v1")
  const bundle = { protocol: "atape.release-bundle.v2", version, captureStateContract: cliManifest.atapeRuntime.stateContract,
    updateControlProtocol: cliManifest.atapeRuntime.updateControlProtocol, migration: cliManifest.atapeRuntime.captureMigration,
    packages: packages.map(name => ({ name, ...publicPackages[name].manifest.dist })) }
  const legacyBundle = { ...bundle, protocol: "atape.release-bundle.v1" }; delete legacyBundle.migration
  const catalog = mergeMigrationReleaseBundle(undefined, bundle), legacyCatalog = mergeReleaseBundle(undefined, legacyBundle)
  const releaseBody = migrationReleaseBundleSection(bundle) + "\n" + releaseBundleSection(legacyBundle)
  let feature
  if (featureRelease) {
    const artifacts = await loadPackages(featureRelease.directory, featureRelease.version), manifest = artifacts["@atape/cli"].manifest
    assert.equal(manifest.atapeRuntime.releaseChannel, "target-owned")
    assert.equal(artifacts["@atape/adapter-codex"].manifest.atapeAdapter.legacyCanonicalProfile, "atape.acp-centered.v5")
    assert.equal(artifacts["@atape/adapter-claude"].manifest.atapeAdapter.publicationTargetProfile, "atape.publication-target.v5")
    const target = { protocol: "atape.release-bundle.v3", version: featureRelease.version,
      captureStateContract: manifest.atapeRuntime.stateContract, updateControlProtocol: manifest.atapeRuntime.updateControlProtocol,
      updateTargetProtocol: manifest.atapeRuntime.updateTargetProtocol,
      fromCaptureStateContracts: manifest.atapeRuntime.fromCaptureStateContracts,
      packages: packages.map(name => ({ name, ...artifacts[name].manifest.dist })) }
    feature = { version: featureRelease.version, bundle: target, catalog: mergeTargetReleaseBundle(undefined, target),
      releaseBody: targetReleaseBundleSection(target), packages: artifacts }
  }
  const publicRelease = join(root, "public-release.json")
  // A late-offline .10 sees the newer feature GitHub release from the outset,
  // while immutable legacy routes and npm latest keep pointing to the bridge.
  const distribution = { bundle, legacyBundle, catalog, legacyCatalog, releaseBody, packages: publicPackages, feature,
    clockOffsetMs: 0, serverVersion: feature?.version ?? "0.5.10", minimumCLIVersion: feature?.version ?? "0.5.10",
    ...(faultPoint ? { fault: { point: faultPoint } } : {}) }
  await writeFile(publicRelease, JSON.stringify(distribution))
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
import { installActiveBridgeFaultAdapter } from ${JSON.stringify(new URL("./active-bridge-fault-adapter.mjs", import.meta.url).href)};
const root = ${JSON.stringify(root)}, entry = process.argv[1];
installActiveBridgeFaultAdapter(root, ${JSON.stringify(publicRelease)});
if (entry?.startsWith(root + "/")) appendFileSync(${JSON.stringify(trace)}, JSON.stringify({entry,args:process.argv.slice(2),pid:process.pid,
  sha256:createHash("sha256").update(readFileSync(entry)).digest("hex"),at:Date.now()})+"\n");
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
 appendFileSync(${JSON.stringify(requests)},JSON.stringify({address,pid:process.pid,
  ...(address==="https://upgrade-fixture.invalid/api/v1/instance"?{serverVersion:fixture.serverVersion,minimumCLIVersion:fixture.minimumCLIVersion}:{})})+"\n");
 for (const protocol of ["atape.release-bundle.v2","atape.release-bundle.v1"]) {
   const migration=protocol.endsWith("v2");
   const catalogURL=migration?${JSON.stringify(releaseCatalogURL("atape.update-catalog.v2"))}:${JSON.stringify(releaseCatalogURL("atape.update-catalog.v1"))};
   const versionURL=migration?${JSON.stringify(releaseBundleURL(version,"atape.release-bundle.v2"))}:${JSON.stringify(releaseBundleURL(version,"atape.release-bundle.v1"))};
   if(address===catalogURL)return Response.json(migration?fixture.catalog:fixture.legacyCatalog);
   if(address===versionURL)return Response.json(migration?fixture.bundle:fixture.legacyBundle);
 }
 if(address===${JSON.stringify(releaseCatalogURL("atape.update-catalog.v3"))})return fixture.feature?Response.json(fixture.feature.catalog):new Response("not published",{status:404});
 if(fixture.feature&&address===${JSON.stringify(feature && releaseBundleURL(feature.version, "atape.release-bundle.v3"))})return Response.json(fixture.feature.bundle);
 if(address==="https://api.github.com/repos/SingleMai/ATape/releases/latest")return Response.json({tag_name:"v"+(fixture.feature?.version??fixture.bundle.version),prerelease:false,draft:false,published_at:"2026-10-12T00:00:00Z"});
 for(const release of [fixture,fixture.feature].filter(Boolean))if(address==="https://api.github.com/repos/SingleMai/ATape/releases/tags/v"+(release.version??release.bundle.version))return Response.json({tag_name:"v"+(release.version??release.bundle.version),prerelease:false,draft:false,published_at:"2026-10-12T00:00:00Z",body:release.releaseBody});
 const allPackages=[...Object.values(fixture.packages),...Object.values(fixture.feature?.packages??{})];
 const artifact=allPackages.find(item=>item.manifest.dist.tarball===address);
 if(artifact)return new Response(readFileSync(artifact.archive));
 const url=new URL(address), path=decodeURIComponent(url.pathname);
 if(url.origin==="https://registry.npmjs.org") {
  for(const item of allPackages)if(path==="/"+item.manifest.name+"/"+item.manifest.version)return Response.json(item.manifest);
  for(const [name,item] of Object.entries(fixture.packages))if(path==="/"+name+"/latest")return Response.json(item.manifest);
  for(const [name,item] of Object.entries(fixture.feature?.packages??{}))if(path==="/"+name+"/managed")return Response.json(item.manifest);
 }
 if(url.origin==="https://upgrade-fixture.invalid") {
  if(path==="/api/v1/instance")return Response.json({protocol:"atape.instance.v1",instance_origin:url.origin,web_origin:url.origin,api_origin:url.origin,
   protocols:["atape-cli.v1"],release_version:fixture.serverVersion,auth_epoch:"auth-v1",minimum_cli_version:fixture.minimumCLIVersion});
  if(new Headers(init?.headers).get("authorization")!=="Bearer atc_v1_synthetic_upgrade_credential")throw Error("Fixture Server requires the installed credential");
  if(path==="/api/v1/ingestion/canonical/capabilities") {
   const requested=(new Headers(init?.headers).get("ATape-Accept-Canonical-Profile")??"").split(",").map(item=>item.trim());
   return Response.json({protocol:"atape.canonical-capabilities.v1",canonicalProfiles:["atape.acp-centered.v2","atape.acp-centered.v3","atape.acp-centered.v4",...(requested.includes("atape.acp-centered.v5")?["atape.acp-centered.v5"]:[])]});
  }
  if(path==="/api/v1/publications/capabilities") {
   const requested=(new Headers(init?.headers).get("ATape-Accept-Publication-Target")??"").split(",").map(item=>item.trim());
   return Response.json({protocol:"atape.publication.v1",targetProfile:"atape.publication-target.v1",legacyAdoption:true,
    targetProfiles:["atape.publication-target.v1","atape.publication-target.v2",...[3,4,5].map(v=>"atape.publication-target.v"+v).filter(p=>requested.includes(p))],
    limits:{partBytes:4194304,targetBytes:134217728,userPendingBytes:268435456,parts:4096,reservations:64,reservationLifetimeMs:86400000,leaseLifetimeMs:600000},statusPageSize:100,reclaimPageSize:32});
  }
  if(path==="/api/v1/projects/upgrade-project/raw-capture")return Response.json({teamPolicy:"personal",userPreference:"enable",enabled:true});
  if(path==="/api/v1/users/me")return Response.json({id:"upgrade-user",displayName:"Upgrade fixture"});
  if(path==="/api/v1/ingestion/canonical/batches") {
   const body=JSON.parse(init.body);
   if(!["atape.acp-centered.v2","atape.acp-centered.v3","atape.acp-centered.v4","atape.acp-centered.v5"].includes(body.canonicalProfileVersion))throw Error("Unsupported Canonical profile");
   if(body.canonicalProfileVersion==="atape.acp-centered.v5"&&existsSync(${JSON.stringify(join(home, "updates", "target-update.json"))}))throw Error("Feature capture started before stable target handoff cleared");
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
 throw new Error("Unexpected external request in active bridge acceptance: "+address);
};
`)
  const bin = join(root, "bin"); await mkdir(bin, { recursive: true })
  await writeFile(join(bin, "npm"), String.raw`#!/usr/bin/env node
const fs=require("node:fs"),cp=require("node:child_process"),crypto=require("node:crypto"),args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+"\n");
if(args[0]==="root"&&args.includes("--global"))console.log(${JSON.stringify(globalRoot)});
else if(args[0]==="prefix"&&args.includes("--global"))console.log(${JSON.stringify(prefix)});
else if(args[0]==="config"&&args[1]==="get"&&args[2]==="registry")console.log("https://registry.npmjs.org/");
else if(args[0]==="install") {
 if(args.includes("--global"))throw Error("Automatic updates must never install into the global npm prefix");
 if(!args.includes("--ignore-scripts"))throw Error("Lifecycle scripts must remain disabled");
 const destination=args[args.indexOf("--prefix")+1];
 if(!destination?.startsWith(${JSON.stringify(root + "/")}))throw Error("npm install escaped isolated root");
 if(destination===${JSON.stringify(prefix)}||destination.startsWith(${JSON.stringify(prefix + "/")}))throw Error("The global npm prefix is read-only");
 const archive=args.find(value=>/\.tgz$/.test(value)&&fs.existsSync(value.replace(/^file:/,"")))?.replace(/^file:/,"");
 if(!archive)throw Error("Production acquisition must supply an exact downloaded archive");
 const fixture=JSON.parse(fs.readFileSync(${JSON.stringify(publicRelease)},"utf8"));
 const digest="sha512-"+crypto.createHash("sha512").update(fs.readFileSync(archive)).digest("base64");
 const match=fixture.bundle.packages.find(item=>item.integrity===digest);
 const featureMatch=fixture.feature?.bundle.packages.find(item=>item.integrity===digest);
 if(!match&&!featureMatch&&!Object.values(${JSON.stringify(activeBridgeBaselineIntegrities)}).includes(digest))throw Error("Unverified npm archive");
 cp.execFileSync(${JSON.stringify(realNpm)},["install","--prefix",destination,archive,"--offline","--ignore-scripts","--engine-strict","--no-audit","--no-fund"],
  {env:{...process.env,PATH:process.env.ACTIVE_BRIDGE_ORIGINAL_PATH,NODE_OPTIONS:""},stdio:"pipe",timeout:120000});
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
    TOOL_UPGRADE_NODE:process.execPath, ACTIVE_BRIDGE_ORIGINAL_PATH:process.env.PATH, NODE_OPTIONS:`--import=${pathToFileURL(preload).href}` }
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
  await npm(["install","--prefix",join(home,"releases","0.5.10"),baselineCLI,"--offline","--ignore-scripts","--no-audit","--no-fund"])
  const entryHash = sha256(await readFile(bootstrap))
  const bootstrapManifest = join(dirname(dirname(bootstrap)), "package.json"), bootstrapManifestBytes = await readFile(bootstrapManifest)
  assert.equal((await json(join(dirname(dirname(bootstrap)),"package.json"))).version,"0.5.10")
  const prefixModes = new Map()
  const sealPrefix = async path => {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return
    prefixModes.set(path, info.mode & 0o777)
    if (info.isDirectory()) for (const entry of await readdir(path)) await sealPrefix(join(path, entry))
    await chmod(path, info.mode & 0o555)
  }
  const helper = join(root,"caller.mjs")
  await build({entryPoints:[fileURLToPath(new URL("../src/runtime/fixtures/active-bridge-transition.ts",import.meta.url))],outfile:helper,bundle:true,
    // Inspection uses a capable caller identity after the feature reader floor.
    // Actual updater/capture execution is still pinned to installed archives.
    platform:"node",format:"esm",target:"node24",define:{__ATAPE_CLI_VERSION__:JSON.stringify(feature?.version ?? version),__ATAPE_CAPTURE_STATE_CONTRACT__:JSON.stringify("atape.client.v3-capture.v2"),"process.env.NODE_ENV":'"production"'},
    banner:{js:'import { createRequire as __atapeCreateRequire } from "node:module"; const require = __atapeCreateRequire(import.meta.url);'},logLevel:"silent"})
  const requestFile = join(root,"caller-request.json")
  const invoke = async phase => {
    await writeFile(requestFile,JSON.stringify({phase,root,baselineCodexTarball:await realpath(baselineCodex),baselineClaudeTarball:await realpath(baselineClaude),bootstrap,version}))
    const result=await execute(process.execPath,[helper,requestFile],{cwd:root,env:environment,encoding:"utf8",timeout:120_000,maxBuffer:4*1024*1024})
    return JSON.parse(result.stdout)
  }
  const entries = async () => (await optionalBytes(trace))?.toString("utf8").split("\n").filter(Boolean).map(JSON.parse) ?? []
  const captured = async file => (await optionalBytes(file))?.toString("utf8").split("\n").filter(Boolean).map(JSON.parse) ?? []
  const faultProcesses = new Set()
  const unchanged = async previous => {
    for (const [file, bytes] of previous) assert.deepEqual(await optionalBytes(file), bytes, `Protected state changed: ${file}`)
  }
  const credentialFiles = async () => (await readdir(join(home, "credentials"), { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith(".json")).map(entry => join(home, "credentials", entry.name))
  const selectedEntry = releaseVersion => join(home, "releases", releaseVersion, "node_modules", "@atape", "cli", "dist", "atape.js")
  const selectedHash = async (releaseVersion, artifacts) => {
    const hash = sha256(await readFile(selectedEntry(releaseVersion)))
    const packed = (await execute("tar", ["-xOf", artifacts["@atape/cli"].archive, "package/dist/atape.js"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 })).stdout
    assert.equal(hash, sha256(packed), "Selected executable must equal the exact packed candidate bytes")
    return hash
  }
  const waitSelected = async releaseVersion => {
    await waitFor(async () => {
      const state = await json(join(home, "updates", "state.json")).catch(cause => { if (missing(cause)) return undefined; throw cause })
      const workers = (await entries()).filter(entry => entry.args[0] === "__automatic-update")
      if (state?.failures > 0 && workers.every(worker => !alive(worker.pid))) {
        throw new Error(`Genuine automatic update failed before ${releaseVersion}: ${state.failure}`)
      }
      const selection = await json(join(home, "updates", "runtime.json")).catch(cause => { if (missing(cause)) return undefined; throw cause })
      const daemon = await json(join(home, "state", "collector-process.json")).catch(cause => { if (missing(cause)) return undefined; throw cause })
      return selection?.version === releaseVersion && workers.length > 0 && workers.every(worker => !alive(worker.pid)) && daemon?.pid && alive(daemon.pid)
    }, `Genuine active automatic update did not settle at ${releaseVersion}`)
    await waitFor(async () => {
      const status = (await invoke("snapshot")).status
      assert.equal(status.running, true)
      assert.equal(status.collectorFailure, undefined)
      return status.lastCycleCompletedAt && status.jobs.find(job => job.adapterId === "codex")?.state === "healthy"
    }, `Installed ${releaseVersion} Collector did not continue its first cycle`)
    const result = await invoke("snapshot")
    assert.equal(result.selection.version, releaseVersion)
    assert.equal(result.wanted, true)
    assert.equal(result.status.running, true)
    const providers = result.effective.adapters.filter(adapter => ["codex", "claude"].includes(adapter.adapterId))
    assert.equal(providers.length, 2)
    assert.ok(providers.every(adapter => adapter.version === releaseVersion), "Both real provider packages must be upgraded")
    assert.equal(await optionalBytes(join(home, "state", "collector-process.json.maintenance.json")), undefined)
    assert.equal(await optionalBytes(join(home, "updates", "target-update.json")), undefined)
    return result
  }
  const appendAndWait = async id => {
    const before = (await captured(captures)).length
    await appendFile(source, lines([item(id, "AgentMessage", "A forward continuation", "2026-10-11T00:00:03Z")]))
    await waitFor(async () => (await captured(captures)).slice(before).some(batch => batch.events.some(event => event.sourceEventId === id)),
      "The active selected Collector did not upload an appended native event")
    const events = (await captured(captures)).slice(before).flatMap(batch => batch.events)
    assert.deepEqual(events.map(event => event.sourceEventId), [id], "Continuation must not duplicate previously acknowledged Canonical events")
    return invoke("snapshot")
  }
  const interruptAndRecoverFeature = async () => {
    const marker = join(root, "fault-observed.json")
    await waitFor(async () => (await optionalBytes(marker)) !== undefined, "The real installed target did not reach the requested fault boundary")
    const interrupted = await json(marker), featureEntryHash = await selectedHash(feature.version, feature.packages)
    faultProcesses.add(interrupted.pid); faultProcesses.add(interrupted.parentPid)
    assert.equal(interrupted.point, faultPoint); assert.equal(interrupted.entrySha256, featureEntryHash)
    assert.equal(interrupted.controlPhase, "completed"); assert.equal(interrupted.targetVersion, feature.version)
    const priorEntries = await entries(), parent = priorEntries.filter(entry => entry.args[0] === "__automatic-update" && entry.sha256 !== entryHash && alive(entry.pid)).at(-1)
    assert.ok(parent, "Crash must interrupt the actual installed bridge automatic worker")
    faultProcesses.add(parent.pid)
    const activation = priorEntries.filter(entry => entry.args[0] === "__update-target" && entry.args.at(-1) === "activate" && alive(entry.pid)).at(-1)
    assert.ok(activation); assert.equal(activation.sha256, featureEntryHash)
    faultProcesses.add(activation.pid)
    process.kill(parent.pid, "SIGKILL")
    await waitFor(async () => !alive(parent.pid), "The genuine bridge parent did not exit after SIGKILL")
    if (faultPoint === "orphan-apply") process.kill(activation.pid, "SIGKILL")
    assert.equal(alive(interrupted.pid), true, "The exact target child must survive its parent interruption with OS-held exclusion")
    let queuedOldWorker
    if (faultPoint === "orphan-apply") {
      const beforeAttempt = interrupted.attempt, beforeCapture = await readFile(captures)
      assert.ok(beforeAttempt, "The orphan must hold an actual authorized apply attempt")
      const token = randomUUID(), worker = join(home, "updates", "workers", `${token}.mjs`)
      await copyFile(selectedEntry("0.5.10"), worker)
      assert.equal(sha256(await readFile(worker)), entryHash)
      const outcome = await execute(process.execPath, [worker, "__automatic-update", "--update-token", token], { cwd: root,
        env: { ...environment, ATAPE_UPDATE_WORKER_TOKEN: token, ATAPE_RUNTIME_DIRECT: "1" }, encoding: "utf8", timeout: 60_000,
        maxBuffer: 1024 * 1024 }).then(result => ({ exit: 0, ...result }), cause => ({ exit: cause.code, stderr: cause.stderr }))
      const ledger = await json(join(home, "updates", "capture-migration.json"))
      assert.equal(ledger.required.requirement.outerKey, interrupted.controlKey)
      assert.notEqual(ledger.attempt.attemptId, beforeAttempt.attemptId, "The genuine old worker must exercise current-format attempt supersession")
      assert.equal(ledger.phase, "applying"); assert.equal(alive(interrupted.pid), true)
      assert.deepEqual(await readFile(captures), beforeCapture, "No Collector may capture before stable handoff completion")
      assert.equal((await json(join(home, "updates", "control.json"))).phase, "completed")
      assert.equal((await json(join(home, "updates", "runtime.json"))).version, feature.version)
      queuedOldWorker = { actualEntrySha256: entryHash, attemptSuperseded: true, orphanApplyExclusionPreserved: true, exit: outcome.exit }
      // Current Stop intent is independent of target-private recovery state.
      assert.equal((await invoke("request-stop")).wanted, false)
    }
    process.kill(interrupted.pid, "SIGKILL")
    await waitFor(async () => !alive(interrupted.pid), "The orphan did not release its process-owned locks after SIGKILL")
    const recovery = JSON.parse((await execute("python3", [fileURLToPath(new URL("verify-active-bridge-recovery-terminal.py", import.meta.url)), bootstrap, root, feature.version],
      { cwd: root, env: environment, encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024 })).stdout)
    assert.equal(recovery.actualPublicBootstrapRecovery, true)
    assert.equal(sha256(await readFile(bootstrap)), entryHash)
    assert.ok((await entries()).some(entry => entry.entry === bootstrap && entry.args.length === 0 && entry.sha256 === entryHash))
    assert.ok((await entries()).some(entry => entry.args[0] === "__update-target" && entry.args.at(-1) === "recover" && entry.sha256 === featureEntryHash),
      "The unchanged actual old public entry must reach exact target-owned recovery")
    if (queuedOldWorker) {
      const stopped = await invoke("snapshot")
      assert.equal(stopped.wanted, false); assert.equal(stopped.status.running, false)
      await invoke("start")
    }
    return { point: faultPoint, actualTargetEntrySha256: featureEntryHash, actualParentSIGKILL: true,
      actualOrphanSIGKILL: true, actualOldPublicBootstrapRecovery: true, completedControlThroughout: true,
      ...(queuedOldWorker ? { queuedOldWorker, stopPreservedAcrossRecovery: true } : {}) }
  }
  try {
    await invoke("setup")
    await sealPrefix(prefix)
    const before = await invoke("snapshot"), originalPid = before.status.pid
    assert.equal(before.status.running, true); assert.equal(before.wanted, true)
    assert.equal(before.selection.version, "0.5.10")
    const oldDaemon = (await entries()).find(entry => entry.args[0] === "__collector-daemon" && entry.pid === originalPid)
    assert.equal(oldDaemon?.sha256, entryHash, "Initial active Collector must execute genuine npm-published 0.5.10 bytes")
    assert.equal(JSON.parse(Buffer.from(before.state.checkpoint.cursor, "base64url").toString("utf8")).eventProjectionVersion, 5)
    assert.equal(before.state.checkpoint.rawObjects.length, 1)
    assert.ok(before.state.checkpoint.rawObjects[0].serverOffset > 0)
    assert.equal(before.status.jobs.find(job => job.adapterId === "claude")?.state, "healthy",
      "The actual baseline Claude SourceCapture cycle must open its journal before empty discovery")
    const journalKey = sha256(JSON.stringify(["https://upgrade-fixture.invalid", "upgrade-user"]))
    const journalPath = join(home, "state", "collector.json.captures", `${journalKey}.sqlite`)
    const journalBinding = { instanceOrigin: "https://upgrade-fixture.invalid", userId: "upgrade-user", installationId: before.state.installationId }
    const installation = await json(join(home, "state", "collector.json.capture-installation.json"))
    assert.equal(installation.protocol, "atape.capture-installation.v1"); assert.equal(installation.phase, "ready")
    assert.equal(installation.installationId, journalBinding.installationId)
    assert.deepEqual(installation.accounts, [{ key: journalKey, phase: "ready" }])
    assert.deepEqual(await json(join(dirname(journalPath), `${journalKey}.binding.json`)),
      { protocol: "atape.capture-account.v1", ...journalBinding, phase: "ready" })
    assert.equal((await lstat(journalPath)).isFile(), true)
    const baselineJournalVersion = journalVersion(journalPath)
    assert.ok([7, 8].includes(baselineJournalVersion), "The genuine baseline must create a supported registered journal")
    const oldBatches = await captured(captures), oldEvents = oldBatches.flatMap(batch => batch.events)
    assert.equal(oldEvents.length, 4)
    assert.ok(oldBatches.every(batch => batch.canonicalProfileVersion === "atape.acp-centered.v3"))
    assert.equal(oldEvents.find(event => event.sourceEventId === "clock-unknown").occurredAt, null)
    const oldTool = JSON.parse(oldEvents.find(event => event.toolUpdateJson).toolUpdateJson)
    assert.equal(oldTool._meta, undefined); assert.equal(oldTool.rawInput, undefined)
    const credentials = new Map(await Promise.all((await credentialFiles()).map(async file => [file, await readFile(file)])))
    const rawBefore = await readFile(rawCaptures)
    distribution.serverVersion = feature?.version ?? version; distribution.minimumCLIVersion = feature?.version ?? version
    await writeFile(publicRelease, JSON.stringify(distribution))
    await invoke("enable-auto")
    await invoke("dispatch")
    const bridge = await waitSelected(version), bridgeEntryHash = await selectedHash(version, publicPackages)
    assert.equal(alive(originalPid), false)
    const oldWorkers = (await entries()).filter(entry => entry.args[0] === "__automatic-update" && entry.sha256 === entryHash)
    assert.ok(oldWorkers.length > 0, "The real published .10 automatic worker must perform the bridge handoff")
    assert.ok(oldWorkers.every(worker => !alive(worker.pid)))
    assert.equal((await entries()).find(entry => entry.args[0] === "__collector-daemon" && entry.pid === bridge.status.pid)?.sha256, bridgeEntryHash)
    assert.deepEqual(bridge.config.projects, before.config.projects)
    assert.deepEqual(bridge.config.enabledAdapterIds, before.config.enabledAdapterIds)
    assert.equal(bridge.config.autoUpdateEnabled, true); assert.equal(bridge.config.autoStartEnabled, false)
    const acknowledgedProgress = checkpoint => {
      const { adapterVersion, revision, updatedAt, ...progress } = checkpoint
      return progress
    }
    assert.equal(bridge.state.checkpoint.adapterVersion, version)
    assert.ok(bridge.state.checkpoint.revision > before.state.checkpoint.revision)
    assert.deepEqual(acknowledgedProgress(bridge.state.checkpoint), acknowledgedProgress(before.state.checkpoint),
      "Authentic bridge must preserve acknowledged cursor, Raw receipts, policy and conversation scope")
    assert.deepEqual(await readFile(rawCaptures), rawBefore)
    assert.equal((await captured(captures)).length, oldBatches.length, "Identical old projection must not replay Canonical events")
    assert.equal(sha256(await readFile(bootstrap)), entryHash, "Automatic handoff must preserve the genuine old bootstrap bytes")
    await unchanged(credentials)
    const bridgeContinued = await appendAndWait("clock-bridge-appended")
    assert.ok(bridgeContinued.state.checkpoint.rawObjects[0].serverOffset > before.state.checkpoint.rawObjects[0].serverOffset)
    assert.equal(bridgeContinued.state.checkpoint.rawObjects[0].sourceGeneration, before.state.checkpoint.rawObjects[0].sourceGeneration)
    assert.ok((await captured(captures)).every(batch => batch.canonicalProfileVersion === "atape.acp-centered.v3"))
    // This explicit negative fixture documents the frozen .10 bootstrap's
    // decoder boundary. It is not a feature-runtime success substitute.
    await npm(["install", "--prefix", join(root, "old-bootstrap-boundary", "releases", version), publicPackages["@atape/cli"].archive,
      "--offline", "--ignore-scripts", "--no-audit", "--no-fund"])
    const boundary = await invoke("seed-old-bootstrap-boundary"), ledgerBefore = await readFile(boundary.ledger)
    const oldBoundary = JSON.parse((await execute("python3", [fileURLToPath(new URL("verify-old-bootstrap-boundary.py", import.meta.url)), boundary.oldEntry, root],
      { cwd: root, env: { ...environment, ATAPE_HOME: boundary.home, ATAPE_RUNTIME_DIRECT: "0" }, encoding: "utf8", timeout: 45_000, maxBuffer: 1024 * 1024 })).stdout)
    assert.equal(oldBoundary.oldBootstrapRejectedUnknownCaptureLedger, true)
    assert.deepEqual(await readFile(boundary.ledger), ledgerBefore)
    assert.equal((await entries()).find(entry => entry.entry === boundary.oldEntry && entry.args.length === 0)?.sha256, entryHash)
    let final = bridgeContinued, featureEvidence
    if (feature) {
      const preceding = await captured(captures), previousEvents = preceding.flatMap(batch => batch.events)
      const previousRaw = await readFile(rawCaptures), previousRawObjects = bridgeContinued.state.checkpoint.rawObjects
      const previousJournalVersion = journalVersion(journalPath)
      assert.ok([7, 8].includes(previousJournalVersion))
      // Advance only the owned clock Seam. Do not edit the updater's private schedule
      // or force/manual-update APIs to manufacture an automatic second leg.
      distribution.clockOffsetMs += 2 * 24 * 60 * 60 * 1000
      distribution.serverVersion = feature.version; distribution.minimumCLIVersion = feature.version
      await writeFile(publicRelease, JSON.stringify(distribution))
      await invoke("dispatch")
      const recoveryEvidence = faultPoint ? await interruptAndRecoverFeature() : undefined
      const featureState = await waitSelected(feature.version), featureEntryHash = await selectedHash(feature.version, feature.packages)
      const targetControl = await json(join(home, "updates", "control.json"))
      assert.equal(targetControl.phase, "completed"); assert.equal(targetControl.forwardOnly, true)
      assert.equal(targetControl.target.version, feature.version)
      const migration = await json(join(home, "updates", "capture-migration.json"))
      const requirement = migration.required.requirement, receipt = migration.receipt
      assert.equal(migration.protocol, "atape.capture-migration.v1"); assert.equal(migration.phase, "completed")
      assert.equal(migration.attempt, undefined)
      assert.deepEqual(migration.required, await json(join(home, "updates", "capture-migration.required.json")))
      assert.equal(requirement.outerKey, targetControl.key); assert.equal(requirement.source.version, version)
      assert.deepEqual(requirement.target, targetControl.target); assert.deepEqual(requirement.bundle.packages, feature.bundle.packages)
      assert.deepEqual(requirement.inventory.map(account => account.key), [journalKey])
      const account = requirement.inventory[0]
      assert.equal(account.path, journalPath); assert.deepEqual(account.binding, journalBinding)
      assert.equal(account.installationId, journalBinding.installationId); assert.equal(account.format, previousJournalVersion)
      assert.equal(account.deferred, false)
      assert.equal(receipt.protocol, "atape.capture-migration-receipt.v1"); assert.equal(receipt.planId, "journal-v7-to-v8")
      assert.equal(receipt.outerKey, targetControl.key); assert.equal(receipt.requirementHash, requirement.hash)
      assert.equal(receipt.bundleFingerprint, requirement.bundleFingerprint)
      assert.deepEqual(receipt.target, { version: feature.version, captureStateContract: feature.bundle.captureStateContract })
      assert.deepEqual(receipt.accounts, [{ key: journalKey, bindingHash: account.bindingHash, result: "v8" }])
      assert.deepEqual(migration.progress, receipt.accounts); assert.equal(journalVersion(journalPath), 8)
      const targetOwner = await json(join(home, "updates", "target-owner.json"))
      assert.equal(targetOwner.protocol, "atape.update-target.v1"); assert.deepEqual(targetOwner.bundle, feature.bundle)
      assert.equal(targetOwner.entrySha256, featureEntryHash); assert.equal(targetOwner.bootstrapEntry, bootstrap)
      assert.equal(targetOwner.paths.atapeHome, home)
      await waitFor(async () => (await captured(captures)).slice(preceding.length).some(batch => batch.canonicalProfileVersion === "atape.acp-centered.v5"),
        "Installed feature Collector did not replay native history to v5")
      const replay = (await captured(captures)).slice(preceding.length)
      assert.ok(replay.every(batch => batch.canonicalProfileVersion === "atape.acp-centered.v5"))
      const replayed = replay.flatMap(batch => batch.events)
      assert.deepEqual(new Set(replayed.map(event => event.sourceEventId)), new Set(previousEvents.map(event => event.sourceEventId)))
      for (const event of replayed) {
        assert.equal(event.projectionRevision, 7)
        assert.ok(event.revision > previousEvents.find(old => old.sourceEventId === event.sourceEventId).revision)
      }
      const files = replayed.filter(event => event.toolUpdateJson).map(event => JSON.parse(event.toolUpdateJson)).find(update => update.toolCallId === "clock-files")
      assert.deepEqual(files._meta["atape.dev/tool-identity"], { type: "tool", name: "CommandExecution" })
      assert.deepEqual(files._meta["atape.dev/file-activity"], [{ operation: "read", path: "src/main.ts" }, { operation: "search", path: "src" }])
      assert.deepEqual(files.rawInput, { parsed_cmd: [{ type: "read", path: "src/main.ts" }, { type: "search", path: "src" }] })
      const replayState = await invoke("snapshot")
      assert.equal(JSON.parse(Buffer.from(replayState.state.checkpoint.cursor, "base64url").toString("utf8")).eventProjectionVersion, 7)
      assert.deepEqual(replayState.state.checkpoint.rawObjects, previousRawObjects)
      assert.deepEqual(await readFile(rawCaptures), previousRaw)
      const bridgeWorkers = (await entries()).filter(entry => entry.args[0] === "__automatic-update" && entry.sha256 === bridgeEntryHash)
      assert.ok(bridgeWorkers.length > 0, "Second leg must execute the actual installed bridge worker")
      assert.equal(sha256(await readFile(bootstrap)), entryHash)
      const targets = (await entries()).filter(entry => entry.args[0] === "__update-target")
      assert.ok(targets.some(entry => entry.args.at(-1) === "prepare") && targets.some(entry => entry.args.at(-1) === "activate"))
      assert.ok(targets.every(entry => entry.sha256 === featureEntryHash), "Target preparation and activation must use the immutable feature executable")
      assert.equal((await entries()).find(entry => entry.args[0] === "__collector-daemon" && entry.pid === featureState.status.pid)?.sha256, featureEntryHash)
      const requested = await captured(requests)
      const instanceReadbacks = requested.filter(request => request.address === "https://upgrade-fixture.invalid/api/v1/instance")
      assert.ok(instanceReadbacks.some(request => request.pid === originalPid || oldWorkers.some(worker => worker.pid === request.pid)),
        "The genuine .10 caller must observe the already-upgraded Server")
      assert.ok(instanceReadbacks.length > 0 && instanceReadbacks.every(request =>
        request.serverVersion === feature.version && request.minimumCLIVersion === feature.version),
        "All installed callers must see the future Server version and minimum CLI from the first leg onward")
      // The genuine old Collector may discover and cache the immutable v2
      // descriptor before dispatch; its copied worker then consumes that cache.
      const oldCollector = (await entries()).find(entry => entry.args[0] === "__collector-daemon" && entry.pid === originalPid)
      assert.equal(oldCollector?.sha256, entryHash)
      assert.ok(requested.some(request => request.address === releaseCatalogURL("atape.update-catalog.v2") &&
        (request.pid === originalPid || oldWorkers.some(worker => worker.pid === request.pid))))
      assert.ok(requested.some(request => request.address === releaseCatalogURL("atape.update-catalog.v3") && bridgeWorkers.some(worker => worker.pid === request.pid)))
      final = await appendAndWait("clock-feature-appended")
      assert.equal(final.state.checkpoint.rawObjects[0].sourceGeneration, previousRawObjects[0].sourceGeneration)
      assert.ok(final.state.checkpoint.rawObjects[0].serverOffset > previousRawObjects[0].serverOffset)
      assert.equal(await optionalBytes(join(home, "updates", "target-update.json")), undefined)
      featureEvidence = { version: feature.version, entrySha256: featureEntryHash, cliIntegrity: feature.packages["@atape/cli"].manifest.dist.integrity,
        bundle: feature.bundle, actualBridgeAutomaticWorker: true, actualTargetPrepareAndActivate: true,
        nonEmptyCaptureMigrationReceiptVerified: true, registeredCaptureAccountsVerified: receipt.accounts.length,
        sourceJournalVersion: previousJournalVersion, targetJournalVersion: 8, targetOwnerVerified: true,
        nativeV5Replay: true, eventIDsPreserved: true, revisionsAdvanced: true, rawReceiptsPreservedAcrossReplay: true,
        nativeFileActivityReplayed: true, appendedContinuation: true, lateOfflineLegacyRoutesRetained: true,
        retainedOldBootstrapRejectedUnknownCaptureLedger: true, globalBootstrapBytesPreserved: true,
        serverUpgradedBeforeLegacyClient: true, serverVersionReadbacks: instanceReadbacks.length,
        ...(recoveryEvidence ? { recovery: recoveryEvidence } : {}) }
    }
    await unchanged(credentials)
    assert.deepEqual(final.config.projects, before.config.projects)
    assert.deepEqual(final.config.enabledAdapterIds, before.config.enabledAdapterIds)
    assert.equal(final.wanted, true)
    assert.equal(sha256(await readFile(bootstrap)), entryHash)
    assert.deepEqual(await readFile(bootstrapManifest), bootstrapManifestBytes)
    await invoke("disable-auto")
    await invoke("stop")
    const stopped = await invoke("snapshot")
    assert.equal(stopped.wanted, false); assert.equal(stopped.status.running, false)
    const progress = await readFile(join(home, "state", "collector.json")), workerCount = (await entries()).filter(entry => entry.args[0] === "__automatic-update").length
    const activationCount = (await entries()).filter(entry => entry.args[0] === "__update-target" && entry.args.at(-1) === "activate").length
    distribution.clockOffsetMs += 2 * 24 * 60 * 60 * 1000
    await writeFile(publicRelease, JSON.stringify(distribution))
    await invoke("dispatch")
    await new Promise(resolve => setTimeout(resolve, 250))
    await waitFor(async () => (await entries()).filter(entry => entry.args[0] === "__automatic-update").every(worker => !alive(worker.pid)),
      "Stopped/off inspection recovery did not settle")
    const stillStopped = await invoke("snapshot")
    assert.equal(stillStopped.status.running, false); assert.equal(stillStopped.wanted, false)
    assert.equal(stillStopped.config.autoUpdateEnabled, false)
    // An older inspecting caller may route recovery to the completed target
    // owner even with updates off. It cannot authorize another activation.
    if (!feature) assert.equal((await entries()).filter(entry => entry.args[0] === "__automatic-update").length, workerCount)
    assert.equal((await entries()).filter(entry => entry.args[0] === "__update-target" && entry.args.at(-1) === "activate").length, activationCount)
    assert.equal(stillStopped.selection.version, final.selection.version)
    assert.deepEqual(await readFile(join(home, "state", "collector.json")), progress)
    const nativeProbes = await captured(native)
    // A real public console inspects manager availability for its Tools page.
    // The isolated Adapter rejects that read too; no OS command is executed.
    assert.ok(nativeProbes.every(call => call.rejected === true && call.method === "execFile" && Array.isArray(call.args) &&
      (basename(call.file) === "launchctl" && call.args.length === 2 && call.args[0] === "print" && /^gui\/\d+$/.test(call.args[1]) ||
       basename(call.file) === "systemctl" && JSON.stringify(call.args) === JSON.stringify(["--user", "show-environment"]))),
    "Isolated acceptance forbids native registration mutations and browser requests")
    assert.ok((await captured(calls)).every(args => args[0] !== "install" || !args.includes("--global")))
    for (const path of prefixModes.keys()) assert.equal((await lstat(path)).mode & 0o222, 0, "Global prefix must remain read-only throughout acceptance")
    const record = { baselineVersion: "0.5.10", baselineIntegrities: activeBridgeBaselineIntegrities, baselineEntrySha256: entryHash,
      bridgeVersion: version, bridgeEntrySha256: bridgeEntryHash, bridgeCLIIntegrity: publicPackages["@atape/cli"].manifest.dist.integrity,
      bridgeBundle: bundle, actualPublishedOldAutomaticWorker: true, oldManifestDecoderAcceptedActualBridgePackages: true,
      activeCollectorContinued: true, wantedPreserved: true, bootstrapBytesPreservedAtFirstHandoff: true, globalBootstrapBytesPreserved: true,
      globalNPMPrefixReadOnly: true, automaticGlobalInstallForbidden: true, projectsAndToolsPreserved: true,
      credentialBytesPreserved: true, acknowledgedCaptureProgressPreserved: true, canonicalBridgeNoReplay: true,
      rawReceiptsPreserved: true, appendedContinuation: true, stopAndUpdatesOffPreserved: true,
      retainedOldBootstrapRejectedUnknownCaptureLedger: true,
      actualBaselineClaudeJournalRegistered: true, baselineJournalVersion,
      fullChain: feature ? "passed-with-controlled-installed-candidate-artifacts" : "not-tested-feature-artifacts-not-supplied",
      ...(featureEvidence ? { feature: featureEvidence } : {}),
      providerCaptureTested: "constructed native-format Codex source through genuine installed readers; actual Claude packages installed and admitted, Claude live source not exercised",
      realOSRegistrationTested: false, rejectedReadOnlyManagerProbes: nativeProbes.length,
      server: "owned authenticated HTTP Test Adapter; no deployed Instance touched" }
    await writeFile(join(root, "active-bridge-upgrade-acceptance.json"), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 })
    return record
  } finally {
    try {
      // A failed assertion must not leave an intentionally SIGSTOP'd fixture
      // process holding OS leases after its disposable storage is removed.
      const marker = await json(join(root, "fault-observed.json")).catch(cause => { if (missing(cause)) return undefined; throw cause })
      if (marker) { faultProcesses.add(marker.pid); faultProcesses.add(marker.parentPid) }
      const recorded = await entries()
      for (const entry of recorded) if (["__automatic-update", "__update-target", "__capture-migration-apply"].includes(entry.args[0]))
        faultProcesses.add(entry.pid)
      for (const pid of faultProcesses) {
        const record = recorded.find(entry => entry.pid === pid && entry.entry.startsWith(`${root}/`))
        if (!record || !alive(pid)) continue
        const command = await execute("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5_000 }).catch(() => undefined)
        if (command?.stdout.includes(record.entry)) {
          try { process.kill(pid, "SIGKILL") } catch (cause) { if (cause.code !== "ESRCH") throw cause }
        }
      }
      await invoke("cleanup")
    }
    finally { for (const [path, mode] of prefixModes) await chmod(path, mode) }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [releaseDirectory, fixtureDirectory, baselineCLI, baselineCodex, baselineClaude, version, featureDirectory, featureVersion, faultPoint] = process.argv.slice(2)
  if (!version || Boolean(featureDirectory) !== Boolean(featureVersion)) throw new Error("usage: verify-active-bridge-upgrade.mjs bridge-dir fixture-dir genuine-cli-.10.tgz genuine-codex-.10.tgz genuine-claude-.10.tgz bridge-version [feature-dir feature-version]")
  process.stdout.write(JSON.stringify(await verifyActiveBridgeUpgrade(releaseDirectory, fixtureDirectory, baselineCLI, baselineCodex, baselineClaude, version,
    featureDirectory ? { directory: featureDirectory, version: featureVersion, ...(faultPoint ? { faultPoint } : {}) } : undefined)) + "\n")
}
