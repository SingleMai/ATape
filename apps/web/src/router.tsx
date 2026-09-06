import { safeLocalReturnTo, selectDefaultWorkspaceProject, type AuthenticatedSession } from "@atape/domain"
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
import { createContext, useContext, useEffect, useRef } from "react"
import {
  useAccountSecurityPresenter,
  useCLIAuthorizationPresenter,
  useCreateTeamPresenter,
  useJoinTeamPresenter,
  useLogoutPresenter,
  useReauthenticationPresenter,
  useSessionPresenter,
  useSignInPresenter,
  useTeamAccessPresenter
} from "./presenters/accessPresenter"
import { useConversationPresenter, useProjectMemoryPresenter } from "./presenters/memoryPresenter"
import { useSessionRawPresenter } from "./presenters/rawPresenter"
import { useSearchPresenter } from "./presenters/searchPresenter"
import { useWorkspacePresenter } from "./presenters/workspacePresenter"
import { AppShell } from "./view/AppShell"
import { AuthenticationErrorView, SignInView } from "./view/SignInView"
import { CLIAuthorizationView } from "./view/CLIAuthorizationView"
import { FailureNotice, FullPageState } from "./view/AccessPrimitives"
import { ProjectMemoryView } from "./view/ProjectMemoryView"
import { RawDrawer } from "./view/RawDrawer"
import { SearchView } from "./view/SearchView"
import { AccountSecurityView, TeamAccessView } from "./view/SecuritySettingsView"
import { SessionReaderView } from "./view/SessionReaderView"
import { CreateTeamView, JoinTeamView, TeamChoiceView } from "./view/TeamOnboardingView"
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

const SignInSearch = Schema.Struct({
  returnTo: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.Literals(["signed_out", "session_ended"]))
})

const parseSignInSearch = (input: unknown): {
  readonly returnTo: string
  readonly reason?: "signed_out" | "session_ended"
} => Option.match(Schema.decodeUnknownOption(SignInSearch)(input), {
  onNone: () => ({ returnTo: "/" }),
  onSome: (value) => ({
    returnTo: safeLocalReturnTo(value.returnTo),
    ...(value.reason === undefined ? {} : { reason: value.reason })
  })
})

const AuthErrorSearch = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  incident: Schema.optionalKey(Schema.String)
})

const parseAuthErrorSearch = (input: unknown): { readonly code: string; readonly incident?: string } =>
  Option.match(Schema.decodeUnknownOption(AuthErrorSearch)(input), {
    onNone: () => ({ code: "login_failed" }),
    onSome: (value) => ({
      code: value.code !== undefined && value.code.length <= 100 ? value.code : "login_failed",
      ...(value.incident !== undefined && value.incident.length <= 100 ? { incident: value.incident } : {})
    })
  })

const CLIAuthSearch = Schema.Struct({ user_code: Schema.optionalKey(Schema.String) })
const parseCLIAuthSearch = (input: unknown): { readonly user_code: string } =>
  Option.match(Schema.decodeUnknownOption(CLIAuthSearch)(input), {
    onNone: () => ({ user_code: "" }),
    onSome: (value) => ({ user_code: value.user_code !== undefined && value.user_code.length <= 32 ? value.user_code : "" })
  })

const rootRoute = createRootRoute({ component: Outlet })
const AuthenticatedSessionContext = createContext<AuthenticatedSession | undefined>(undefined)

const useAuthenticatedSession = (): AuthenticatedSession => {
  const value = useContext(AuthenticatedSessionContext)
  if (value === undefined) throw new Error("Authenticated route rendered without a Session.")
  return value
}

const SessionFailure = ({ failure, onRetry }: {
  readonly failure: Parameters<typeof FailureNotice>[0]["failure"]
  readonly onRetry: () => void
}) => (
  <div className="access-page">
    <main className="access-state-card" id="main-content"><FailureNotice failure={failure} onRetry={onRetry} /></main>
  </div>
)

const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authenticated",
  component: AuthenticatedBoundary
})

function AuthenticatedBoundary() {
  const session = useSessionPresenter()
  const navigate = useNavigate()
  useEffect(() => {
    if (session.state._tag !== "Unauthenticated") return
    const returnTo = safeLocalReturnTo(
      window.location.pathname + window.location.search + window.location.hash
    )
    void navigate({
      to: "/auth/sign-in",
      search: { returnTo, reason: "session_ended" },
      replace: true
    })
  }, [navigate, session.state._tag])
  if (session.state._tag === "Loading") return <FullPageState role="status">Restoring your ATape session…</FullPageState>
  if (session.state._tag === "Failed") return <SessionFailure failure={session.state.failure} onRetry={session.reload} />
  if (session.state._tag === "Unauthenticated") {
    return <FullPageState role="status">Taking you to sign in…</FullPageState>
  }
  return (
    <AuthenticatedSessionContext.Provider value={session.state.value}>
      <Outlet />
    </AuthenticatedSessionContext.Provider>
  )
}

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/sign-in",
  validateSearch: parseSignInSearch,
  component: SignInRoute
})

