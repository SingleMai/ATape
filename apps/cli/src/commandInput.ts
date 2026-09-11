import { parseArgs } from "node:util"
import { t } from "./i18n/index.ts"

type Global = { readonly lang?: string }
type Output = Global & { readonly json?: boolean }
type Instance = { readonly instance?: string }
type Schedule = { readonly interval?: string; readonly concurrency?: string }
type Invocation<K extends string, O, A = object> = K extends string ? { readonly kind: K; readonly options: O } & A : never

export type ParsedCLI =
  | Invocation<"interactive", Global & Instance & { readonly noBrowser?: boolean }, { readonly setup: boolean; readonly directory?: string }>
  | Invocation<"help" | "version", Global>
  | Invocation<"upgrade" | "projects.list" | "adapters.list" | "tools.list" | "stop" | "status", Output>
  | Invocation<"login", Output & Instance & { readonly noBrowser?: boolean }>
  | Invocation<"logout", Output & Instance>
  | Invocation<"setup", Output & Instance & { readonly team?: string; readonly create?: boolean; readonly name?: string; readonly type?: string }, { readonly directory?: string }>
  | Invocation<"projects.remove", Output, { readonly projectId: string }>
  | Invocation<"adapters.install", Output, { readonly packageSpec: string }>
  | Invocation<"adapters.upgrade", Output, { readonly target: string }>
  | Invocation<"adapters.prune", Output & { readonly apply?: boolean; readonly keep?: string }>
  | Invocation<"tools.configure", Output & { readonly apply?: boolean }, { readonly adapterIds: ReadonlyArray<string> }>
  | Invocation<"collect", Output & Schedule & { readonly project?: string; readonly once?: boolean }>
  | Invocation<"start", Output & Schedule>
  | Invocation<"language", Output, { readonly locale?: string }>
  | Invocation<"__collector-daemon", Global & Schedule & { readonly daemonToken: string }>

export type Command<K extends ParsedCLI["kind"]> = Extract<ParsedCLI, { readonly kind: K }>
export type CommandOptions<K extends ParsedCLI["kind"]> = Command<K>["options"]
export class CLIInputError extends Error {}

