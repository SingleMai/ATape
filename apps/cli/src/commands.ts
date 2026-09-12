import { runManagedCollector } from "@atape/application"
import { Effect } from "effect"
import { cliVersion } from "./version.ts"
import { t } from "./i18n/index.ts"
import type { ParsedCLI } from "./commandInput.ts"

export const runCommand = Effect.fn("CLI.entry")(function*(cli: Exclude<ParsedCLI, { readonly kind: "interactive" }>) {
  if (cli.kind === "__collector-daemon") return yield* runManagedCollector(cli.options)
  yield* Effect.sync(() => { process.stdout.write(`${cli.kind === "version" ? `ATape ${cliVersion}` : helpText()}\n`) })
})

const helpText = () => t("cli.help", `ATape CLI

Usage:
  atape                 Open ATape to manage projects, tools and settings
  atape --help          Show this help
  atape --version       Show the installed version

Options:
  --lang <locale>       Interface language for this session (en, zh-CN)
  --no-browser          Show sign-in links without opening a browser

Run atape in an interactive macOS or Linux terminal.
All operations are available inside ATape. Business subcommands and JSON output are not supported.
Exiting ATape leaves background sync running. After a reboot, open ATape and select Start sync.

Environment:
  ATAPE_HOME            Local ATape root (default: ~/.atape)
  ATAPE_INSTANCE_URL    Default server address; also available in Settings
  ATAPE_LANG            Interface language (en, zh-CN)`)
