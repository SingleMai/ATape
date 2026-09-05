import { selectDefaultWorkspaceProject } from "@atape/domain"
import { Option, Schema } from "effect"
import {
  Navigate,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useRouterState
} from "@tanstack/react-router"
import { useConversationPresenter, useProjectMemoryPresenter } from "./presenters/memoryPresenter"
import { useSessionRawPresenter } from "./presenters/rawPresenter"
import { useSearchPresenter } from "./presenters/searchPresenter"
import { useWorkspacePresenter } from "./presenters/workspacePresenter"
import { AppShell } from "./view/AppShell"
import { ProjectMemoryView } from "./view/ProjectMemoryView"
import { SessionReaderView } from "./view/SessionReaderView"
import { RawDrawer } from "./view/RawDrawer"
import { SearchView } from "./view/SearchView"
import { WorkspaceHomeView } from "./view/WorkspaceHomeView"

const SessionSearch = Schema.Struct({
  thread: Schema.optionalKey(Schema.String),
  event: Schema.optionalKey(Schema.String),
  from: Schema.optionalKey(Schema.Literal("search")),
  q: Schema.optionalKey(Schema.String),
  raw: Schema.optionalKey(Schema.Literal("open"))
})

type SessionLocationSearch = {
  readonly thread: string
  readonly event?: string
  readonly from?: "search"
  readonly q?: string
  readonly raw?: "open"
}

const parseSessionSearch = (input: unknown): SessionLocationSearch =>
  Option.match(Schema.decodeUnknownOption(SessionSearch)(input), {
    onNone: () => ({ thread: "root" }),
    onSome: (value) => ({
      thread: value.thread ?? "root",
      ...(value.event ? { event: value.event } : {}),
      ...(value.from ? { from: value.from } : {}),
      ...(value.q ? { q: value.q } : {}),
      ...(value.raw ? { raw: value.raw } : {})
    })
  })

const ProjectSearch = Schema.Struct({
  q: Schema.optionalKey(Schema.String),
  cursor: Schema.optionalKey(Schema.String)
})

const parseProjectSearch = (input: unknown): { readonly q: string; readonly cursor: string } =>
  Option.match(Schema.decodeUnknownOption(ProjectSearch)(input), {
    onNone: () => ({ q: "", cursor: "" }),
    onSome: (value) => ({ q: value.q ?? "", cursor: value.cursor ?? "" })
  })

const RootLayout = () => {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const match = pathname.match(/^\/teams\/([^/]+)\/projects\/([^/]+)/)
  const teamId = match?.[1]
  const projectId = match?.[2]
  const workspace = useWorkspacePresenter()
  const openSearch = teamId === undefined || projectId === undefined ? undefined : () => {
    if (pathname.endsWith("/search")) {
      const input = document.getElementById("project-search")
      if (input instanceof HTMLInputElement) {
        input.focus()
        input.select()
      }
      return
    }
    void navigate({
      to: "/teams/$teamId/projects/$projectId/search",
      params: { teamId, projectId },
      search: { q: "", cursor: "" }
    })
  }
  return (
    <AppShell
      workspace={workspace.state}
      currentTeamId={teamId}
      currentProjectId={projectId}
      onRetryWorkspace={workspace.reload}
      onOpenProject={(nextTeamId, nextProjectId) => {
        void navigate({
          to: "/teams/$teamId/projects/$projectId",
          params: { teamId: nextTeamId, projectId: nextProjectId }
        })
      }}
      {...(openSearch === undefined ? {} : { onOpenSearch: openSearch })}
    >
      <Outlet />
    </AppShell>
  )
}

const rootRoute = createRootRoute({ component: RootLayout })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: WorkspaceHomeRoute
})

