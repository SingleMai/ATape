import { join } from "node:path"
import { acquireProcessLock } from "./processLock.ts"

// Manual and automatic maintenance share one OS-held lifetime. Process exit
// releases exclusion, including SIGKILL, without an age-based stale lock.
export const acquireUpdateWorker = (home: string): Promise<(() => void) | undefined> =>
  acquireProcessLock(join(home, "updates", "worker.lock.sqlite"))
