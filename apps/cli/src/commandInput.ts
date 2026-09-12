import { parseArgs } from "node:util"
import { t } from "./i18n/index.ts"

type Global = { readonly lang?: string }
export type ParsedCLI =
  | { readonly kind: "interactive"; readonly options: Global & { readonly noBrowser?: boolean } }
  | { readonly kind: "help" | "version"; readonly options: Global }
  | { readonly kind: "__collector-daemon"; readonly options: {
    readonly daemonToken: string; readonly intervalMs?: number; readonly concurrency?: number
  } }

export class CLIInputError extends Error {}

// Only the process owner uses the daemon branch. Public input never exposes
// business operations or falls back to a second presentation.
export const parseCLI = (args: ReadonlyArray<string>): ParsedCLI => {
  const internal = args[0] === "__collector-daemon"
  const { values, positionals, tokens } = parseArgs({
    args: [...args], allowPositionals: true, strict: true, tokens: true,
    options: internal ? {
      "daemon-token": { type: "string" }, interval: { type: "string" }, concurrency: { type: "string" }
    } : {
      help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
      lang: { type: "string" }, "no-browser": { type: "boolean" }
    }
  })
  const fail = (): never => { throw new CLIInputError(t("cli.error.input", "Unsupported arguments. Run atape to manage projects, tools and settings, or atape --help.")) }
  const seen = new Set<string>()
  for (const token of tokens) {
    if (token.kind !== "option") continue
    if (seen.has(token.name) || typeof token.value === "string" && token.value.trim() === "") fail()
    seen.add(token.name)
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
