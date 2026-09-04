import {
  openConversation,
  openProjectMemory,
  type MemoryGatewayError
} from "@atape/application"
import type { Conversation, ProjectMemory } from "@atape/domain"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/unstable/reactivity"
import { BrowserMemoryGatewayLayer } from "../runtime/memoryGateway"

export type LoadableView<A> =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly value: A; readonly refreshing: boolean }
  | { readonly _tag: "Failed"; readonly message: string; readonly retryable: boolean }

const runtime = Atom.runtime(BrowserMemoryGatewayLayer)
const refreshInterval = "10 seconds"

const projectAtoms = Atom.family((projectId: string) =>
  runtime.atom(openProjectMemory(projectId)).pipe(Atom.withRefresh(refreshInterval))
)

const conversationAtoms = Atom.family((sessionId: string) =>
  Atom.family((threadId: string) =>
    runtime.atom(openConversation(sessionId, threadId)).pipe(Atom.withRefresh(refreshInterval))
  )
)

const toLoadableView = <A>(result: AsyncResult.AsyncResult<A, MemoryGatewayError>): LoadableView<A> =>
  AsyncResult.matchWithError(result, {
    onInitial: () => ({ _tag: "Loading" as const }),
    onError: (error) => ({
      _tag: "Failed" as const,
      message: error.message,
      retryable: error.reason !== "decode"
    }),
    onDefect: () => ({
      _tag: "Failed" as const,
      message: "ATape could not render this memory safely.",
      retryable: false
    }),
    onSuccess: (success) => ({
      _tag: "Ready" as const,
      value: success.value,
      refreshing: success.waiting
    })
  })

export const useProjectMemoryPresenter = (projectId: string): {
  readonly state: LoadableView<ProjectMemory>
  readonly reload: () => void
} => {
  const atom = projectAtoms(projectId)
  return {
    state: toLoadableView(useAtomValue(atom)),
    reload: useAtomRefresh(atom)
  }
}

export const useConversationPresenter = (sessionId: string, threadId: string): {
  readonly state: LoadableView<Conversation>
  readonly reload: () => void
} => {
  const atom = conversationAtoms(sessionId)(threadId)
  return {
    state: toLoadableView(useAtomValue(atom)),
    reload: useAtomRefresh(atom)
  }
}
