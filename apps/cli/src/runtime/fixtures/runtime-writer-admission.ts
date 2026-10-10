import { createHash } from "node:crypto"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { atomicJSON, runtimeEntry } from "../runtimeFiles.ts"
import { createUpdateControl, updateControlProtocol, type UpdateRuntimeSelection } from "../updateControl.ts"

/** A current-contract floor change; no invented capture format or migration. */
export const runtimeWriterFixture = async (directory: string) => {
  const home = await realpath(directory), captureStateContract = "atape.client.v3-capture.v2"
  const bootstrap = join(home, "bootstrap", "dist", "atape.js")
  await mkdir(dirname(bootstrap), { recursive: true })
  await writeFile(bootstrap, "// Immutable bootstrap fixture, never executed.\n")
  const bootstrapIdentity = createHash("sha256").update(await readFile(bootstrap)).digest("hex")
  const generation = async (version: string): Promise<UpdateRuntimeSelection> => {
    const entry = runtimeEntry(home, version)
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, "// Immutable runtime fixture, never executed.\n")
    await atomicJSON(join(dirname(dirname(entry)), "package.json"), { name: "@atape/cli", version,
      atapeRuntime: { stateContract: captureStateContract, updateControlProtocol } })
    return { protocol: updateControlProtocol, version, captureStateContract, bootstrapEntry: bootstrap, bootstrapIdentity, adapters: [] }
  }
  const previous = await generation("0.5.5"), next = await generation("0.5.6")
  return {
    runtime: { home, identity: { version: previous.version, captureStateContract } },
    nextRuntime: { home, identity: { version: next.version, captureStateContract } },
    raiseFloor: async () => {
      const control = createUpdateControl(home), ticket = await control.prepare({ next, previous })
      await control.begin(ticket)
      await control.fence(ticket)
      await control.complete(ticket)
    }
  }
}
