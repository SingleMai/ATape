import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const revision = "f05b3db36a6220f02c84d2a62a061cf882edca40"
const tag = "v0.5.9"
const repository = fileURLToPath(new URL("../../..", import.meta.url))
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

export const analyticsAccept = "application/vnd.atape.session-analytics.v3+json, application/json"
export const corsCookie = { name: "atape_session_dev", value: "activity-cors-test" }
export type CorsRequest = {
  readonly kind: "request"
  readonly method: string
  readonly path: string
  readonly status: number
  readonly origin: string
  readonly accept: string
  readonly cookieMatched: boolean
  readonly requestedHeaders: string
}

// A new Test Composition Root calls the genuine old public Go Interfaces. It
// observes the HTTP boundary; it never changes the frozen CORS or analytics code.
const goCaller = `package main

import (
  "context"
  "encoding/json"
  "flag"
  "fmt"
  "net"
  "net/http"
  "os"
  "os/signal"
  "strings"
  "syscall"
  "time"

  "github.com/SingleMai/ATape/server/internal/adapters/httpapi"
  "github.com/SingleMai/ATape/server/internal/adapters/memoryraw"
  "github.com/SingleMai/ATape/server/internal/adapters/memorysearch"
  "github.com/SingleMai/ATape/server/internal/authentication"
  "github.com/SingleMai/ATape/server/internal/canonical"
  "github.com/SingleMai/ATape/server/internal/conversation"
  "github.com/SingleMai/ATape/server/internal/ingestion"
  "github.com/SingleMai/ATape/server/internal/projectsearch"
  "github.com/SingleMai/ATape/server/internal/sessionanalytics"
  "github.com/SingleMai/ATape/server/internal/workspace"
)

type recorder struct { http.ResponseWriter; status int }
func (r *recorder) WriteHeader(status int) { r.status = status; r.ResponseWriter.WriteHeader(status) }
func (r *recorder) Write(bytes []byte) (int, error) {
  if r.status == 0 { r.status = http.StatusOK }
  return r.ResponseWriter.Write(bytes)
}
func emit(value any) { bytes, _ := json.Marshal(value); fmt.Println(string(bytes)) }

func main() {
  webOrigin := flag.String("web-origin", "", "Test Web origin")
  flag.Parse()
  listener, err := net.Listen("tcp", "127.0.0.1:0")
  if err != nil { panic(err) }
  apiOrigin := "http://" + listener.Addr().String()
  store := canonical.NewDemoStore()
  index := memorysearch.New(store)
  raw, err := memoryraw.NewDemoArchive(store)
  if err != nil { panic(err) }
  principal := authentication.Principal{UserID: canonical.DemoUserID, Method: authentication.WebAuthentication}
  handler, err := httpapi.NewHandler(httpapi.Config{
    InstanceOrigin: *webOrigin, WebOrigin: *webOrigin, APIOrigin: apiOrigin,
    DevelopmentAllowHTTP: true, DevelopmentPrincipal: &principal,
  }, httpapi.Modules{
    Memory: conversation.NewMemory(store), Ingestor: ingestion.NewIngestor(store),
    Searcher: projectsearch.NewSearcher(index), Directory: workspace.NewDirectory(store), Raw: raw,
    Analytics: sessionanalytics.New(store),
  })
  if err != nil { panic(err) }
  server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
    captured := &recorder{ResponseWriter: response}
    handler.ServeHTTP(captured, request)
    if strings.HasPrefix(request.URL.Path, "/api/v1/sessions/checkout/analytics") {
      cookie, cookieError := request.Cookie("atape_session_dev")
      emit(map[string]any{"kind": "request", "method": request.Method, "path": request.URL.Path,
        "status": captured.status, "origin": request.Header.Get("Origin"), "accept": request.Header.Get("Accept"),
        "cookieMatched": cookieError == nil && cookie.Value == "activity-cors-test",
        "requestedHeaders": request.Header.Get("Access-Control-Request-Headers")})
    }
  }), ReadHeaderTimeout: 5 * time.Second}
  stop, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
  defer cancel()
  emit(map[string]any{"kind": "ready", "apiOrigin": apiOrigin})
  go func() { <-stop.Done(); ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second); defer cancel(); _ = server.Shutdown(ctx) }()
  if err := server.Serve(listener); err != nil && err != http.ErrServerClosed { panic(err) }
}
`

