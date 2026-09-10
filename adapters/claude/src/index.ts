import type { AdapterOpenContext, LegacyAdapterRuntime } from "@atape/domain"
import { Effect } from "effect"
import { collectClaudePage, openClaudeArchive } from "./claudeArchive.ts"

export const createAtapeAdapter = async (
  context: AdapterOpenContext & { readonly signal: AbortSignal }
): Promise<LegacyAdapterRuntime> => {
  const archive = await Effect.runPromise(openClaudeArchive(context), { signal: context.signal })
  return {
    collect: request => Effect.runPromise(collectClaudePage(archive, request), { signal: request.signal })
  }
}
