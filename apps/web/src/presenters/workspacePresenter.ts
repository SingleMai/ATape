import { openWorkspace, type WorkspaceGatewayError } from "@atape/application"
import type { Workspace } from "@atape/domain"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/unstable/reactivity"
import type { LoadableView } from "./memoryPresenter"
import { BrowserWorkspaceGatewayLayer } from "../runtime/workspaceGateway"

const runtime = Atom.runtime(BrowserWorkspaceGatewayLayer)
const workspaceAtom = runtime.atom(openWorkspace()).pipe(Atom.withRefresh("30 seconds"))

const toLoadableView = (
  result: AsyncResult.AsyncResult<Workspace, WorkspaceGatewayError>
): LoadableView<Workspace> => AsyncResult.matchWithError(result, {
  onInitial: () => ({ _tag: "Loading" as const }),
  onError: (error) => ({
    _tag: "Failed" as const,
    message: error.message,
    retryable: error.reason !== "decode"
  }),
  onDefect: () => ({
    _tag: "Failed" as const,
    message: "ATape could not render the Workspace directory safely.",
    retryable: false
  }),
  onSuccess: (success) => ({
    _tag: "Ready" as const,
    value: success.value,
    refreshing: success.waiting
  })
})

export const useWorkspacePresenter = (): {
  readonly state: LoadableView<Workspace>
  readonly reload: () => void
} => ({
  state: toLoadableView(useAtomValue(workspaceAtom)),
  reload: useAtomRefresh(workspaceAtom)
})