function SignInRoute() {
  const search = signInRoute.useSearch()
  const session = useSessionPresenter()
  const presenter = useSignInPresenter()
  useEffect(() => {
    if (presenter.action._tag === "Succeeded") window.location.assign(presenter.action.value)
  }, [presenter.action])
  if (session.state._tag === "Authenticated") return <Navigate to={search.returnTo} replace />
  return (
    <SignInView
      options={presenter.options}
      action={presenter.action}
      cliReturn={search.returnTo.startsWith("/cli/authorize")}
      {...(search.reason === "signed_out"
        ? { flash: "This browser session was signed out." }
        : search.reason === "session_ended"
          ? { flash: "Your previous session ended. Sign in again to continue." }
          : {})}
      onRetry={presenter.reloadOptions}
      onSignIn={(providerRegistrationId) => presenter.signIn({
        providerRegistrationId,
        returnTo: search.returnTo
      })}
    />
  )
}

const authErrorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/error",
  validateSearch: parseAuthErrorSearch,
  component: () => {
    const search = authErrorRoute.useSearch()
    return <AuthenticationErrorView code={search.code} {...(search.incident === undefined ? {} : { incident: search.incident })} />
  }
})

const cliAuthorizationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cli/authorize",
  validateSearch: parseCLIAuthSearch,
  component: CLIAuthorizationRoute
})

function CLIAuthorizationRoute() {
  const search = cliAuthorizationRoute.useSearch()
  const session = useSessionPresenter()
  const signIn = useSignInPresenter()
  const authorization = useCLIAuthorizationPresenter()
  const attemptedCode = useRef("")
  const returnTo = safeLocalReturnTo(`/cli/authorize${search.user_code === "" ? "" : `?${new URLSearchParams({ user_code: search.user_code })}`}`)

  useEffect(() => {
    if (signIn.action._tag === "Succeeded") window.location.assign(signIn.action.value)
  }, [signIn.action])
  useEffect(() => {
    if (session.state._tag === "Authenticated" && search.user_code !== "" && attemptedCode.current !== search.user_code) {
      attemptedCode.current = search.user_code
      authorization.open(search.user_code)
    }
  }, [authorization, search.user_code, session.state])
  useEffect(() => () => authorization.reset(), [authorization.reset])

  if (session.state._tag === "Loading") return <FullPageState role="status">Restoring your session before showing the CLI request…</FullPageState>
  if (session.state._tag === "Failed") return <SessionFailure failure={session.state.failure} onRetry={session.reload} />
  if (session.state._tag === "Unauthenticated") {
    return <SignInView
      options={signIn.options}
      action={signIn.action}
      cliReturn
      onRetry={signIn.reloadOptions}
      onSignIn={(providerRegistrationId) => signIn.signIn({ providerRegistrationId, returnTo })}
    />
  }
  return (
    <CLIAuthorizationView
      user={session.state.value.user}
      requestedCode={search.user_code}
      resolution={authorization.resolution}
      decision={authorization.decision}
      onResolve={authorization.open}
      onDecide={(grantViewId, decision) => authorization.decide({ grantViewId, decision })}
    />
  )
}

const workspaceLayoutRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  id: "workspace",
  component: WorkspaceLayout
})

function WorkspaceLayout() {
  const session = useAuthenticatedSession()
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
      currentUser={session.user}
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

const indexRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/",
  component: WorkspaceHomeRoute
})

function WorkspaceHomeRoute() {
  const workspace = useWorkspacePresenter()
  if (workspace.state._tag === "Ready") {
    if (workspace.state.value.teams.length === 0) return <Navigate to="/onboarding" replace />
    const target = selectDefaultWorkspaceProject(workspace.state.value)
    if (target !== undefined) {
      return <Navigate to="/teams/$teamId/projects/$projectId" params={target} replace />
    }
  }
  return <WorkspaceHomeView state={workspace.state} onRetry={workspace.reload} />
}

const projectRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/teams/$teamId/projects/$projectId",
  component: ProjectRoute
})

const sessionRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/teams/$teamId/projects/$projectId/sessions/$sessionId",
  validateSearch: parseSessionSearch,
  component: SessionRoute
})

const searchRoute = createRoute({
  getParentRoute: () => workspaceLayoutRoute,
  path: "/teams/$teamId/projects/$projectId/search",
  validateSearch: parseProjectSearch,
  component: SearchRoute
})

function ProjectRoute() {
  const params = projectRoute.useParams()
  const navigate = useNavigate()
  const presenter = useProjectMemoryPresenter(params.projectId)
  return <ProjectMemoryView state={presenter.state} onRetry={presenter.reload} onOpenSession={(sessionId) => {
    void navigate({
      to: "/teams/$teamId/projects/$projectId/sessions/$sessionId",
      params: { ...params, sessionId },
      search: { thread: "root" }
    })
  }} />
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
        onOpenRaw={() => void navigate({
          to: "/teams/$teamId/projects/$projectId/sessions/$sessionId",
          params,
          search: { ...search, raw: "open" }
        })}
        {...(search.event ? { highlightedEventId: search.event } : {})}
        {...(search.from === "search" && search.q ? { searchOrigin: { query: search.q, onReturn: () => window.history.back() } } : {})}
        onBack={() => void navigate({
          to: "/teams/$teamId/projects/$projectId",
          params: { teamId: params.teamId, projectId: params.projectId }
        })}
        onOpenThread={(threadId) => void navigate({
          to: "/teams/$teamId/projects/$projectId/sessions/$sessionId",
          params,
          search: search.from === "search" ? { thread: threadId, from: "search", q: search.q ?? "" } : { thread: threadId }
        })}
      />
      {search.raw === "open" && <RawDrawerRoute sessionId={params.sessionId} onClose={() => {
        const { raw: _raw, ...readerSearch } = search
        void navigate({
          to: "/teams/$teamId/projects/$projectId/sessions/$sessionId",
          params,
          search: readerSearch,
          replace: true
        })
      }} />}
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
  const openSearch = (query: string, cursor = "") => void navigate({
    to: "/teams/$teamId/projects/$projectId/search",
    params,
    search: { q: query, cursor },
    replace: true
  })
  return <SearchView
    state={presenter.state}
    query={search.q}
    onRetry={presenter.reload}
    onSearch={(query) => openSearch(query)}
    onNextPage={(cursor) => openSearch(search.q, cursor)}
    onClose={() => window.history.back()}
    onOpenResult={(result) => void navigate({
      to: "/teams/$teamId/projects/$projectId/sessions/$sessionId",
      params: { ...params, sessionId: result.sessionId },
      search: { thread: result.threadId, event: result.eventId, from: "search", q: search.q }
    })}
  />
}

const onboardingRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/onboarding",
  component: TeamChoiceRoute
})

function TeamChoiceRoute() {
  const session = useAuthenticatedSession()
  return <TeamChoiceView user={session.user} />
}

const createTeamRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/onboarding/create-team",
  component: CreateTeamRoute
})

function CreateTeamRoute() {
  const session = useAuthenticatedSession()
  const presenter = useCreateTeamPresenter()
  const workspace = useWorkspacePresenter()
  const navigate = useNavigate()
  const handled = useRef("")
  useEffect(() => {
    if (presenter.action._tag === "Succeeded" && handled.current !== presenter.action.value.id) {
      handled.current = presenter.action.value.id
      workspace.reload()
      presenter.reset()
      void navigate({ to: "/", replace: true })
    }
  }, [navigate, presenter, workspace])
  return <CreateTeamView
    user={session.user}
    action={presenter.action}
    instanceOrigin={window.location.origin}
    onSubmit={presenter.submit}
  />
}

const joinTeamRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/onboarding/join-team",
  component: JoinTeamRoute
})

function JoinTeamRoute() {
  const session = useAuthenticatedSession()
  const presenter = useJoinTeamPresenter()
  const workspace = useWorkspacePresenter()
  const navigate = useNavigate()
  const handled = useRef("")
  useEffect(() => {
    if (presenter.action._tag === "Succeeded" && handled.current !== presenter.action.value.id) {
      handled.current = presenter.action.value.id
      workspace.reload()
      presenter.reset()
      void navigate({ to: "/", replace: true })
    }
  }, [navigate, presenter, workspace])
  return <JoinTeamView user={session.user} action={presenter.action} onSubmit={presenter.submit} />
}

const accountSettingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/settings/account",
  component: AccountSettingsRoute
})

