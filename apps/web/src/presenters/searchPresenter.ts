import { searchProject, type SearchGatewayError } from "@atape/application"
import type { SearchPage } from "@atape/domain"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Effect } from "effect"
import { AsyncResult, Atom } from "effect/unstable/reactivity"
import type { LoadableView } from "./memoryPresenter"
import { BrowserSearchGatewayLayer } from "../runtime/searchGateway"

const runtime = Atom.runtime(BrowserSearchGatewayLayer)

const emptyPage = (projectId: string): SearchPage => ({
  projectId,
  query: "",
  results: []
})

const searchAtoms = Atom.family((projectId: string) =>
  Atom.family((query: string) =>
    Atom.family((cursor: string) => runtime.atom(
      query.trim() === ""
        ? Effect.succeed(emptyPage(projectId))
        : searchProject({ projectId, query, ...(cursor ? { cursor } : {}) })
    ))
  )
)

const toLoadableView = (
  result: AsyncResult.AsyncResult<SearchPage, SearchGatewayError>
): LoadableView<SearchPage> => AsyncResult.matchWithError(result, {
  onInitial: () => ({ _tag: "Loading" as const }),
  onError: (error) => ({
    _tag: "Failed" as const,
    message: error.message,
    retryable: error.reason !== "decode"
  }),
  onDefect: () => ({
    _tag: "Failed" as const,
    message: "ATape could not render these Search results safely.",
    retryable: false
  }),
  onSuccess: (success) => ({
    _tag: "Ready" as const,
    value: success.value,
    refreshing: success.waiting
  })
})

export const useSearchPresenter = (projectId: string, query: string, cursor: string): {
  readonly state: LoadableView<SearchPage>
  readonly reload: () => void
} => {
  const atom = searchAtoms(projectId)(query)(cursor)
  return {
    state: toLoadableView(useAtomValue(atom)),
    reload: useAtomRefresh(atom)
  }
}
