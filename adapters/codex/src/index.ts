import type {
  AdapterOpenContext,
  AtapeAdapterModule,
  AtapeAdapterRuntime
} from "@atape/domain"
import { Effect } from "effect"
import { collectCodexPage, openCodexArchive } from "./codexArchive.ts"

const module: AtapeAdapterModule = {
  createAtapeAdapter: async (context): Promise<AtapeAdapterRuntime> => {
    const archive = await Effect.runPromise(openCodexArchive(context), { signal: context.signal })
    return {
      collect: (request) => Effect.runPromise(collectCodexPage(archive, request), {
        signal: request.signal
      })
    }
  }
}

export const createAtapeAdapter = (
  context: AdapterOpenContext & { readonly signal: AbortSignal }
) => module.createAtapeAdapter(context)