function WorkspaceHomeRoute() {
  const workspace = useWorkspacePresenter()
  if (workspace.state._tag === "Ready") {
    const target = selectDefaultWorkspaceProject(workspace.state.value)
    if (target !== undefined) {
      return (
        <Navigate
          to="/teams/$teamId/projects/$projectId"
          params={target}
          replace
        />
      )
    }
  }
  return <WorkspaceHomeView state={workspace.state} onRetry={workspace.reload} />
}

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/teams/$teamId/projects/$projectId",
  component: ProjectRoute
})

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/teams/$teamId/projects/$projectId/sessions/$sessionId",
  validateSearch: parseSessionSearch,
  component: SessionRoute
})

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/teams/$teamId/projects/$projectId/search",
  validateSearch: parseProjectSearch,
  component: SearchRoute
})

function ProjectRoute() {
  const params = projectRoute.useParams()
  const navigate = useNavigate()
  const presenter = useProjectMemoryPresenter(params.projectId)

  return (
    <ProjectMemoryView
      state={presenter.state}
      onRetry={presenter.reload}
      onOpenSession={(sessionId) => {
        void navigate({
          to: "/teams/$teamId/projects/$projectId/sessions/$sessionId",
          params: { ...params, sessionId },
          search: { thread: "root" }
        })
      }}
    />
  )
}

function SessionRoute() {
  const params = sessionRoute.useParams()
  const search = sessionRoute.useSearch()
  const navigate = useNavigate()
  const presenter = useConversationPresenter(params.sessionId, search.thread)

  return (
    <>
      <SessionReaderView
      state={presenter.state}
      projectName={params.projectId}
      onRetry={presenter.reload}
      onOpenRaw={() => {
        void navigate({
          to: "/teams/$teamId/projects/$projectId/sessions/$sessionId",
          params,
          search: { ...search, raw: "open" }
        })
      }}
      {...(search.event ? { highlightedEventId: search.event } : {})}
      {...(search.from === "search" && search.q ? {
        searchOrigin: {
          query: search.q,
          onReturn: () => window.history.back()
        }
      } : {})}
      onBack={() => {
        void navigate({
          to: "/teams/$teamId/projects/$projectId",
          params: { teamId: params.teamId, projectId: params.projectId }
        })
      }}
      onOpenThread={(threadId) => {
        void navigate({
          to: "/teams/$teamId/projects/$projectId/sessions/$sessionId",
          params,
          search: search.from === "search"
            ? { thread: threadId, from: "search", q: search.q ?? "" }
            : { thread: threadId }
        })
      }}
      />
      {search.raw === "open" && (
        <RawDrawerRoute
          sessionId={params.sessionId}
          onClose={() => {
            const { raw: _raw, ...readerSearch } = search
            void navigate({
              to: "/teams/$teamId/projects/$projectId/sessions/$sessionId",
              params,
              search: readerSearch,
              replace: true
            })
          }}
        />
      )}
    </>
  )
}

function RawDrawerRoute({ sessionId, onClose }: { readonly sessionId: string; readonly onClose: () => void }) {
  const presenter = useSessionRawPresenter(sessionId)
  return <RawDrawer state={presenter.state} onRetry={presenter.reload} onClose={onClose} />
}

function SearchRoute() {
  const params = searchRoute.useParams()
  const search = searchRoute.useSearch()
  const navigate = useNavigate()
  const presenter = useSearchPresenter(params.projectId, search.q, search.cursor)

  const openSearch = (query: string, cursor = "") => {
    void navigate({
      to: "/teams/$teamId/projects/$projectId/search",
      params,
      search: { q: query, cursor },
      replace: true
    })
  }

  return (
    <SearchView
      state={presenter.state}
      query={search.q}
      onRetry={presenter.reload}
      onSearch={(query) => openSearch(query)}
      onNextPage={(cursor) => openSearch(search.q, cursor)}
      onClose={() => window.history.back()}
      onOpenResult={(result) => {
        void navigate({
          to: "/teams/$teamId/projects/$projectId/sessions/$sessionId",
          params: { ...params, sessionId: result.sessionId },
          search: {
            thread: result.threadId,
            event: result.eventId,
            from: "search",
            q: search.q
          }
        })
      }}
    />
  )
}

const routeTree = rootRoute.addChildren([indexRoute, projectRoute, sessionRoute, searchRoute])

export const router = createRouter({
  routeTree,
  defaultPreload: "intent"
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
