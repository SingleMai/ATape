import { CLICredentialStore } from "@atape/application"
import { AdapterManifest, AdapterProtocolVersion, PublicationTargetProfile2, PublicationTargetProfile3, SourceCaptureVersion, SourceCaptureVersion2,
  emptyClientConfig, type ClientConfig, type StoredCLICredential } from "@atape/domain"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeCredentialStoreLayer } from "./authenticationLayers.ts"
import { defaultNodeClientPaths } from "./clientPaths.ts"
import { inspectCaptureMigrationPrerequisitesScope, makeCaptureMigrationPrerequisitesLayer,
  preflightCaptureMigrationPrerequisites, type CaptureMigrationScope } from "./captureMigrationPrerequisites.ts"

const temporaryDirectories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const capabilities = {
  protocol: "atape.publication.v1", targetProfile: "atape.publication-target.v1",
  targetProfiles: ["atape.publication-target.v1", "atape.publication-target.v2"], legacyAdoption: true,
  limits: { partBytes: 4096, targetBytes: 1_000_000, userPendingBytes: 2_000_000, parts: 100,
    reservations: 16, reservationLifetimeMs: 60_000, leaseLifetimeMs: 30_000 }, statusPageSize: 100, reclaimPageSize: 32
}
const credential = (origin = "https://atape.net", id = "user-1"): StoredCLICredential => ({
  version: 1, instanceOrigin: origin, apiOrigin: origin.replace("https://", "https://api."),
  credential: "atc_v1_private-preflight", credentialId: `credential-${id}`, capabilityVersion: "atape-cli.v1",
  createdAt: "2026-10-10T00:00:00Z", user: { id, displayName: "Private account" }
})
const metadata = (stored: StoredCLICredential) => ({ protocol: "atape.instance.v1",
  instance_origin: stored.instanceOrigin, web_origin: stored.instanceOrigin, api_origin: stored.apiOrigin,
  protocols: ["atape.cli-authorization.v1", "atape.canonical.v1"], release_version: "0.5.5",
  auth_epoch: "auth-v1", minimum_cli_version: "0.2.0" })
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" }
})
const snapshot = async (directory: string): Promise<Record<string, string>> => {
  const files: Record<string, string> = {}
  const visit = async (root: string, prefix = "") => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const key = `${prefix}${entry.name}`
      if (entry.isDirectory()) await visit(join(root, entry.name), `${key}/`)
      else files[key] = (await readFile(join(root, entry.name))).toString("base64")
    }
  }
  await visit(directory)
  return files
}

