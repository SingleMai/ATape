import { isAbsolute, join } from "node:path"
import { officialSources } from "./index.ts"

type Environment = Readonly<Record<string, string | undefined>>
export const codexHome = (environment: Environment, home: string) => environment.ATAPE_CODEX_HOME || environment.CODEX_HOME || join(home, ".codex")
export const claudeHome = (environment: Environment, home: string) => environment.ATAPE_CLAUDE_HOME || join(home, ".claude")

/** Stable-channel location; pure resolution never opens or creates storage. */
export const openCodeDatabasePath = (environment: Environment, home: string) => {
  const data = join(environment.XDG_DATA_HOME || join(home, ".local", "share"), "opencode")
  const configured = environment.OPENCODE_DB
  return configured ? isAbsolute(configured) || configured === ":memory:" ? configured : join(data, configured) : join(data, "opencode.db")
}

const locations = {
  codex: { kind: "directory", resolve: codexHome },
  claude: { kind: "directory", resolve: claudeHome },
  opencode: { kind: "file", resolve: openCodeDatabasePath }
} as const

export const officialSourceLocations = (environment: Environment, home: string) => officialSources.map(source => ({
  id: source.id, kind: locations[source.id].kind, path: locations[source.id].resolve(environment, home)
}))
