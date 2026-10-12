import type {
  AdapterOpenContext,
  AtapeAdapterModule,
  LegacyAdapterRuntime
} from "@atape/domain"
import { CanonicalProfileVersion5, GitAttributionVersion } from "@atape/domain"
import { Effect, Ref, Semaphore } from "effect"
import { CodexArchiveError, collectCodexPage, openCodexArchive } from "./codexArchive.ts"

const module = {
  createAtapeAdapter: async (context: AdapterOpenContext & { readonly signal: AbortSignal }): Promise<LegacyAdapterRuntime> => {
    if (!context.legacyCanonicalProfiles?.includes(CanonicalProfileVersion5)) {
      throw new CodexArchiveError({ reason: "configuration", message: "Upgrade the ATape CLI to collect Codex with explicit source clock quality and stable tool identities." })
    }
    if (context.project.type === "git" && context.gitAttribution?.version !== GitAttributionVersion) {
      throw new CodexArchiveError({ reason: "configuration", message: "Upgrade the ATape CLI to collect Git Projects with shared attribution." })
    }
    // Opening reads provider paths. Delay it until the Host has admitted the
    // selected profile against the Server; failed/cancelled opens are not cached.
    return Effect.runPromise(Effect.gen(function*() {
      const archive = yield* Ref.make<Effect.Success<ReturnType<typeof openCodexArchive>> | undefined>(undefined)
      const opening = yield* Semaphore.make(1)
      const lifetime = new AbortController()
      return {
        canonicalProfileVersion: CanonicalProfileVersion5,
        collect: request => {
          const signal = AbortSignal.any([context.signal, lifetime.signal, request.signal])
          return Effect.runPromise(opening.withPermit(Effect.gen(function*() {
            const existing = yield* Ref.get(archive)
            const current = existing ?? (yield* openCodexArchive(context).pipe(Effect.tap(value => Ref.set(archive, value))))
            // The bounded source reader observes this signal itself. Retain the
            // permit until it closes file handles, including during cancellation.
            return yield* collectCodexPage(current, { ...request, signal }).pipe(Effect.uninterruptible)
          })), { signal })
        },
        close: () => lifetime.abort()
      } satisfies LegacyAdapterRuntime
    }), { signal: context.signal })
  }
} satisfies AtapeAdapterModule

export const createAtapeAdapter = (
  context: AdapterOpenContext & { readonly signal: AbortSignal }
) => module.createAtapeAdapter(context)
