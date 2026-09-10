import {
  openConversation,
  openProjectMemory,
  type ConversationPageRequest,
  type MemoryGatewayError
} from "@atape/application"
import type { Conversation, ProjectMemory } from "@atape/domain"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Effect, Fiber } from "effect"
import { AsyncResult, Atom } from "effect/unstable/reactivity"
import { useEffect, useRef, useState } from "react"
import { BrowserMemoryGatewayLayer } from "../runtime/memoryGateway"

export type LoadableView<A> =
  | { readonly _tag: "Loading" }
  | {
      readonly _tag: "Ready"
      readonly value: A
      readonly refreshing: boolean
      readonly refreshFailure?: string
    }
  | { readonly _tag: "Failed"; readonly message: string; readonly retryable: boolean; readonly refreshRequired?: boolean; readonly discardPrevious?: boolean }

export type RefreshCadence = "manual" | "30_seconds" | "1_minute" | "5_minutes"

export type RefreshSettingsView = {
  readonly cadence: RefreshCadence
  readonly setCadence: (cadence: RefreshCadence) => void
}

const runtime = Atom.runtime(BrowserMemoryGatewayLayer)

const projectAtoms = Atom.family((projectId: string) =>
  runtime.atom(openProjectMemory(projectId))
)

const conversationAtoms = Atom.family((sessionId: string) =>
  Atom.family((threadId: string) =>
    Atom.family((page: string) => runtime.atom(openConversation(sessionId, threadId, JSON.parse(page) as ConversationPageRequest)))
  )
)

export const refreshCadenceMilliseconds = (cadence: RefreshCadence): number | undefined => {
  switch (cadence) {
    case "manual":
      return undefined
    case "30_seconds":
      return 30_000
    case "1_minute":
      return 60_000
    case "5_minutes":
      return 300_000
  }
}

const toLoadableView = <A>(
  result: AsyncResult.AsyncResult<A, MemoryGatewayError>
): LoadableView<A> => {
  const view = AsyncResult.matchWithError(result, {
    onInitial: () => ({ _tag: "Loading" as const }),
    onError: (error) => ({
      _tag: "Failed" as const,
      message: error.message,
      retryable: error.reason !== "decode",
      refreshRequired: error.code === "refresh_required",
      discardPrevious: error.code === "refresh_required" || [401, 403, 404].includes(error.status ?? 0)
    }),
    onDefect: () => ({
      _tag: "Failed" as const,
      message: "ATape could not render this memory safely.",
      retryable: false,
      refreshRequired: false,
      discardPrevious: false
    }),
    onSuccess: (success) => ({
      _tag: "Ready" as const,
      value: success.value,
      refreshing: success.waiting
    })
  })

  // The binding below owns the displayed fallback. Effect's previousSuccess
  // can outlive an authorization denial, so it must never resurrect that data.

  return view
}

const useRefreshSettings = (
  reload: () => void,
  refreshing: boolean
): RefreshSettingsView => {
  const [cadence, setCadence] = useState<RefreshCadence>("manual")
  const reloadRef = useRef(reload)
  const refreshingRef = useRef(refreshing)
  reloadRef.current = reload
  refreshingRef.current = refreshing

  useEffect(() => {
    const interval = refreshCadenceMilliseconds(cadence)
    if (interval === undefined) {
      return
    }

    const fiber = Effect.runFork(
      Effect.sleep(interval).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (!refreshingRef.current) {
              reloadRef.current()
            }
          })
        ),
        Effect.forever
      )
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [cadence])

  return { cadence, setCadence }
}

const useCachedLoadableView = <A>(
  cacheKey: string,
  result: AsyncResult.AsyncResult<A, MemoryGatewayError>
): LoadableView<A> => {
  const cache = useRef<{ readonly key: string; readonly value: A } | undefined>(undefined)
  if (cache.current !== undefined && cache.current.key !== cacheKey) {
    cache.current = undefined
  }

  const view = toLoadableView(result)
  if (view._tag === "Ready") {
    cache.current = { key: cacheKey, value: view.value }
    return view
  }

  if (view._tag === "Failed" && view.discardPrevious) {
    cache.current = undefined
    return view
  }

  if (cache.current !== undefined) {
    return view._tag === "Failed"
      ? {
          _tag: "Ready",
          value: cache.current.value,
          refreshing: false,
          refreshFailure: view.message
        }
      : {
          _tag: "Ready",
          value: cache.current.value,
          refreshing: true
        }
  }

  return view
}

export const useProjectMemoryPresenter = (projectId: string): {
  readonly state: LoadableView<ProjectMemory>
  readonly reload: () => void
  readonly refresh: RefreshSettingsView
} => {
  const atom = projectAtoms(projectId)
  const result = useAtomValue(atom)
  const reload = useAtomRefresh(atom)
  const state = useCachedLoadableView(projectId, result)
  const refresh = useRefreshSettings(reload, result.waiting)
  return {
    state,
    reload,
    refresh
  }
}

export const useConversationPresenter = (sessionId: string, threadId: string, page: ConversationPageRequest = {}, restart?: () => void): {
  readonly state: LoadableView<Conversation>
  readonly reload: () => void
  readonly refresh: RefreshSettingsView
} => {
  const pageKey = JSON.stringify(page)
  const atom = conversationAtoms(sessionId)(threadId)(pageKey)
  const result = useAtomValue(atom)
  const refreshAtom = useAtomRefresh(atom)
  const reload = (page.head !== undefined || page.at !== undefined) && restart !== undefined ? restart : refreshAtom
  const state = useCachedLoadableView(`${sessionId}\u0000${threadId}\u0000${pageKey}`, result)
  const refresh = useRefreshSettings(reload, result.waiting)
  return {
    state,
    reload,
    refresh
  }
}
