import { readSessionAnalytics } from "@atape/application"
import type { SessionAnalytics, SessionAnalyticsMetric, SessionAnalyticsQuery } from "@atape/domain"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/unstable/reactivity"
import { createContext, createElement, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from "react"
import { BrowserSessionAnalyticsGatewayLayer } from "../runtime/sessionAnalyticsGateway"
import { gatewayFailureMessageKey, type LoadableView } from "./memoryPresenter"

const runtime = Atom.runtime(BrowserSessionAnalyticsGatewayLayer)
const reads = Atom.family((key: string) => {
  const [sessionId, query] = JSON.parse(key) as [string, SessionAnalyticsQuery]
  return runtime.atom(readSessionAnalytics(sessionId, query))
})

const QueryContext = createContext<{
  readonly query: SessionAnalyticsQuery
  readonly setQuery: Dispatch<SetStateAction<SessionAnalyticsQuery>>
  readonly revision: number
  readonly setRevision: Dispatch<SetStateAction<number>>
} | undefined>(undefined)

// This scope survives Reader thread navigation; a different Session gets a new
// scope. Only ephemeral evidence selection lives here, not remote data.
export function SessionAnalyticsScope({ children }: { readonly children: ReactNode }) {
  const [query, setQuery] = useState<SessionAnalyticsQuery>({ metric: "tools" })
  const [revision, setRevision] = useState(0)
  return createElement(QueryContext.Provider, { value: { query, setQuery, revision, setRevision }, children })
}

export const useSessionAnalyticsPresenter = (sessionId: string) => {
  const selection = useContext(QueryContext)
  if (!selection) throw new Error("Session analytics requires its Session scope.")
  const { query, setQuery, revision, setRevision } = selection
  const atom = reads(JSON.stringify([sessionId, query, revision]))
  const state: LoadableView<SessionAnalytics> = AsyncResult.matchWithError(useAtomValue(atom), {
    onInitial: () => ({ _tag: "Loading" as const }),
    onError: error => ({ _tag: "Failed" as const,
      messageKey: gatewayFailureMessageKey(error.reason, error.status, error.code),
      retryable: error.reason !== "decode",
      ...(error.code === "refresh_required" ? { refreshRequired: true } : {}) }),
    onDefect: () => ({ _tag: "Failed" as const, messageKey: "analytics.unavailable" as const, retryable: false }),
    onSuccess: success => ({ _tag: "Ready" as const, value: success.value, refreshing: success.waiting })
  })
  const pin = () => state._tag === "Ready" ? { snapshot: state.value.snapshot } : {}
  return {
    state, query,
    reload: () => {
      // Full refresh drops filters that may no longer exist in the new snapshot,
      // and cannot reuse a cached read of the previous default query.
      setQuery({ metric: "tools" }); setRevision(value => value + 1)
    },
    filter: (filter: { metric?: SessionAnalyticsMetric; thread?: string; tool?: string }) =>
      setQuery({ metric: filter.metric ?? "tools", ...pin(),
        ...(filter.thread ? { thread: filter.thread } : {}),
        ...(filter.tool && ["tools", "failed_tools", "unknown_tools"].includes(filter.metric ?? "tools") ? { tool: filter.tool } : {}) }),
    next: () => {
      if (state._tag === "Ready" && state.value.evidence.nextCursor) {
        setQuery({ ...query, snapshot: state.value.snapshot, cursor: state.value.evidence.nextCursor })
      }
    },
    first: () => { const { cursor: _cursor, ...first } = query; setQuery(first) }
  }
}
