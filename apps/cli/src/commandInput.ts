import { parseArgs } from "node:util"
import { t } from "./i18n/index.ts"

type Global = { readonly lang?: string }
export type RedactionTestFormat = "text" | "json" | "jsonl"
export type RedactionTestOptions = Global & {
  readonly file: string
  readonly format?: RedactionTestFormat
  readonly config?: string
}
export type ParsedCLI =
  | { readonly kind: "interactive"; readonly options: Global & { readonly noBrowser?: boolean } }
  | { readonly kind: "help" | "version"; readonly options: Global }
  | { readonly kind: "redaction-help"; readonly options: Global }
  | { readonly kind: "redaction-test"; readonly options: RedactionTestOptions }
  | { readonly kind: "__collector-daemon"; readonly options: {
    readonly daemonToken: string; readonly intervalMs?: number; readonly concurrency?: number
  } }
  | { readonly kind: "__automatic-update"; readonly options: { readonly updateToken: string } }
  | { readonly kind: "__login-start"; readonly options: { readonly startupToken: string } }
  | { readonly kind: "__update-wake"; readonly options: { readonly wakeToken: string } }

export class CLIInputError extends Error {}

// The local redaction test is a public noninteractive utility. Internal process
// entries remain reserved for their owners; management uses the guided entry.
export const parseCLI = (args: ReadonlyArray<string>): ParsedCLI => {
  const internal = args[0] === "__collector-daemon"
  const updater = args[0] === "__automatic-update"
  const login = args[0] === "__login-start"
  const wake = args[0] === "__update-wake"
  const redaction = args[0] === "redaction-test"
  const fail = (): never => { throw new CLIInputError(t("cli.error.input", "Unsupported arguments. Run atape to manage projects, tools and settings, or atape --help.")) }
  let parsed: ReturnType<typeof parseArgs>
  try { parsed = parseArgs({
    args: [...args], allowPositionals: true, strict: true, tokens: true,
    options: redaction ? {
      help: { type: "boolean", short: "h" }, lang: { type: "string" },
      config: { type: "string" }, format: { type: "string" }
    } : wake ? { "wake-token": { type: "string" } } : login ? { "startup-token": { type: "string" } } : updater ? { "update-token": { type: "string" } } : internal ? {
      "daemon-token": { type: "string" }, interval: { type: "string" }, concurrency: { type: "string" }
    } : {
      help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
      lang: { type: "string" }, "no-browser": { type: "boolean" }
    }
  }) } catch { return fail() }
  const { values, positionals, tokens } = parsed
  const seen = new Set<string>()
  for (const token of tokens ?? []) {
    if (token.kind !== "option") continue
    if (seen.has(token.name) || typeof token.value === "string" && token.value.trim() === "") fail()
    seen.add(token.name)
  }
  if (redaction) {
    const options: Global = typeof values.lang === "string" ? { lang: values.lang } : {}
    if (values.help) {
      if (positionals.length !== 1 || values.config !== undefined || values.format !== undefined) return fail()
      return { kind: "redaction-help", options }
    }
    if (positionals.length !== 2 || positionals[1]!.trim() === "" ||
      values.format !== undefined && !["text", "json", "jsonl"].includes(String(values.format))) return fail()
    return { kind: "redaction-test", options: { ...options, file: positionals[1]!,
      ...(typeof values.config === "string" ? { config: values.config } : {}),
      ...(values.format === undefined ? {} : { format: values.format as RedactionTestFormat }) } }
  }
  if (wake) {
    if (positionals.length !== 1 || typeof values["wake-token"] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(values["wake-token"])) return fail()
    return { kind: "__update-wake", options: { wakeToken: values["wake-token"] } }
  }
  if (login) {
    if (positionals.length !== 1 || typeof values["startup-token"] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(values["startup-token"])) return fail()
    return { kind: "__login-start", options: { startupToken: values["startup-token"] } }
  }
  if (updater) {
    if (positionals.length !== 1 || typeof values["update-token"] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(values["update-token"])) return fail()
    return { kind: "__automatic-update", options: { updateToken: values["update-token"] } }
  }
  if (internal) {
    if (positionals.length !== 1 || typeof values["daemon-token"] !== "string") return fail()
    const integer = (name: "interval" | "concurrency"): number | undefined => {
      const value = values[name]
      if (value === undefined) return undefined
      if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return fail()
      return Number(value)
    }
    const interval = integer("interval"), concurrency = integer("concurrency")
    if (interval !== undefined && (interval < 10 || interval > 3600) || concurrency !== undefined && (concurrency < 1 || concurrency > 8)) return fail()
    return { kind: "__collector-daemon", options: { daemonToken: values["daemon-token"],
      ...(interval === undefined ? {} : { intervalMs: interval * 1000 }), ...(concurrency === undefined ? {} : { concurrency }) } }
  }
  if (positionals.length || values.help && values.version || (values.help || values.version) && values["no-browser"]) return fail()
  const options: Global = typeof values.lang === "string" ? { lang: values.lang } : {}
  if (values.help) return { kind: "help", options }
  if (values.version) return { kind: "version", options }
  return { kind: "interactive", options: { ...options, ...(values["no-browser"] ? { noBrowser: true } : {}) } }
}
