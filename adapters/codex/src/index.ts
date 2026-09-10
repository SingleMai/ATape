import type {
  AdapterOpenContext,
  AtapeAdapterModule,
  LegacyAdapterRuntime
} from "@atape/domain"
import { Effect } from "effect"
import { collectCodexPage, openCodexArchive } from "./codexArchive.ts"

const module = {
  createAtapeAdapter: async (context: AdapterOpenContext & { readonly signal: AbortSignal }): Promise<LegacyAdapterRuntime> => {
    const archive = await Effect.runPromise(openCodexArchive(context), { signal: context.signal })
    return {
      collect: (request) => Effect.runPromise(collectCodexPage(archive, request), {
        signal: request.signal
      })
    }
  }
} satisfies AtapeAdapterModule

export const createAtapeAdapter = (
  context: AdapterOpenContext & { readonly signal: AbortSignal }
) => module.createAtapeAdapter(context)
