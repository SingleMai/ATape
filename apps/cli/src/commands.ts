import { runManagedCollector, type RedactionResult } from "@atape/application"
import { Effect } from "effect"
import { cliVersion } from "./version.ts"
import { t } from "./i18n/index.ts"
import type { ParsedCLI } from "./commandInput.ts"

export const runCommand = Effect.fn("CLI.entry")(function*(cli: Exclude<ParsedCLI, { readonly kind: "interactive" | "__automatic-update" | "__login-start" | "__update-wake" | "redaction-test" | "redaction-help" }>) {
  if (cli.kind === "__collector-daemon") return yield* runManagedCollector(cli.options)
  yield* writeInformationalCommand(cli)
})

export const writeInformationalCommand = (cli: Extract<ParsedCLI, { readonly kind: "help" | "version" }>) =>
  Effect.sync(() => { process.stdout.write(`${cli.kind === "version" ? `ATape ${cliVersion}` : helpText()}\n`) })

const helpText = () => t("cli.help", `ATape CLI

Usage:
  atape                 Open ATape to manage projects, tools and settings
  atape redaction-test <file>  Test redaction locally and print masked content
  atape --help          Show this help
  atape --version       Show the installed version

Options:
  --lang <locale>       Interface language for this session (en, zh-CN)
  --no-browser          Show sign-in links without opening a browser

Run atape in an interactive macOS or Linux terminal.
Manage projects, tools and settings inside ATape. Use redaction-test for a local file preview.
Exiting ATape leaves background sync running. Login startup is on by default after setup; change it in Settings.

Environment:
  ATAPE_HOME            Local ATape root (default: ~/.atape)
  ATAPE_INSTANCE_URL    Default server address; also available in Settings
  ATAPE_LANG            Interface language (en, zh-CN)`)

const redactionHelpText = () => t("cli.redaction.help", `Test local redaction rules

Usage:
  atape redaction-test <file> [--format text|json|jsonl] [--config <path>] [--lang <locale>]

Prints only masked content to stdout and rule IDs, types and mask-operation counts to stderr.
Counts are merged mask operations, not the number of distinct secrets.
Uses the same redaction policy and content transformation as collection.
Format defaults to JSON for .json, JSONL for .jsonl/.ndjson, and text otherwise.
Input must be a regular UTF-8 file of at most 16 MiB.
The configuration defaults to ATAPE_REDACTION_CONFIG_FILE or $ATAPE_HOME/config/redaction.json.
This command runs locally without signing in, uploading or advancing capture state.
It tests this file; it does not prove complete session coverage or final upload bytes.`)

export const writeRedactionHelp = Effect.sync(() => { process.stdout.write(`${redactionHelpText()}\n`) })

export const writeRedactionTestResult = (result: RedactionResult<string>) =>
  Effect.tryPromise({
    try: () => new Promise<void>((resolve, reject) => process.stdout.write(result.value, error => error ? reject(error) : resolve())),
    catch: () => new Error("Unable to write masked output.")
  }).pipe(Effect.andThen(Effect.sync(() => {
    process.stderr.write(`${t("cli.redaction.summary", "Redaction test: {matches} mask operation(s).", {
      matches: result.stats.matches
    })}\n`)
    for (const rule of result.stats.rules) process.stderr.write(`${t("cli.redaction.ruleSummary", "  {id} ({type}): {matches}", rule)}\n`)
  })))

export const writeRedactionTestFailure = (error: unknown) => Effect.sync(() => {
  const failure = error !== null && typeof error === "object" ? error as { readonly _tag?: unknown; readonly reason?: unknown } : {}
  const detail = failure._tag === "LocalRedactionTestError"
    ? failure.reason === "encoding" ? t("cli.redaction.error.encoding", "The file must contain valid UTF-8.")
      : failure.reason === "limit" ? t("cli.redaction.error.fileLimit", "The file changed during reading or exceeds the 16 MiB limit.")
      : t("cli.redaction.error.read", "Unable to read a regular local file.")
    : failure._tag === "RedactionPolicyLoadError" || failure._tag === "RedactionPolicyError"
      ? t("cli.redaction.error.policy", "The redaction configuration is unreadable, invalid or exceeds supported limits.")
      : failure._tag === "RedactionError"
        ? t("cli.redaction.error.content", "Content cannot be safely processed. Check JSON syntax, duplicate keys and redaction limits.")
        : t("cli.redaction.error.other", "Check the input, configuration and output destination.")
  process.stderr.write(`${t("cli.redaction.failed", "ATape: Local redaction test failed.")} ${detail}\n`)
  process.exitCode = 1
})