function AccountSettingsRoute() {
  const session = useAuthenticatedSession()
  const account = useAccountSecurityPresenter()
  const logout = useLogoutPresenter()
  const sessionPresenter = useSessionPresenter()
  const workspace = useWorkspacePresenter()
  const navigate = useNavigate()
  const lastAction = useRef<{ readonly signsOut: boolean } | undefined>(undefined)
  const handled = useRef(false)
  useEffect(() => () => account.resetAction(), [account.resetAction])
  useEffect(() => {
    if (account.action._tag === "Pending") handled.current = false
    if (account.action._tag === "Succeeded" && !handled.current) {
      handled.current = true
      if (lastAction.current?.signsOut === true) {
        sessionPresenter.reload()
        void navigate({ to: "/auth/sign-in", search: { returnTo: "/", reason: "signed_out" }, replace: true })
      } else {
        account.reload()
      }
    }
  }, [account, navigate, sessionPresenter])
  useEffect(() => {
    if (logout.action._tag === "Succeeded") {
      sessionPresenter.reload()
      void navigate({ to: "/auth/sign-in", search: { returnTo: "/", reason: "signed_out" }, replace: true })
    }
  }, [logout.action, navigate, sessionPresenter])
  const firstTeam = workspace.state._tag === "Ready" ? workspace.state.value.teams[0] : undefined
  return <AccountSecurityView
    user={session.user}
    {...(firstTeam === undefined ? {} : { team: { slug: firstTeam.slug, displayName: firstTeam.name } })}
    state={account.state}
    action={account.action}
    onRetry={account.reload}
    onAction={(input) => {
      const currentSession = account.state._tag === "Ready" && account.state.value.webSessions._tag === "Ready"
        ? account.state.value.webSessions.value.find((item) => item.id === input.id)
        : undefined
      lastAction.current = {
        signsOut: input.kind === "revoke-all-web" || (input.kind === "revoke-web" && currentSession?.current === true)
      }
      account.run(input)
    }}
    onSignOut={() => logout.logout(undefined)}
  />
}

const teamAccessRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "/teams/$teamSlug/settings/access",
  component: TeamAccessRoute
})

function TeamAccessRoute() {
  const { teamSlug } = teamAccessRoute.useParams()
  const session = useAuthenticatedSession()
  const access = useTeamAccessPresenter(teamSlug)
  const reauthentication = useReauthenticationPresenter()
  const logout = useLogoutPresenter()
  const sessionPresenter = useSessionPresenter()
  const workspace = useWorkspacePresenter()
  const navigate = useNavigate()
  const lastAction = useRef<{ readonly kind: string } | undefined>(undefined)
  const handled = useRef(false)
  useEffect(() => () => access.resetAction(), [access.resetAction])
  useEffect(() => {
    if (access.action._tag === "Pending") handled.current = false
    if (access.action._tag === "Succeeded" && !handled.current) {
      handled.current = true
      workspace.reload()
      if (lastAction.current?.kind === "leave") {
        access.resetAction()
        void navigate({ to: "/onboarding", replace: true })
      } else {
        access.reload()
        if (lastAction.current?.kind !== "rotate-code") access.resetAction()
      }
    }
  }, [access, navigate, workspace])
  useEffect(() => {
    if (reauthentication.action._tag === "Succeeded") window.location.assign(reauthentication.action.value)
  }, [reauthentication.action])
  useEffect(() => {
    if (logout.action._tag === "Succeeded") {
      sessionPresenter.reload()
      void navigate({ to: "/auth/sign-in", search: { returnTo: "/", reason: "signed_out" }, replace: true })
    }
  }, [logout.action, navigate, sessionPresenter])
  return <TeamAccessView
    user={session.user}
    state={access.state}
    action={access.action}
    onRetry={access.reload}
    onAction={(input) => {
      lastAction.current = input
      access.run(input)
    }}
    onReauthenticate={() => reauthentication.reauthenticate(`/teams/${encodeURIComponent(teamSlug)}/settings/access`)}
    onSignOut={() => logout.logout(undefined)}
  />
}

const routeTree = rootRoute.addChildren([
  signInRoute,
  authErrorRoute,
  cliAuthorizationRoute,
  authenticatedRoute.addChildren([
    onboardingRoute,
    createTeamRoute,
    joinTeamRoute,
    accountSettingsRoute,
    teamAccessRoute,
    workspaceLayoutRoute.addChildren([indexRoute, projectRoute, sessionRoute, searchRoute])
  ])
])

export const router = createRouter({ routeTree, defaultPreload: "intent" })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