const listen = (server: Server) => new Promise<string>((accept, reject) => {
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    if (address === null || typeof address === "string") { reject(new Error("The Test Web listener has no address.")); return }
    accept(`http://127.0.0.1:${address.port}`)
  })
})
const closeWeb = (server: Server | undefined) => server === undefined ? Promise.resolve() : new Promise<void>((accept, reject) => {
  server.closeAllConnections()
  server.close(error => error ? reject(error) : accept())
})
const stopAPI = (child: ChildProcess | undefined) => child === undefined || child.exitCode !== null ? Promise.resolve() : new Promise<void>(accept => {
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000)
  child.once("exit", () => { clearTimeout(timer); accept() })
  child.kill("SIGTERM")
})

/** Real split-origin browser transport against untouched published 0.5.9 Go
 * HTTP/CORS/analytics Modules. Demo identity is not Cookie authentication. */
export const historicalAnalyticsCors = async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "atape-analytics-cors-v059-")))
  const execute = promisify(execFile)
  let web: Server | undefined, api: ChildProcess | undefined
  try {
    const git = async (args: string[]) => (await execute("git", args, {
      cwd: repository, encoding: "buffer", maxBuffer: 32 * 1024 * 1024, timeout: 30000
    })).stdout
    if ((await git(["rev-parse", `${tag}^{commit}`])).toString().trim() !== revision)
      throw new Error("The genuine old Server tag does not match the published 0.5.9 commit.")
    const tree = (await git(["ls-tree", "-r", "--name-only", revision, "server"])).toString().trim().split("\n")
    const paths = tree.filter(path => path === "server/go.mod" || path === "server/go.sum" ||
      path.startsWith("server/internal/") && (path.endsWith(".go") && !path.endsWith("_test.go") || path.includes("/migrations/") && path.endsWith(".sql")))
    const inputs: Array<{ path: string; bytes: number; sha256: string }> = []
    for (const path of paths) {
      const bytes = await git(["show", `${revision}:${path}`]), target = join(directory, path)
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
      inputs.push({ path, bytes: bytes.length, sha256: sha256(bytes) })
    }
    const callerPath = join(directory, "server/cmd/cors-probe/main.go")
    await mkdir(dirname(callerPath), { recursive: true }); await writeFile(callerPath, goCaller)
    const binary = join(directory, "historical-api")
    const environment = { ...process.env, GOTOOLCHAIN: "go1.26.9", GOWORK: "off", GOFLAGS: "" }
    await execute("go", ["build", "-mod=readonly", "-trimpath", "-o", binary, "./cmd/cors-probe"], {
      cwd: join(directory, "server"), env: environment, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024
    })
    for (const input of inputs) if (sha256(await readFile(join(directory, input.path))) !== input.sha256)
      throw new Error("Building the historical Server changed a frozen input.")
    let bundle: Uint8Array | undefined
    web = createServer((request, response) => {
      if (request.url === "/probe.js" && bundle !== undefined) {
        response.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }); response.end(bundle); return
      }
      if (request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" })
        response.end('<!doctype html><title>Real analytics CORS caller</title><script type="module" src="/probe.js"></script>'); return
      }
      response.writeHead(404); response.end()
    })
    const webOrigin = await listen(web), requests: CorsRequest[] = []
    api = spawn(binary, ["-web-origin", webOrigin], { stdio: ["ignore", "pipe", "pipe"] })
    let diagnostics = "", pending = ""
    api.stderr?.on("data", value => { diagnostics += String(value) })
    const apiOrigin = await new Promise<string>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error(`Historical HTTP Adapter did not start: ${diagnostics}`)), 10000)
      api!.once("exit", code => { clearTimeout(timer); reject(new Error(`Historical HTTP Adapter exited with ${code}: ${diagnostics}`)) })
      api!.stdout?.on("data", value => {
        pending += String(value)
        let newline: number
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
          const parsed = JSON.parse(line) as CorsRequest | { readonly kind: "ready"; readonly apiOrigin: string }
          if (parsed.kind === "ready") { clearTimeout(timer); accept(parsed.apiOrigin) }
          else requests.push(parsed)
        }
      })
    })
    const browserCaller = `import { readSessionAnalytics } from "@atape/application";
import { Effect } from "effect";
import { BrowserSessionAnalyticsGatewayLayer } from ${JSON.stringify(join(repository, "apps/web/src/runtime/sessionAnalyticsGateway.ts"))};
window.activityCorsProbe = () => Effect.runPromise(readSessionAnalytics("checkout").pipe(Effect.provide(BrowserSessionAnalyticsGatewayLayer)));
window.activityCorsNegativeControl = () => fetch(${JSON.stringify(`${apiOrigin}/api/v1/sessions/checkout/analytics`)}, {
  method: "GET", credentials: "include", redirect: "error", headers: { "ATape-Accept-Analytics-Version": "3" }
}).then(() => "unexpected-success", () => "cors-rejected");
`
    const browserPath = join(directory, "browser-caller.ts"), browserBundle = join(directory, "browser-caller.js")
    await writeFile(browserPath, browserCaller)
    // esbuild is a declared workspace CLI build dependency, rather than a Web
    // package dependency; browser resolution still uses the actual Web graph.
    const require = createRequire(join(repository, "apps/cli/package.json")), esbuild = require("esbuild") as typeof import("esbuild")
    const built = await esbuild.build({ absWorkingDir: repository, entryPoints: [browserPath], outfile: browserBundle,
      bundle: true, platform: "browser", format: "esm", target: "es2023", logLevel: "silent", metafile: true,
      nodePaths: [join(repository, "apps/web/node_modules")],
      define: { "import.meta.env.VITE_ATAPE_API_ORIGIN": JSON.stringify(apiOrigin), "import.meta.env.DEV": "true" } })
    bundle = await readFile(browserBundle)
    const currentInputs = await Promise.all(Object.keys(built.metafile.inputs).filter(path => !path.includes("node_modules")).map(async path => {
      const bytes = await readFile(resolve(repository, path))
      return { path, bytes: bytes.length, sha256: sha256(bytes) }
    }))
    const proof = { revision, tag, dependencyMode: "historical-go-mod-sum", inputs,
      goModSha256: inputs.find(input => input.path === "server/go.mod")!.sha256,
      goSumSha256: inputs.find(input => input.path === "server/go.sum")!.sha256,
      goVersion: (await execute("go", ["version"], { env: environment, encoding: "utf8", timeout: 10000 })).stdout.trim(),
      historicalBinary: { bytes: (await readFile(binary)).length, sha256: sha256(await readFile(binary)) },
      additionalGoCaller: { sha256: sha256(goCaller) },
      browserCaller: { sha256: sha256(browserCaller), bundleSha256: sha256(bundle), inputs: currentInputs },
      scope: "real Chromium / current production Gateway / genuine 0.5.9 HTTP-CORS-analytics Modules / DemoStore",
      cookieScope: "HTTP forwarding only; DevelopmentPrincipal is not Cookie authentication",
      excludes: ["full application UI", "session login", "production Cookie authentication", "native source capture"] }
    await writeFile(join(directory, "provenance.json"), JSON.stringify(proof, null, 2))
    return { webOrigin, apiOrigin, requests, proof, cleanup: async () => {
      await stopAPI(api); await closeWeb(web); await rm(directory, { recursive: true, force: true })
    } }
  } catch (cause) {
    await stopAPI(api); await closeWeb(web); await rm(directory, { recursive: true, force: true }); throw cause
  }
}