const fixture = async (adapterId: "claude" | "cursor" = "claude") => {
  const home = await mkdtemp(join(tmpdir(), "atape-capture-prerequisites-"))
  temporaryDirectories.push(home)
  const paths = defaultNodeClientPaths({ ATAPE_HOME: home })
  const packageName = `@atape/adapter-${adapterId}`
  const root = join(paths.adapterDirectory, "node_modules", "@atape", `adapter-${adapterId}`)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const manifest = adapterId === "cursor" ? { ...Schema.decodeUnknownSync(AdapterManifest)(
    (JSON.parse(await readFile(new URL("../../../../adapters/cursor/package.json", import.meta.url), "utf8")) as { atapeAdapter: unknown }).atapeAdapter),
    entry: "./index.mjs" } : { protocolVersion: AdapterProtocolVersion, adapterId: "claude", displayName: "Claude",
    entry: "./index.mjs", harnesses: ["claude"], sourceCapture: SourceCaptureVersion2 }
  const saveManifest = async (sourceCapture: typeof SourceCaptureVersion | typeof SourceCaptureVersion2 = SourceCaptureVersion2,
    publicationTargetProfile: unknown = "publicationTargetProfile" in manifest ? manifest.publicationTargetProfile : undefined) =>
    writeFile(join(root, "package.json"), JSON.stringify({ name: packageName, version: "0.5.6",
      atapeAdapter: { ...manifest, sourceCapture, publicationTargetProfile } }), { mode: 0o600 })
  await saveManifest()
  await writeFile(join(root, "index.mjs"), 'throw new Error("Preflight must never import a provider factory")', { mode: 0o600 })
  const project = { id: "project-1", instanceOrigin: "https://atape.net", userId: "user-1", teamId: "team-1",
    teamSlug: "team", teamName: "Team", name: "Project", type: "directory" as const,
    path: "/private/source-history-must-not-be-read", createdAt: "2026-10-10T00:00:00Z" }
  const config: ClientConfig = { ...emptyClientConfig(), toolsConfigured: true, enabledAdapterIds: [adapterId],
    adapters: [{ adapterId, packageName, upgradeSpec: packageName,
      displayName: manifest.displayName, version: "0.5.6", installedAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z" }],
    projects: [project] }
  const store = makeCredentialStoreLayer(paths.atapeHome, paths.credentialDirectory)
  const saveCredential = (stored: StoredCLICredential) => CLICredentialStore.use(service => Effect.gen(function*() {
    const previous = yield* service.read(stored.instanceOrigin)
    yield* service.replace({ credential: stored, ...(previous ? { expectedCredentialId: previous.credentialId } : {}) })
  }))
    .pipe(Effect.provide(store), Effect.runPromise)
  const requests: { url: string; init: RequestInit | undefined }[] = []
  const credentials = [credential()]
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, init })
    const stored = credentials.find(item => url === `${item.instanceOrigin}/api/v1/instance`)
    if (stored) return response(metadata(stored))
    if (credentials.some(item => url === `${item.apiOrigin}/api/v1/publications/capabilities`)) return response(capabilities)
    throw new Error("Unexpected request outside read-only prerequisites")
  }) as typeof globalThis.fetch
  const run = (scope: CaptureMigrationScope = { candidateConfig: config, wanted: true }, implementation = fetch) =>
    preflightCaptureMigrationPrerequisites(paths, scope).pipe(
      Effect.provide(makeCaptureMigrationPrerequisitesLayer(paths, {}, implementation)), Effect.runPromise)
  return { home, paths, root, config, project, credentials, requests, fetch, run, saveManifest, saveCredential }
}

