import { searchWorkspace, type WorkspaceSearchRequest, type SearchGatewayError } from "@atape/application"
import type { Workspace } from "@atape/domain"
import { useEffect, useMemo, useState } from "react"
import type { SearchSeed } from "./searchOverlayContext"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult, Atom } from "effect/unstable/reactivity"
import type { LoadableView } from "./memoryPresenter"
import { BrowserSearchGatewayLayer } from "../runtime/searchGateway"

const runtime = Atom.runtime(BrowserSearchGatewayLayer)

const toLoadableView = <A>(result: AsyncResult.AsyncResult<A, SearchGatewayError>): LoadableView<A> =>
  AsyncResult.matchWithError(result, {
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

const workspaceSearchAtoms = Atom.family((serialized: string) =>
  runtime.atom(searchWorkspace(JSON.parse(serialized) as WorkspaceSearchRequest))
)

type SearchSelection = {
  readonly query: string
  readonly teamId: string
  readonly projectId: string
  readonly pages: ReadonlyArray<Readonly<Record<string, string>> | undefined>
  readonly pageIndex: number
}

const initialSelection = (seed?: SearchSeed): SearchSelection => ({
  query: seed?.query.trim() ?? "",
  teamId: "",
  projectId: seed?.projectId ?? "",
  pages: [undefined],
  pageIndex: 0
})

export const useWorkspaceSearchPresenter = (workspace: Workspace, seed?: SearchSeed) => {
  const [draft, setDraft] = useState(seed?.query ?? "")
  const [selection, setSelection] = useState(() => initialSelection(seed))
  const [recent, setRecent] = useState<ReadonlyArray<string>>([])
  const { query, teamId, projectId, pages, pageIndex } = selection
  const projects = useMemo(
    () =>
      workspace.teams
        .flatMap((team) =>
          team.projects.map((project) => ({
            teamId: team.id,
            teamName: team.name,
            projectId: project.id,
            projectName: project.name
          }))
        )
        .sort((a, b) => a.teamName.localeCompare(b.teamName) || a.projectName.localeCompare(b.projectName)),
    [workspace]
  )
  const scope = projects.filter(
    (project) => (!teamId || project.teamId === teamId) && (!projectId || project.projectId === projectId)
  )
  const validQuery = new TextEncoder().encode(query).length <= 200
  const request: WorkspaceSearchRequest = {
    projects: scope,
    query: validQuery ? query : "",
    ...(pages[pageIndex] === undefined ? {} : { cursors: pages[pageIndex] })
  }
  const atom = workspaceSearchAtoms(JSON.stringify(request))
  const state = toLoadableView(useAtomValue(atom))
  const reload = useAtomRefresh(atom)

  const updateScope = (patch: Partial<Pick<SearchSelection, "teamId" | "projectId">>) => {
    setSelection((current) => ({ ...current, ...patch, pages: [undefined], pageIndex: 0 }))
  }
  useEffect(() => {
    if (seed === undefined) return
    setDraft(seed.query)
    setSelection(initialSelection(seed))
  }, [seed])
  useEffect(() => {
    // Debounce unfinished input; an already-submitted query must not reset paging.
    const timeout = window.setTimeout(
      () =>
        setSelection((current) =>
          current.query === draft.trim()
            ? current
            : { ...current, query: draft.trim(), pages: [undefined], pageIndex: 0 }
        ),
      300
    )
    return () => window.clearTimeout(timeout)
  }, [draft])

  return {
    state,
    reload,
    draft,
    setDraft,
    query,
    teamId,
    projectId,
    projects,
    validQuery,
    pageIndex,
    recent,
    pending: draft.trim() !== query || state._tag === "Loading",
    page: state._tag === "Ready" ? state.value : undefined,
    setTeam: (value: string) => updateScope({ teamId: value, projectId: "" }),
    setProject: (value: string) => updateScope({ projectId: value }),
    clearTeam: () => updateScope({ teamId: "" }),
    clearFilters: () => updateScope({ teamId: "", projectId: "" }),
    submit: () => {
      setSelection((current) => ({ ...current, query: draft.trim(), pages: [undefined], pageIndex: 0 }))
      if (draft.trim() === query && pageIndex === 0) reload()
    },
    rememberQuery: () => setRecent((items) => [query, ...items.filter((item) => item !== query)].slice(0, 5)),
    previous: () =>
      setSelection((current) => ({ ...current, pageIndex: Math.max(0, current.pageIndex - 1) })),
    next: () => {
      if (state._tag !== "Ready" || Object.keys(state.value.nextCursors).length === 0) return
      setSelection((current) => ({
        ...current,
        pages: [...current.pages.slice(0, current.pageIndex + 1), state.value.nextCursors],
        pageIndex: current.pageIndex + 1
      }))
    }
  }
}

export type WorkspaceSearchViewModel = ReturnType<typeof useWorkspaceSearchPresenter>
