import { openTeamOverview, openTeamOverviewSessions, type OverviewError } from "@atape/application"
import type { OverviewQuery, OverviewSelection, TeamOverview } from "@atape/domain"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/unstable/reactivity"
import { Effect, Option } from "effect"
import { BrowserOverviewGatewayLayer } from "../runtime/overviewGateway"
import { gatewayFailureMessageKey, type LoadableView } from "./memoryPresenter"
import type { WebMessageKey } from "../i18n"

const runtime = Atom.runtime(BrowserOverviewGatewayLayer)
const atoms = Atom.family((key: string) => {
  const [, teamId, query, sessionsOnly] = JSON.parse(key) as [string, string, OverviewQuery, boolean]
  return runtime.atom(sessionsOnly
    ? openTeamOverviewSessions(teamId, query).pipe(Effect.map(page => ({ ...page, trend: [], members: [], projects: [], models: [] })))
    : openTeamOverview(teamId, query))
})
function view(result: AsyncResult.AsyncResult<TeamOverview, OverviewError>): LoadableView<TeamOverview> {
  if (result._tag === "Success") return { _tag: "Ready", value: result.value, refreshing: result.waiting }
  const failed: WebMessageKey | undefined = AsyncResult.matchWithError(result, {
    onInitial: () => undefined, onSuccess: () => undefined,
    onError: error => gatewayFailureMessageKey(error.reason, error.status),
    onDefect: () => "errors.defect.overview" as const
  })
  const revoked = AsyncResult.matchWithError(result, { onInitial: () => false, onSuccess: () => false, onDefect: () => false,
    onError: error => error.status === 401 || error.status === 403 || error.status === 404 })
  if (!revoked && result._tag === "Failure" && Option.isSome(result.previousSuccess) && failed !== undefined) {
    return { _tag: "Ready", value: result.previousSuccess.value.value, refreshing: result.waiting, refreshFailureKey: failed }
  }
  return failed !== undefined ? { _tag: "Failed", messageKey: failed, retryable: true } : { _tag: "Loading" }
}
export const useOverviewPresenter = (userId: string, teamId: string, selection: OverviewSelection) => {
  // Dimension tables already have all rows. Their local page must not request
  // another Session page or recompute the complete dashboard.
  // Construct a canonical key: router search objects can change property order.
  const query: OverviewQuery = {
    days: selection.days, from: selection.from, to: selection.to,
    project: selection.project, member: selection.member, agent: selection.agent, model: selection.model,
    page: selection.view === "sessions" ? selection.page : 0
  }
  const key = JSON.stringify([userId, teamId, query, selection.view === "sessions" && query.page > 0])
  const atom = atoms(key)
  const result = useAtomValue(atom)
  const reload = useAtomRefresh(atom)
  const state = view(result)
  return { state, reload }
}