describe("capture migration read-only prerequisite Interface", () => {
  it("checks v2 capabilities through pinned GET authentication without loading source or mutating local files", async () => {
    const f = await fixture()
    await f.saveCredential(credential())
    // Raw consent is independent of Canonical v2 work; its persisted files are inert here.
    await writeFile(join(f.home, "privacy-off.json"), '{"rawEnabled":false}')
    const before = await snapshot(f.home)
    const local = await inspectCaptureMigrationPrerequisitesScope(f.paths, { candidateConfig: f.config, wanted: true })
    expect(f.requests).toEqual([])
    expect(await f.run()).toEqual(local)
    expect(local.prerequisiteScopeFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(f.requests.map(item => item.url)).toEqual(["https://atape.net/api/v1/instance",
      "https://api.atape.net/api/v1/publications/capabilities"])
    expect(f.requests.every(item => item.init?.method === "GET" && item.init.body === undefined && item.init.redirect === "error")).toBe(true)
    expect(f.requests.map(item => new Headers(item.init?.headers).get("X-Atape-Device"))).toEqual([null, null])
    expect(f.requests.map(item => new Headers(item.init?.headers).get("ATape-Accept-Publication-Target"))).toEqual([null, null])
    expect(new Headers(f.requests[0]?.init?.headers).get("authorization")).toBeNull()
    expect(new Headers(f.requests[1]?.init?.headers).get("authorization")).toBe(`Bearer ${credential().credential}`)
    expect(await snapshot(f.home)).toEqual(before)
    expect(JSON.stringify(local)).not.toMatch(/private|user-1|credential|https:/)
  })

  it("defers an enabled Cursor candidate on a v2-only Server before changing local state", async () => {
    const f = await fixture("cursor")
    await f.saveCredential(credential())
    const before = await snapshot(f.home)
    await expect(f.run()).rejects.toMatchObject({ reason: "capability" })
    const request = f.requests.find(item => item.url.endsWith("/publications/capabilities"))
    expect(new Headers(request?.init?.headers).get("ATape-Accept-Publication-Target")).toBe(PublicationTargetProfile3)
    expect(new Headers(request?.init?.headers).get("X-Atape-Device")).toBeNull()
    expect(await snapshot(f.home)).toEqual(before)
  })

  it("negotiates Cursor's actual manifest minimum for every Project account without importing the provider", async () => {
    const f = await fixture("cursor"), other = credential("https://other.example", "user-2")
    f.credentials.push(other)
    await f.saveCredential(credential()); await f.saveCredential(other)
    const config = { ...f.config, projects: [f.project, { ...f.project, id: "project-2" },
      { ...f.project, id: "project-3", instanceOrigin: other.instanceOrigin, userId: other.user.id }] }
    const before = await snapshot(f.home)
    const fetch = (async (input, init) => {
      const original = await f.fetch(input, init)
      if (!String(input).endsWith("/capabilities")) return original
      // The Server advertises v3 only to an opted-in Host, matching its real negotiation.
      return response(new Headers(init?.headers).get("ATape-Accept-Publication-Target") === PublicationTargetProfile3
        ? { ...capabilities, targetProfiles: [...capabilities.targetProfiles, PublicationTargetProfile3] } : capabilities)
    }) as typeof globalThis.fetch
    expect(await f.run({ candidateConfig: config, wanted: true }, fetch)).toEqual(
      await inspectCaptureMigrationPrerequisitesScope(f.paths, { candidateConfig: config, wanted: true }))
    const requests = f.requests.filter(item => item.url.endsWith("/publications/capabilities"))
    expect(requests.map(item => item.url).sort()).toEqual([
      "https://api.atape.net/api/v1/publications/capabilities", "https://api.other.example/api/v1/publications/capabilities"])
    expect(requests.every(item => item.init?.method === "GET" && item.init.body === undefined &&
      new Headers(item.init.headers).get("ATape-Accept-Publication-Target") === PublicationTargetProfile3 &&
      new Headers(item.init.headers).get("X-Atape-Device") === null)).toBe(true)
    expect(await snapshot(f.home)).toEqual(before)
  })

  it.each(["stopped", "disabled"] as const)("does no credential or remote work for %s Cursor", async mode => {
    const f = await fixture("cursor"), before = await snapshot(f.home)
    await f.run({ candidateConfig: mode === "disabled" ? { ...f.config, enabledAdapterIds: [] } : f.config,
      wanted: mode !== "stopped" })
    expect(f.requests).toEqual([])
    expect(await snapshot(f.home)).toEqual(before)
  })

  it("accepts an explicit v2 minimum without negotiating or requiring v3", async () => {
    const f = await fixture(); await f.saveCredential(credential())
    await f.saveManifest(SourceCaptureVersion2, PublicationTargetProfile2)
    await f.run()
    expect(f.requests.map(item => new Headers(item.init?.headers).get("ATape-Accept-Publication-Target"))).toEqual([null, null])
  })

  it.each([false, true])("requires an installed v3 Adapter's minimum only when enabled (%s)", async enabled => {
    const f = await fixture(), cursor = await fixture("cursor")
    await f.saveCredential(credential())
    await cp(cursor.root, join(f.paths.adapterDirectory, "node_modules", "@atape", "adapter-cursor"), { recursive: true })
    const config = { ...f.config, adapters: [...f.config.adapters, ...cursor.config.adapters],
      enabledAdapterIds: enabled ? ["claude", "cursor"] : ["claude"] }
    const before = await snapshot(f.home)
    const result = f.run({ candidateConfig: config, wanted: true })
    if (enabled) await expect(result).rejects.toMatchObject({ reason: "capability" })
    else await expect(result).resolves.toMatchObject({ prerequisiteScopeFingerprint: expect.any(String) })
    const request = f.requests.find(item => item.url.endsWith("/publications/capabilities"))
    expect(new Headers(request?.init?.headers).get("ATape-Accept-Publication-Target")).toBe(enabled ? PublicationTargetProfile3 : null)
    expect(await snapshot(f.home)).toEqual(before)
  })

  it.each([null, "atape.publication-target.v4", PublicationTargetProfile3])(
    "rejects an unsupported or misplaced manifest declaration before remote work (%j)", async publicationTargetProfile => {
      const f = await fixture(); await f.saveCredential(credential())
      await f.saveManifest(publicationTargetProfile === PublicationTargetProfile3 ? SourceCaptureVersion : SourceCaptureVersion2,
        publicationTargetProfile)
      const before = await snapshot(f.home)
      await expect(f.run()).rejects.toMatchObject({ reason: "metadata" })
      expect(f.requests).toEqual([])
      expect(await snapshot(f.home)).toEqual(before)
    })

  it("binds changes to the declared Server minimum into the parent's local scope fingerprint", async () => {
    const f = await fixture(); await f.saveCredential(credential())
    const scope = { candidateConfig: f.config, wanted: true }
    const initial = await inspectCaptureMigrationPrerequisitesScope(f.paths, scope)
    await f.saveManifest(SourceCaptureVersion2, PublicationTargetProfile3)
    expect(await inspectCaptureMigrationPrerequisitesScope(f.paths, scope)).not.toEqual(initial)
    expect(f.requests).toEqual([])
  })

  it.each(["stopped", "unconfigured", "no-projects", "disabled", "v1"] as const)(
    "does no remote or credential-directory work for %s capture", async mode => {
      const f = await fixture()
      const config = { ...f.config, ...(mode === "unconfigured" ? { toolsConfigured: false } : {}),
        ...(mode === "no-projects" ? { projects: [] } : {}), ...(mode === "disabled" ? { enabledAdapterIds: [] } : {}) }
      if (mode === "v1") await f.saveManifest(SourceCaptureVersion)
      const before = await snapshot(f.home)
      await f.run({ candidateConfig: config, wanted: mode !== "stopped" })
      expect(f.requests).toEqual([])
      expect(await snapshot(f.home)).toEqual(before)
    })

  it("checks every configured Project account, deduplicates scope, and ignores the console account preference", async () => {
    const f = await fixture(), other = credential("https://other.example", "user-2")
    f.credentials.push(other)
    await f.saveCredential(credential()); await f.saveCredential(other)
    const config = { ...f.config, activeInstanceOrigin: "https://atape.net", projects: [f.project,
      { ...f.project, id: "project-2" }, { ...f.project, id: "project-3", instanceOrigin: other.instanceOrigin, userId: other.user.id }] }
    await f.run({ candidateConfig: config, wanted: true })
    expect(f.requests.filter(item => item.url.endsWith("/publications/capabilities")).map(item => item.url).sort())
      .toEqual(["https://api.atape.net/api/v1/publications/capabilities", "https://api.other.example/api/v1/publications/capabilities"])
  })

  it.each(["missing", "wrong-account", "invalid-manifest"] as const)("defers %s before any remote request", async mode => {
    const f = await fixture()
    if (mode !== "missing") await f.saveCredential(credential())
    if (mode === "invalid-manifest") await writeFile(join(f.root, "package.json"), "{}")
    const before = await snapshot(f.home)
    await expect(f.run({ candidateConfig: mode === "wrong-account" ? { ...f.config,
      projects: [{ ...f.project, userId: "another-user" }] } : f.config, wanted: true })).rejects.toMatchObject({
      reason: mode === "missing" ? "authentication" : mode === "wrong-account" ? "binding" : "metadata" })
    expect(f.requests).toEqual([])
    expect(await snapshot(f.home)).toEqual(before)
  })

  it.each([
    [200, { ...capabilities, targetProfiles: ["atape.publication-target.v1"] }, "capability"],
    [200, { ...capabilities, legacyAdoption: false }, "capability"], [200, {}, "capability"],
    [401, {}, "authentication"], [403, {}, "authentication"], [404, {}, "capability"],
    [429, {}, "network"], [503, {}, "network"]
  ])("defers an insufficient or unavailable Server (%s) without changing local state", async (status, body, reason) => {
    const f = await fixture(); await f.saveCredential(credential())
    const before = await snapshot(f.home)
    const fetch = (async (input, init) => String(input).endsWith("/capabilities") ? response(body, Number(status)) : f.fetch(input, init)) as typeof globalThis.fetch
    await expect(f.run(undefined, fetch)).rejects.toMatchObject({ reason })
    expect(await snapshot(f.home)).toEqual(before)
  })

  it("rejects topology drift before sending any bearer or capability request", async () => {
    const f = await fixture(); await f.saveCredential(credential())
    const fetch = (async (input, init) => {
      f.requests.push({ url: String(input), init })
      return response({ ...metadata(credential()), api_origin: "https://untrusted.example" })
    }) as typeof globalThis.fetch
    await expect(f.run(undefined, fetch)).rejects.toMatchObject({ reason: "binding" })
    expect(f.requests).toHaveLength(1)
    expect(new Headers(f.requests[0]?.init?.headers).get("authorization")).toBeNull()
  })

  it("rechecks local identity after remote success and detects account replacement", async () => {
    const f = await fixture(); await f.saveCredential(credential())
    const fetch = (async (input, init) => {
      if (String(input).endsWith("/capabilities")) {
        await f.saveCredential({ ...credential(), credentialId: "replacement-lineage" })
        return response(capabilities)
      }
      return f.fetch(input, init)
    }) as typeof globalThis.fetch
    await expect(f.run(undefined, fetch)).rejects.toMatchObject({ reason: "changed" })
  })

  it("binds the parent fingerprint to local scope and credential lineage, allowing harmless reorder and bearer refresh", async () => {
    const f = await fixture(); await f.saveCredential(credential())
    const inspect = (candidateConfig = f.config, wanted = true) => inspectCaptureMigrationPrerequisitesScope(f.paths, { candidateConfig, wanted })
    const original = await inspect()
    await f.saveCredential({ ...credential(), credential: "atc_v1_refreshed-private", createdAt: "2026-10-11T00:00:00Z" })
    expect(await inspect({ ...f.config, locale: "zh-CN", activeInstanceOrigin: "https://unrelated.example" })).toEqual(original)
    expect(await inspect(f.config, false)).not.toEqual(original)
    expect(await inspect({ ...f.config, enabledAdapterIds: [] })).not.toEqual(original)
    expect(await inspect({ ...f.config, projects: [{ ...f.project, teamId: "team-2" }] })).not.toEqual(original)
    await f.saveCredential({ ...credential(), credentialId: "changed-lineage" })
    expect(await inspect()).not.toEqual(original)
    await f.saveCredential(credential()); await f.saveManifest(SourceCaptureVersion)
    expect(await inspect()).not.toEqual(original)
    expect(f.requests).toEqual([])
  })

  it("maps transport failure to a safe deferred error without exposing private exceptions", async () => {
    const f = await fixture(); await f.saveCredential(credential())
    const fetch = (async () => { throw new Error("private bearer/history") }) as typeof globalThis.fetch
    const failure = await f.run(undefined, fetch).catch(error => error)
    expect(failure).toMatchObject({ reason: "network" })
    expect(String(failure)).not.toContain("private")
  })

  it("propagates interruption to the real HTTP request without creating migration state", async () => {
    const f = await fixture(); await f.saveCredential(credential())
    const before = await snapshot(f.home)
    let entered!: () => void, aborted = false
    const started = new Promise<void>(resolve => { entered = resolve })
    const fetch = (async (input, init) => {
      if (!String(input).endsWith("/capabilities")) return f.fetch(input, init)
      entered()
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => {
        aborted = true; reject(new DOMException("Aborted", "AbortError"))
      }, { once: true }))
    }) as typeof globalThis.fetch
    const controller = new AbortController()
    const result = preflightCaptureMigrationPrerequisites(f.paths, { candidateConfig: f.config, wanted: true }).pipe(
      Effect.provide(makeCaptureMigrationPrerequisitesLayer(f.paths, {}, fetch)), effect => Effect.runPromise(effect, { signal: controller.signal }))
    const rejected = expect(result).rejects.toBeDefined()
    await started; controller.abort(); await rejected
    expect(aborted).toBe(true)
    expect(await snapshot(f.home)).toEqual(before)
  })
})
