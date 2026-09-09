import { openTeamOverview, refreshOverview, type OverviewError } from "@atape/application"
import type { OverviewQuery, TeamOverview, OverviewSession } from "@atape/domain"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/unstable/reactivity"
import { Effect, Fiber, Option } from "effect"
import { useEffect, useRef, useState } from "react"
import { BrowserOverviewGatewayLayer } from "../runtime/overviewGateway"
import type { LoadableView } from "./memoryPresenter"

const runtime = Atom.runtime(BrowserOverviewGatewayLayer)
const atoms = Atom.family((key: string) => {
  const [, teamId, query] = JSON.parse(key) as [string, string, OverviewQuery]
  return runtime.atom(openTeamOverview(teamId, query))
})
function view(result: AsyncResult.AsyncResult<TeamOverview, OverviewError>): LoadableView<TeamOverview> {
  if (result._tag === "Success") return { _tag: "Ready", value: result.value, refreshing: result.waiting }
  const failed = AsyncResult.matchWithError(result, {
    onInitial: () => "", onSuccess: () => "", onError: error => error.message,
    onDefect: () => "The overview could not be loaded."
  })
  const revoked = AsyncResult.matchWithError(result, { onInitial: () => false, onSuccess: () => false, onDefect: () => false,
    onError: error => error.status === 401 || error.status === 403 || error.status === 404 })
  if (!revoked && result._tag === "Failure" && Option.isSome(result.previousSuccess)) {
    return { _tag: "Ready", value: result.previousSuccess.value.value, refreshing: result.waiting, refreshFailure: failed }
  }
  return failed ? { _tag: "Failed", message: failed, retryable: true } : { _tag: "Loading" }
}
export const useOverviewPresenter = (userId: string, teamId: string, query: OverviewQuery) => {
  const key = JSON.stringify([userId, teamId, query])
  const atom = atoms(key)
  const result = useAtomValue(atom)
  const reload = useAtomRefresh(atom)
  const state = view(result)
  const latest = useRef({ reload, pending: result.waiting })
  latest.current = { reload, pending: result.waiting }
  const [held, setHeld] = useState<{ key: string; rows: ReadonlyArray<OverviewSession> }>()
  const currentRows = state._tag === "Ready" ? state.value.sessions : undefined
  useEffect(() => {
    if (currentRows && held?.key !== key) setHeld({ key, rows: currentRows })
  }, [key, currentRows, held?.key])
  useEffect(() => {
    const fiber = Effect.runFork(refreshOverview(() => document.visibilityState === "visible", () => latest.current.pending, () => latest.current.reload()))
    return () => { Effect.runFork(Fiber.interrupt(fiber)) }
  }, [key])
  const rows = held?.key === key ? held.rows : currentRows ?? []
  const changed = currentRows !== undefined && rows.map(row => `${row.id}:${row.updatedAt}`).join() !== currentRows.map(row => `${row.id}:${row.updatedAt}`).join()
  return { state, rows, reload, hasNewConversations: changed,
    acceptConversations: () => { if (currentRows) setHeld({ key, rows: currentRows }) } }
}
