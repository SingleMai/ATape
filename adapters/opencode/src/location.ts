import { isAbsolute, join } from "node:path"

/** Stable-channel native location. A named override is relative to OpenCode's
 * data directory; other channels require an explicit override. Pure resolution
 * creates neither directories nor databases and never starts a native process. */
export const openCodeDatabasePath = (environment: Readonly<Record<string, string | undefined>>, home: string): string => {
  const data = join(environment.XDG_DATA_HOME || join(home, ".local", "share"), "opencode")
  const configured = environment.OPENCODE_DB
  return configured ? isAbsolute(configured) || configured === ":memory:" ? configured : join(data, configured) : join(data, "opencode.db")
}