// The raw parser bag is private. Its only exit is a command-specific value.
export const parseCLI = (args: ReadonlyArray<string>): ParsedCLI => {
  const { values: v, positionals: p, tokens } = parseArgs({
    args: [...args], allowPositionals: true, strict: true, tokens: true,
    options: {
      help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
      json: { type: "boolean" }, lang: { type: "string" }, instance: { type: "string" },
      "no-browser": { type: "boolean" }, team: { type: "string" }, create: { type: "boolean" },
      apply: { type: "boolean" }, none: { type: "boolean" }, name: { type: "string" },
      type: { type: "string" }, adapter: { type: "string", multiple: true }, project: { type: "string" },
      all: { type: "boolean" }, once: { type: "boolean" }, interval: { type: "string" },
      concurrency: { type: "string" }, "daemon-token": { type: "string" }, keep: { type: "string" }
    }
  })
  const fail = (message: string): never => { throw new CLIInputError(message) }
  const seen = new Set<string>()
  for (const token of tokens) {
    if (token.kind !== "option") continue
    if (seen.has(token.name) && token.name !== "adapter") fail(`--${token.name} may only be specified once.`)
    if (typeof token.value === "string" && token.value.trim() === "") fail(`--${token.name} requires a non-empty value.`)
    seen.add(token.name)
  }
  const allow = (...names: string[]) => {
    for (const name of seen) if (name !== "lang" && !names.includes(name)) {
      if (p[0] === "setup" && name === "adapter") fail(t("cli.error.toolsAreGlobal", "Tools are global. Omit --adapter for Project setup; use atape tools configure to change tools."))
      fail(`--${name} is not supported by ${p.slice(0, 2).join(" ") || "atape"}.`)
    }
  }
  const arity = (min: number, max = min) => {
    if (p.length < min || p.length > max) fail(`Invalid arguments for ${p[0] ?? "atape"}. Run atape --help.`)
  }
  const global: Global = v.lang === undefined ? {} : { lang: v.lang }
  const output: Output = { ...global, ...(v.json ? { json: true } : {}) }
  const instance: Instance = v.instance === undefined ? {} : { instance: v.instance }
  const schedule: Schedule = {
    ...(v.interval === undefined ? {} : { interval: v.interval }),
    ...(v.concurrency === undefined ? {} : { concurrency: v.concurrency })
  }
  if (v.version) { allow("version"); arity(0); return { kind: "version", options: global } }
  if (v.help || p[0] === "help") { allow("help"); arity(0, 3); return { kind: "help", options: global } }
  if (p.length === 0 && v.json) { allow("json"); return { kind: "help", options: global } }
  if ((p.length === 0 || p[0] === "setup") && [...seen].every(name => ["lang", "instance", "no-browser"].includes(name))) {
    arity(0, p[0] === "setup" ? 2 : 0)
    return { kind: "interactive", options: { ...global, ...instance, ...(v["no-browser"] ? { noBrowser: true } : {}) },
      setup: p[0] === "setup", ...(p[1] === undefined ? {} : { directory: p[1] }) }
  }
  switch (p[0]) {
    case "login":
      arity(1); allow("instance", "no-browser", "json")
      return { kind: "login", options: { ...output, ...instance, ...(v["no-browser"] ? { noBrowser: true } : {}) } }
    case "logout":
      arity(1); allow("instance", "json"); return { kind: "logout", options: { ...output, ...instance } }
    case "setup":
      arity(1, 2); allow("instance", "team", "create", "name", "type", "json")
      return { kind: "setup", ...(p[1] === undefined ? {} : { directory: p[1] }), options: {
        ...output, ...instance, ...(v.team === undefined ? {} : { team: v.team }),
        ...(v.create ? { create: true } : {}), ...(v.name === undefined ? {} : { name: v.name }),
        ...(v.type === undefined ? {} : { type: v.type }) } }
    case "projects":
      allow("json")
      if (p[1] === "list") { arity(2); return { kind: "projects.list", options: output } }
      if (p[1] === "remove") { arity(3); return { kind: "projects.remove", options: output, projectId: p[2]! } }
      return fail("Use atape projects list or atape projects remove <project-id>.")
    case "adapters":
      switch (p[1]) {
        case "list": arity(2); allow("json"); return { kind: "adapters.list", options: output }
        case "install": arity(3); allow("json"); return { kind: "adapters.install", options: output, packageSpec: p[2]! }
        case "upgrade":
          arity(2, 3); allow("json", "all")
          if (Boolean(v.all) === Boolean(p[2])) return fail("Use atape adapters upgrade <adapter-id> or --all.")
          return { kind: "adapters.upgrade", options: output, target: v.all ? "all" : p[2]! }
        case "prune":
          arity(2); allow("json", "apply", "keep")
          return { kind: "adapters.prune", options: { ...output, ...(v.apply ? { apply: true } : {}), ...(v.keep === undefined ? {} : { keep: v.keep }) } }
        default: return fail("Use atape adapters list|install|upgrade|prune.")
      }
    case "tools":
      arity(2)
      if (p[1] === "list") { allow("json"); return { kind: "tools.list", options: output } }
      if (p[1] !== "configure") return fail("Use atape tools list or atape tools configure.")
      allow("json", "apply", "adapter", "none")
      if (Boolean(v.none) === Boolean(v.adapter?.length)) return fail("Use --adapter <id> [--adapter <id>] or --none.")
      return { kind: "tools.configure", options: { ...output, ...(v.apply ? { apply: true } : {}) }, adapterIds: v.adapter ?? [] }
    case "collect":
      arity(1); allow("json", "project", "once", "interval", "concurrency")
      if (v.json && !v.once) return fail("--json requires --once for collect.")
      return { kind: "collect", options: { ...output, ...schedule, ...(v.project === undefined ? {} : { project: v.project }), ...(v.once ? { once: true } : {}) } }
    case "start":
      arity(1); allow("json", "interval", "concurrency"); return { kind: "start", options: { ...output, ...schedule } }
    case "stop": case "status": case "upgrade":
      arity(1); allow("json"); return { kind: p[0], options: output }
    case "language":
      arity(1, 2); allow("json"); return { kind: "language", options: output, ...(p[1] === undefined ? {} : { locale: p[1] }) }
    case "__collector-daemon":
      arity(1); allow("daemon-token", "interval", "concurrency")
      if (v["daemon-token"] === undefined) return fail("Invalid internal Collector invocation.")
      return { kind: "__collector-daemon", options: { ...global, ...schedule, daemonToken: v["daemon-token"] } }
    default: return fail(`Unknown command: ${p[0] ?? "atape"}. Run atape --help.`)
  }
}
