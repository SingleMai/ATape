import { decideProjectSetup, describeClientFailure,
  CLIAuthenticationInteraction, CLISetupPlatform, completeGuidedSetup, checkCLIUpgrade, upgradeCLI, resumeCLIUpgrade, CLIUpgradeError,
  experienceOnboardingURL, inspectCLIExperience, inspectClient, inspectTools, planToolChange, applyToolChange,
  inspectToolUpdates, updateToolRelease, type ToolRelease,
  loginCLI, logoutCLI, updateSyncReader, observeInitialSync, prepareGuidedSetup, removeExperienceProject, selectInstanceOrigin,
  setActiveInstance, startExperienceCollector, stopExperienceCollector, setClientLocale, installAdapter, upgradeAdapters, pruneAdapterPackages,
  type CLIExperienceSnapshot, type ConsoleProject, type DirectorySuggestion, type GuidedSetupPlan, type SourceChoice, type ProjectRecovery
} from "@atape/application"
import type { AdapterSourceFailure, LocalProject } from "@atape/domain"
import { Effect, type Layer } from "effect"
import { launchBrowser } from "../runtime/authenticationLayers.ts"
import type { makeNodeClientLayer } from "../runtime/clientLayers.ts"
import { t } from "../i18n/index.ts"
import { isLocale } from "@atape/i18n"
import { officialSourceLabel as toolLabel } from "@atape/adapter-catalog"

export type ExperienceRequirements = Layer.Success<ReturnType<typeof makeNodeClientLayer>>
export type ExperienceRunner = <A, E>(effect: Effect.Effect<A, E, ExperienceRequirements>, signal: AbortSignal) => Promise<A>
type ScreenOption = { readonly value: string; readonly label: string }
type InputFields = {
  readonly initial: string
  readonly suggestions?: ReadonlyArray<DirectorySuggestion>
  readonly directoriesLoading?: boolean
  readonly pathInput?: boolean
}
type MenuFields = {
  readonly refreshing?: boolean
  readonly refreshable?: boolean
  readonly refreshError?: string
  readonly diagnostics?: boolean
  readonly exitOnBack?: boolean
  readonly layout?: "welcome" | "projects"
  readonly actions?: ReadonlyArray<ScreenOption>
  readonly projects?: ReadonlyArray<{ value: string; name: string; status: string; team: string }>
  readonly focusedProject?: string
}
// Absent fields remain readable for render bindings, but cannot be populated on
// another screen kind. Menu options, input values and source selections are required.
type Absent<T> = { readonly [K in keyof T]?: never }
type ScreenContent = {
  readonly title: string
  readonly details: ReadonlyArray<string>
  readonly notice?: string
  readonly context?: string
} & (
  | { readonly kind: "busy"; readonly options?: never; readonly selected?: never } & Absent<InputFields & MenuFields>
  | { readonly kind: "input"; readonly options?: never; readonly selected?: never } & InputFields & Absent<MenuFields>
  | { readonly kind: "menu"; readonly options: ReadonlyArray<ScreenOption>; readonly selected?: never } & MenuFields & Absent<InputFields>
  | { readonly kind: "sources"; readonly options: ReadonlyArray<ScreenOption>; readonly selected: ReadonlyArray<string> } & Absent<InputFields & MenuFields>
)
export type Screen = ScreenContent & { readonly revision: number }
const stateLabel = (state: ConsoleProject["state"]): string => {
  switch (state) {
    case "no_sources": return t("cli.state.noSources", "No tools enabled")
    case "stopped": return t("cli.state.stopped", "Sync stopped")
    case "waiting": return t("cli.state.waiting", "No conversations yet")
    case "syncing": return t("cli.state.syncing", "Syncing")
    case "queued": return t("cli.state.queued", "History queued")
    case "up_to_date": return t("cli.state.upToDate", "Up to date")
    case "partial": return t("cli.state.partial", "Partial coverage")
    case "failed": return t("cli.state.failed", "Needs attention")
  }
}
const recoveryLabel = (kind: ProjectRecovery["kind"]): string | undefined => {
  switch (kind) {
    case "sources": return t("cli.recovery.sources", "No tools enabled")
    case "tool": return t("cli.recovery.tool", "Conversations not syncing")
    case "sign_in": return t("cli.recovery.signIn", "Sign-in required")
    case "sign_in_elsewhere": return t("cli.recovery.signInElsewhere", "Blocked by sign-in")
    case "resume": return t("cli.recovery.resume", "Sync stopped")
    case "automatic_retry": return t("cli.recovery.automaticRetry", "Waiting to retry")
    case "repair": return t("cli.recovery.repair", "Sync failed")
    case "partial": return t("cli.recovery.partial", "Partial coverage")
    case "none": return undefined
  }
}
const jobStateLabel = (state: "pending" | "healthy" | "partial" | "failed"): string => {
  switch (state) {
    case "pending": return t("cli.status.statePending", "pending")
    case "healthy": return t("cli.status.stateHealthy", "healthy")
    case "partial": return t("cli.status.statePartial", "partial")
    case "failed": return t("cli.status.stateFailed", "failed")
  }
}
const statusLabel = (item: ConsoleProject) => recoveryLabel(item.recovery.kind) ?? stateLabel(item.state)
const failureGuidance = (reason: NonNullable<ConsoleProject["jobs"][number]["failureReason"]>): string => {
  switch (reason) {
    case "unauthenticated": return t("cli.failure.unauthenticated", "Sign in again from this project to resume sync.")
    case "transport": return t("cli.failure.transport", "Check your network and access to the ATape instance.")
    case "adapter": return t("cli.failure.adapter", "ATape couldn't read local conversations. Check the reported file path and read permissions.")
    case "state": return t("cli.failure.state", "Check the local ATape data directory, permissions and free disk space.")
    case "contract": return t("cli.failure.contract", "ATape couldn't process the reader's output. Try updating ATape's reader; if this continues, share these details when reporting the issue.")
  }
}
const sourceFailureGuidance = (reason: AdapterSourceFailure["reason"]): string => {
  switch (reason) {
    case "io": return t("cli.sourceFailure.io", "Source data could not be read. Check its path and permissions.")
    case "format": return t("cli.sourceFailure.format", "Source data could not be parsed. Check the source and integration version.")
    case "unsupported": return t("cli.sourceFailure.unsupported", "This source format is not supported by the installed integration.")
    case "changed": return t("cli.sourceFailure.changed", "The source changed during capture. Check the source data.")
    case "limit": return t("cli.sourceFailure.limit", "This source exceeded a capture limit. Inspect the affected source.")
    case "duplicate": return t("cli.sourceFailure.duplicate", "Conflicting source identities were found. Inspect the affected source.")
    case "attribution": return t("cli.sourceFailure.attribution", "The project could not be identified safely. Check repository metadata; some historical identity may be unavailable.")
  }
}
const recoveryGuidance = (item: ConsoleProject): string => {
  switch (item.recovery.kind) {
    case "sources": return t("cli.guidance.sources", "Enable tools once for all connected projects.")
    case "tool": return item.recovery.action === "install"
      ? t("cli.guidance.toolInstall", "ATape needs to install its {tool} reader to sync these conversations.", { tool: toolLabel(item.recovery.adapterId) })
      : t("cli.guidance.toolUpdate", "ATape couldn't read {tool} conversations. Updating ATape's reader may help.", { tool: toolLabel(item.recovery.adapterId) })
    case "sign_in": return t("cli.guidance.signIn", "Sign in again to resume background sync for all enabled projects.")
    case "sign_in_elsewhere": return t("cli.guidance.signInElsewhere", "{project} needs sign-in before background sync can continue.", { project: item.recovery.project.name })
    case "resume": return t("cli.guidance.resume", "Start sync for all projects to resume. Access is checked before starting.")
    case "automatic_retry": return t("cli.guidance.automaticRetry", "Sync will retry automatically in a later background cycle. No action is needed.")
    case "repair": {
      const job = item.jobs.find(job => job.state === "failed")
      return job?.failureReason
        ? t("cli.guidance.repairReason", "{tool} conversations could not sync. {guidance}", { tool: toolLabel(job.adapterId), guidance: failureGuidance(job.failureReason) })
        : t("cli.guidance.repair", "ATape couldn't run background sync. See Sync details for the latest error.")
    }
    case "partial": return t("cli.guidance.partial", "Some conversations were skipped. Other conversations continue syncing.")
    case "none": return item.state === "waiting" ? t("cli.guidance.noneWaiting", "Use a connected source in this project. New conversations will sync automatically.") : ""
  }
}
export const safeTerminalText = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")

export class ExperiencePresenter {
  private screen: Screen = { revision: 0, kind: "busy", title: t("cli.presenter.opening", "Opening ATape"), details: [] }
  private listeners = new Set<() => void>()
  private action: (value: string | string[]) => void = () => {}
  private previous: () => void = () => this.close()
  private operation: AbortController | undefined
  private suggestions: AbortController | undefined
  private lifetime = new AbortController()
  private generation = 0
  private consoleTarget: LocalProject | "list" | undefined
  private instanceOrigin = "https://atape.net"
  private path: string
  private latest: CLIExperienceSnapshot | undefined
  private hasProjects = false
  private toolsConfigured = false
  private enabledTools: ReadonlyArray<string> = []
  private focusedProject: string | undefined
  private started = false
  focusProject = (value: string) => { this.focusedProject = value }
  refresh = () => this.refreshConsole()
  constructor(private run: ExperienceRunner, private exit: (restart?: boolean) => void, private options: {
    readonly path: string; readonly instance?: string; readonly noBrowser?: boolean
    readonly environment: NodeJS.ProcessEnv; readonly version: string
  }) { this.path = options.path }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.screen
  submit = (value: string | string[]) => this.action(value)
  back = () => {
    const previous = this.previous
    this.cancelOperation()
    previous()
  }
  close = (restart = false) => {
    if (this.lifetime.signal.aborted) return
    this.cancelOperation()
    this.lifetime.abort()
    this.exit(restart)
  }
  private publish(screen: Screen) {
    if (this.lifetime.signal.aborted) return
    this.screen = screen
    for (const listener of this.listeners) listener()
  }
  private show(screen: ScreenContent, action: (value: string | string[]) => void = () => {}, previous = () => this.list(), revision = this.screen.revision + 1) {
    this.consoleTarget = undefined
    this.action = action
    this.previous = previous
    this.publish({ ...screen, revision })
  }
  private cancelOperation() { this.generation++; this.operation?.abort(); this.suggestions?.abort() }
  private work<A, E>(title: string, effect: Effect.Effect<A, E, ExperienceRequirements>, success: (value: A) => void,
    failure?: (error: E) => void, back = this.previous) {
    this.cancelOperation()
    const generation = this.generation
    const controller = new AbortController()
    this.operation = controller
    const context = this.screen.title
    this.show({ kind: "busy", title, context, details: this.screen.details }, undefined, back)
    void this.run(effect.pipe(Effect.match({
      onFailure: error => ({ ok: false as const, error }), onSuccess: value => ({ ok: true as const, value })
    })), AbortSignal.any([controller.signal, this.lifetime.signal])).then(result => {
      if (generation !== this.generation || this.lifetime.signal.aborted) return
      this.operation = undefined
      if (result.ok) success(result.value)
      else if (failure) failure(result.error)
      else this.failed(result.error, () => this.work(title, effect, success, failure, back), back)
    }).catch(error => {
      if (!controller.signal.aborted && !this.lifetime.signal.aborted && generation === this.generation) {
        this.failed(error, () => this.work(title, effect, success, failure, back), back)
      }
    })
  }
  private failed(error: unknown, retry: () => void, back: () => void) {
    const failure = describeClientFailure(error)
    this.show({ kind: "menu", title: t("cli.presenter.recoverTitle", "Let's get this working"), details: [failure.message],
      options: failure.actions.map(action => ({ value: action.kind === "review" ? "retry" : action.kind === "sign_in" ? "login" : action.kind === "update_tool" ? "reader" : "retry",
        label: action.kind === "update_tool" ? t("cli.presenter.installLatest", "Install latest published {tool} integration and continue", { tool: toolLabel(action.adapterId) })
          : action.kind === "sign_in" ? t("cli.presenter.signInAgain", "Sign in again")
          : action.kind === "review" ? t("cli.presenter.reviewAgain", "Review again") : t("cli.presenter.retryOperation", "Retry this operation") }))
    }, value => {
      if (value === "retry") return retry()
      if (value !== "reader" && value !== "login") return
      const action = failure.actions.find(action => value === "reader" ? action.kind === "update_tool" : action.kind === "sign_in")
      if (action?.kind === "update_tool") this.work(t("cli.presenter.updatingReader", "Updating ATape's {tool} reader", { tool: toolLabel(action.adapterId) }), updateSyncReader(action.adapterId), retry, undefined, back)
      else if (action?.kind === "sign_in") { if (action.instanceOrigin) this.instanceOrigin = action.instanceOrigin; this.login(retry, back) }
    }, back)
  }
  start() {
    if (this.started) return
    this.started = true
    this.work(t("cli.presenter.checkingUpdates", "Checking for updates"), checkCLIUpgrade(this.options.version), version => {
      if (version) this.offerUpgrade(version)
      else this.openExperience()
    }, undefined, () => this.close())
  }
  private offerUpgrade(version: string, error?: unknown) {
    const recovery = error instanceof CLIUpgradeError ? error.recovery : undefined
    this.show({ kind: "menu", title: recovery ? t("cli.presenter.updatedSyncStopped", "Updated, but sync is stopped") : error ? t("cli.presenter.updateFailed", "Update could not finish") : t("cli.presenter.updateAvailable", "Update available"), exitOnBack: true,
      details: error ? [error instanceof Error ? error.message : String(error)] : [
        `ATape ${this.options.version} → ${version}`, t("cli.presenter.upgradePrompt", "Upgrade now or skip for this session.")
      ], options: [
        { value: "upgrade", label: recovery ? t("cli.presenter.resumeSyncContinue", "Resume sync and continue") : error ? t("cli.presenter.retryUpgrade", "Retry upgrade") : t("cli.presenter.upgradeContinue", "Upgrade and continue") },
        { value: "skip", label: t("cli.presenter.skip", "Skip") }
      ] }, value => {
        if (value === "skip") { if (recovery) this.close(true); else this.openExperience() }
        else if (value === "upgrade") this.work(recovery ? t("cli.presenter.resumingSync", "Resuming sync") : t("cli.presenter.upgrading", "Upgrading ATape"), recovery ? resumeCLIUpgrade(recovery) : upgradeCLI(this.options.version), result => {
          if (result.updated) this.close(true)
          else this.openExperience()
        }, error => this.offerUpgrade(version, error), () => this.close())
      }, () => this.close())
  }
  private openExperience() {
    this.work(t("cli.presenter.readingProjects", "Reading local Projects"), Effect.gen(function*(this: ExperiencePresenter) {
      const config = yield* inspectClient()
      const instanceOrigin = yield* selectInstanceOrigin({
        ...(this.options.instance ? { commandLine: this.options.instance } : {}),
        ...(this.options.environment.ATAPE_INSTANCE_URL ? { environment: this.options.environment.ATAPE_INSTANCE_URL } : {}),
        ...(config.activeInstanceOrigin ? { savedActive: config.activeInstanceOrigin } : {}),
        allowLoopbackHttp: this.developmentHTTP
      })
      return { config, instanceOrigin }
    }.bind(this)), ({ config, instanceOrigin }) => {
      this.instanceOrigin = instanceOrigin
      this.hasProjects = config.projects.length > 0
      this.toolsConfigured = config.toolsConfigured
      this.enabledTools = config.enabledAdapterIds
      if (!this.hasProjects && !this.toolsConfigured) this.welcome()
      else this.list()
    }, undefined, () => this.close())
    void this.run(Effect.gen(function*(this: ExperiencePresenter) {
      while (true) {
        yield* Effect.sleep(2_000)
        if (this.consoleTarget === undefined || this.screen.refreshing) continue
        const target = this.consoleTarget
        const generation = this.generation
        const result = yield* inspectCLIExperience().pipe(Effect.match({ onFailure: error => ({ ok: false as const, error }), onSuccess: snapshot => ({ ok: true as const, snapshot }) }))
        if (this.consoleTarget !== target || generation !== this.generation) continue
        if (result.ok) this.showConsole(result.snapshot, target, true)
        else if (this.screen.kind === "menu") this.publish({ ...this.screen, refreshError: t("cli.presenter.statusStale", "Status may be stale: {message}", { message: result.error.message }) })
      }
    }.bind(this)), this.lifetime.signal).catch(() => {})
  }
  private get developmentHTTP() { return this.options.environment.ATAPE_DEVELOPMENT_ALLOW_HTTP === "true" }
  private home = () => this.hasProjects || this.toolsConfigured ? this.list() : this.welcome()
  private connectProject() {
    if (this.toolsConfigured && this.enabledTools.length > 0) this.pathScreen()
    else this.configureTools(() => this.pathScreen(), this.home)
  }
  private welcome() {
    this.show({ kind: "menu", layout: "welcome", title: t("cli.welcome.title", "Welcome to ATape"), details: [
      t("cli.welcome.tagline", "Your conversations, together."), t("cli.welcome.subtitle", "Choose your tools once, then connect the projects you want to sync.")
    ], options: [
      { value: "connect", label: t("cli.welcome.getStarted", "Get started") },
      { value: "help", label: t("cli.welcome.howSyncing", "How syncing works") },
      { value: "instance", label: t("cli.welcome.changeInstance", "Change Instance") }
    ] }, value => {
      if (value === "connect") this.connectProject()
      else if (value === "instance") this.instanceScreen()
      else this.show({ kind: "menu", title: t("cli.welcome.howSyncing", "How syncing works"), details: [
        t("cli.welcome.step1", "1. Choose the tools you use on this machine, once for all projects."),
        t("cli.welcome.step2", "2. Connect a directory. Git repositories include their worktrees and clones."),
        t("cli.welcome.step3", "3. Sign in if needed, then review and start syncing."),
        t("cli.welcome.step4", "Sync continues after you exit. After a reboot, open ATape and select Start sync."),
        t("cli.welcome.step5", "Read conversations and manage your Team in the Web app.")
      ], options: [{ value: "connect", label: t("cli.welcome.connectProject", "Connect a project") }] },
      () => this.connectProject(), () => this.welcome())
    }, () => this.close())
  }
  private pathScreen(configureToolsAfter = false) {
    this.show({ kind: "input", title: t("cli.path.title", "Connect a Project"), initial: this.path, pathInput: true,
      details: [t("cli.path.searchHint", "Type a project name to search here, or paste its path."), t("cli.path.searchDepth", "Search includes folders up to 3 levels below the current directory.")] }, value => {
      this.path = String(value)
      if (configureToolsAfter && (!this.toolsConfigured || this.enabledTools.length === 0)) {
        this.configureTools(() => this.prepare(), () => this.pathScreen(true))
      } else this.prepare()
    }, this.home)
    this.pathChanged(this.path)
  }
  private instanceScreen(after = () => this.connectProject(), back = this.home) {
    this.show({ kind: "input", title: t("cli.instance.title", "ATape Instance"), initial: this.instanceOrigin,
      details: [t("cli.instance.hint", "Use https://atape.net or your self-hosted Instance origin.")] }, value => {
      this.work(t("cli.instance.checking", "Checking Instance"), selectInstanceOrigin({ commandLine: String(value), allowLoopbackHttp: this.developmentHTTP }), origin => {
        this.instanceOrigin = origin
        this.work(t("cli.instance.saving", "Saving server"), setActiveInstance(origin), after, undefined, back)
      }, undefined, () => this.instanceScreen(after, back))
    }, back)
  }
  pathChanged = (value: string, query?: string) => {
    this.suggestions?.abort()
    if (!this.screen.pathInput) return
    this.path = value
    this.publish({ ...this.screen, suggestions: [], directoriesLoading: true })
    const controller = new AbortController()
    this.suggestions = controller
    const revision = this.screen.revision
    void this.run(Effect.gen(function*() {
      yield* Effect.sleep(120)
      const platform = yield* CLISetupPlatform
      return yield* platform.suggestDirectories(value, query)
    }).pipe(Effect.catch(() => Effect.succeed([] as DirectorySuggestion[]))), AbortSignal.any([controller.signal, this.lifetime.signal])).then(suggestions => {
      if (!controller.signal.aborted && this.screen.kind === "input" && this.screen.revision === revision) this.publish({ ...this.screen, suggestions, directoriesLoading: false })
    }).catch(() => {})
  }
  private prepare(loginAllowed = true, reviewed?: { readonly teamId: string; readonly name?: string }) {
    this.work(t("cli.presenter.findingProject", "Finding your Project"), prepareGuidedSetup({ instanceOrigin: this.instanceOrigin, path: this.path }), plan => {
      if (reviewed && plan.project.teams.some(team => team.id === reviewed.teamId)) this.reviewProject(plan, reviewed.teamId, reviewed.name)
      else this.teamScreen(plan)
    }, error => {
      if ("reason" in error && error.reason === "no_team") this.noTeam()
      else if ("reason" in error && error.reason === "unauthenticated" && loginAllowed) this.login(() => this.prepare(false, reviewed), () => this.pathScreen())
      else this.failed(error, () => this.prepare(true, reviewed), () => this.pathScreen())
    }, () => this.pathScreen())
  }
  private login(after: () => void, back: () => void) {
    const effect = loginCLI({ instanceOrigin: this.instanceOrigin, allowLoopbackHttp: this.developmentHTTP, openBrowser: !this.options.noBrowser }).pipe(
      Effect.provideService(CLIAuthenticationInteraction, CLIAuthenticationInteraction.of({
        presentChallenge: challenge => Effect.sync(() => {
          this.publish({ revision: this.screen.revision, kind: "menu", title: t("cli.login.browserTitle", "Sign in through your browser"), details: [
            t("cli.login.instance", "Instance: {origin}", { origin: challenge.instanceOrigin }),
            t("cli.login.open", "Open: {uri}", { uri: challenge.verificationUri }),
            t("cli.login.code", "Code: {code}", { code: challenge.userCode }),
            t("cli.login.waiting", "Waiting for browser approval… Setup continues automatically after approval.")
          ], options: [{ value: "open", label: t("cli.login.openPage", "Open sign-in page") }, { value: "cancel", label: t("cli.login.cancel", "Cancel sign-in") }] })
          this.action = value => {
            if (value === "cancel") return this.back()
            const revision = this.screen.revision
            void this.run(Effect.promise(() => launchBrowser(process.platform, challenge.verificationUri)), this.lifetime.signal)
              .then(() => { if (this.screen.revision === revision) this.publish({ ...this.screen, notice: t("cli.login.pageOpened", "Sign-in page opened. Approve the code in your browser.") }) })
              .catch(() => { if (this.screen.revision === revision) this.publish({ ...this.screen, notice: t("cli.login.openLink", "Open this link in your browser: {uri}", { uri: challenge.verificationUri }) }) })
          }
        }),
        openBrowser: uri => Effect.promise(() => launchBrowser(process.platform, uri))
      })),
      Effect.tap(() => setActiveInstance(this.instanceOrigin))
    )
    this.work(t("cli.login.startingBrowser", "Starting browser sign-in"), effect, after, undefined, back)
  }
  private noTeam(url?: string) {
    this.show({ kind: "menu", title: t("cli.noTeam.title", "Create or join a Team"), details: [
      t("cli.noTeam.body", "Finish Team onboarding in the Web app, then return here and Refresh."),
      t("cli.noTeam.directoryRetained", "Directory retained: {path}", { path: this.path }), ...(url ? [url] : [])
    ], options: [{ value: "web", label: t("cli.noTeam.openWeb", "Open Web onboarding") }, { value: "refresh", label: t("cli.noTeam.refresh", "Refresh") }] }, value => {
      if (value === "refresh") this.prepare()
      else if (value === "web") this.work(t("cli.noTeam.openingWeb", "Opening Web onboarding"), this.openWeb(), url => this.noTeam(url), undefined, () => this.noTeam(url))
    }, () => this.pathScreen())
  }
  private openWeb() {
    return experienceOnboardingURL(this.instanceOrigin, this.developmentHTTP).pipe(
      Effect.tap(url => this.options.noBrowser ? Effect.void : Effect.promise(() => launchBrowser(process.platform, url)))
    )
  }
  private teamScreen(plan: GuidedSetupPlan) {
    if (!plan.config.toolsConfigured || plan.config.enabledAdapterIds.length === 0) {
      return this.configureTools(() => this.prepare(), () => this.pathScreen())
    }
    if (plan.existingDirectory) return this.detail(plan.existingDirectory)
    const decision = decideProjectSetup(plan.project)
    if (decision.kind === "ready" || decision.kind === "needs_creation_confirmation") return this.reviewProject(plan, decision.team.id)
    this.show({ kind: "menu", title: t("cli.team.title", "Choose a Team"), details: [t("cli.team.signedInAs", "Signed in as {name}", { name: plan.project.user.displayName })],
      options: plan.project.teams.map(team => ({ value: team.id, label: `${team.displayName}${plan.project.exactMatches.some(match => match.team.id === team.id) ? t("cli.team.existingProject", " · existing Project") : ""}` }))
    }, value => this.reviewProject(plan, String(value)), () => this.pathScreen())
  }
  private reviewProject(plan: GuidedSetupPlan, teamId: string, name?: string) {
    const exact = plan.project.exactMatches.find(match => match.team.id === teamId)
    const existing = plan.config.projects.find(project => project.instanceOrigin === plan.project.instanceOrigin && project.id === exact?.project.id)
    if (existing) return this.detail(existing)
    this.reviewSetup(plan, teamId, plan.config.enabledAdapterIds, name)
  }
  private showSources(title: string, choices: ReadonlyArray<SourceChoice>, selected: ReadonlyArray<string> | undefined,
    details: ReadonlyArray<string>, submit: (ids: string[]) => void, back: () => void) {
    this.show({ kind: "sources", title, details, selected: selected ?? choices.filter(choice => choice.selected).map(choice => choice.id),
      options: choices.map(choice => ({ value: choice.id, label: choice.label }))
    }, value => submit(Array.isArray(value) ? value : [value]), back)
  }
  private reviewSetup(plan: GuidedSetupPlan, teamId: string, ids: ReadonlyArray<string>, name?: string) {
    if (ids.length === 0) {
      this.configureTools(() => this.prepare(), () => this.pathScreen())
      return
    }
    const team = plan.project.teams.find(team => team.id === teamId)!
    const exact = plan.project.exactMatches.find(match => match.team.id === teamId)
    const projectName = exact?.project.name ?? plan.existingDirectory?.name ?? name ?? plan.project.local.name
    const mode = exact || plan.existingDirectory
      ? t("cli.review.connectExisting", "connect existing") : t("cli.review.createNew", "create new")
    const details = [
      t("cli.review.instance", "Instance: {origin}", { origin: plan.project.instanceOrigin }),
      t("cli.review.account", "Account: {name}", { name: plan.project.user.displayName }),
      t("cli.review.team", "Team: {name}", { name: team.displayName }),
      t("cli.review.project", "Project: {name} · {mode}", { name: projectName, mode }),
      ...(plan.project.local.type === "git"
        ? [t("cli.review.git", "Git: {identity}", { identity: exact?.project.repositoryIdentity ?? plan.project.local.repositoryRemote ?? "" }),
          t("cli.review.repositoryRoot", "Repository root: {path}", { path: plan.project.local.path })]
        : [t("cli.review.directory", "Directory: {path}", { path: plan.project.local.path })]),
      t("cli.review.tools", "Tools: {tools} · global selection", { tools: ids.map(toolLabel).join(", ") }),
      t("cli.review.import", "Import existing conversations and continuously sync future conversations."),
      t("cli.review.background", "Background sync continues after you exit.")
    ]
    this.show({ kind: "menu", title: t("cli.review.title", "Review and connect"), details, options: [
      { value: "confirm", label: t("cli.review.connectAndSync", "Connect and sync") },
      ...(!exact && !plan.existingDirectory && plan.project.local.type === "directory" ? [{ value: "name", label: t("cli.review.changeName", "Change Project name") }] : []),
      ...(!plan.existingDirectory && plan.project.teams.length > 1 ? [{ value: "team", label: t("cli.review.changeTeam", "Change Team") }] : []),
      { value: "path", label: t("cli.review.changeDirectory", "Change directory") }
    ] }, value => {
      if (value === "confirm") {
        this.work(t("cli.review.connecting", "Connecting your Project"), completeGuidedSetup({ plan, teamId, sourceIds: ids, ...(name ? { name } : {}),
          progress: title => Effect.sync(() => { this.publish({ ...this.screen, title }) })
        }).pipe(Effect.flatMap(project => observeInitialSync(project).pipe(Effect.map(snapshot => ({ project, snapshot }))))),
        ({ project, snapshot }) => this.showConsole(snapshot, project),
        error => this.failed(error, () => this.prepare(true, { teamId, ...(name ? { name } : {}) }), () => this.pathScreen()), () => this.list())
      } else if (value === "name") this.show({ kind: "input", title: t("cli.review.projectName", "Project name"), initial: projectName, details: [] }, value => this.reviewSetup(plan, teamId, ids, String(value)), () => this.reviewSetup(plan, teamId, ids, name))
      else if (value === "team") this.show({ kind: "menu", title: t("cli.team.title", "Choose a Team"), details: [], options: plan.project.teams.map(team => ({ value: team.id, label: team.displayName })) }, value => this.reviewProject(plan, String(value)), () => this.reviewSetup(plan, teamId, ids, name))
      else this.pathScreen()
    }, () => this.pathScreen())
  }
  private refreshConsole() {
    const target = this.consoleTarget
    if (target === undefined || this.screen.kind !== "menu" || this.screen.refreshing) return
    this.cancelOperation()
    const generation = this.generation
    const controller = new AbortController()
    this.operation = controller
    this.publish({ ...this.screen, refreshing: true })
    const failed = (error: unknown) => {
      if (generation !== this.generation || this.lifetime.signal.aborted || this.consoleTarget !== target || this.screen.kind !== "menu") return
      this.operation = undefined
      this.publish({ ...this.screen, refreshing: false, refreshError: t("cli.presenter.statusStale", "Status may be stale: {message}", { message: error instanceof Error ? error.message : String(error) }) })
    }
    void this.run(inspectCLIExperience().pipe(Effect.match({
      onSuccess: snapshot => ({ ok: true as const, snapshot }),
      onFailure: error => ({ ok: false as const, error })
    })), AbortSignal.any([controller.signal, this.lifetime.signal])).then(result => {
      if (generation !== this.generation || this.lifetime.signal.aborted || this.consoleTarget !== target || this.screen.kind !== "menu") return
      this.operation = undefined
      if (result.ok) this.showConsole(result.snapshot, target, true, t("cli.presenter.statusUpdated", "Status updated. Sync timing is unchanged."))
      else failed(result.error)
    }).catch(failed)
  }
  private list() { this.work(t("cli.presenter.refreshingProjects", "Refreshing Projects"), inspectCLIExperience(), snapshot => this.showConsole(snapshot, "list"), undefined, () => this.close()) }
  private detail(project: LocalProject) { this.work(t("cli.presenter.refreshingProject", "Refreshing Project"), inspectCLIExperience(), snapshot => this.showConsole(snapshot, project), undefined, () => this.list()) }
  private showConsole(snapshot: CLIExperienceSnapshot, target: LocalProject | "list", refresh = false, notice?: string) {
    this.latest = snapshot
    this.hasProjects = snapshot.projects.length > 0
    this.toolsConfigured = snapshot.toolsConfigured
    this.enabledTools = snapshot.enabledTools
    if (!this.hasProjects && !this.toolsConfigured) return this.welcome()
    const selected = target === "list" ? undefined : snapshot.projects.find(item => item.project.id === target.id && item.project.instanceOrigin === target.instanceOrigin)
    if (selected && refresh && this.screen.diagnostics) return this.diagnostics(selected, true, notice ?? this.screen.notice)
    const revision = this.screen.revision
    const options = selected ? this.projectOptions(selected) : snapshot.projects.map(item => ({
      value: `project:${item.project.instanceOrigin}:${item.project.id}`,
      label: `${item.project.name} · ${statusLabel(item)} · ${item.project.teamName}`
    }))
    const actions = [
      { value: "tools", label: t("cli.console.toolsAndUpdates", "Tools and updates") }, { value: "settings", label: t("cli.console.settings", "Settings") },
      ...(!snapshot.collector.running && snapshot.projects.some(item => item.project.adapterIds.length > 0) ? [{ value: "start", label: t("cli.console.startSync", "Start sync") }] : [])
    ]
    const sync = snapshot.collector.running ? t("cli.console.syncing", "Syncing") : t("cli.console.syncStopped", "Sync stopped")
    const enabledTools = snapshot.enabledTools.map(toolLabel).join(" + ") || t("cli.console.noneEnabled", "None enabled")
    this.show({ kind: "menu", refreshable: true, title: selected ? selected.project.name : t("cli.console.yourProjects", "Your Projects"),
      ...(!selected ? { layout: "projects" as const, actions, projects: snapshot.projects.map(item => ({
        value: `project:${item.project.instanceOrigin}:${item.project.id}`, name: item.project.name,
        status: statusLabel(item), team: item.project.teamName
      })), ...(this.focusedProject ? { focusedProject: this.focusedProject } : {}) } : {}),
      ...((notice ?? (refresh ? this.screen.notice : undefined)) ? { notice: notice ?? this.screen.notice! } : {}),
      details: selected ? this.projectDetails(selected) : [
        t("cli.console.summary", "{sync} · {projects} projects · {attention} need attention", {
          sync, projects: snapshot.projects.length, attention: snapshot.needsAttention
        }),
        snapshot.toolsConfigured
          ? t("cli.console.tools", "Tools: {tools}", { tools: enabledTools })
          : t("cli.console.chooseTools", "Choose which tools' conversations to sync."),
        ...(snapshot.collector.collectorFailure ? [snapshot.collector.collectorFailure.message] : [])
      ], options }, value => this.consoleAction(String(value), selected), selected ? () => this.list() : () => this.close(), refresh ? revision : undefined)
    this.consoleTarget = selected?.project ?? "list"
  }
  private projectOptions(item: ConsoleProject) {
    const primary = item.recovery.kind === "sources" ? { value: "tools", label: t("cli.project.chooseTools", "Choose tools to sync") }
      : item.recovery.kind === "tool" ? { value: "tool", label: item.recovery.action === "install"
        ? t("cli.project.setUpSync", "Set up conversation sync") : t("cli.project.checkToolUpdates", "Check for tool updates") }
      : item.recovery.kind === "sign_in" ? { value: "login", label: t("cli.project.signInResume", "Sign in again and resume") }
      : item.recovery.kind === "sign_in_elsewhere" ? { value: "unblock", label: t("cli.project.signInForProject", "Sign in for {project} and resume", { project: item.recovery.project.name }) }
      : item.recovery.kind === "resume" ? { value: "start", label: t("cli.project.startAll", "Start sync for all projects") }
      : item.recovery.kind === "partial" ? { value: "diagnostics", label: t("cli.project.reviewSkipped", "Review skipped conversations") }
      : item.recovery.kind === "repair" ? { value: "diagnostics", label: t("cli.project.viewIssue", "View sync issue") }
      : item.recovery.kind === "automatic_retry" ? { value: "diagnostics", label: t("cli.project.viewRetry", "View retry details") }
      : { value: "diagnostics", label: t("cli.project.syncDetails", "Sync details") }
    return [
      primary,
      ...(item.recovery.kind === "tool" && !this.latest?.collector.running ? [{ value: "start", label: t("cli.project.startAll", "Start sync for all projects") }] : []),
      ...(primary.value !== "diagnostics" ? [{ value: "diagnostics", label: t("cli.project.syncDetails", "Sync details") }] : []),
      { value: "remove", label: t("cli.project.disconnect", "Disconnect project") }
    ]
  }
  private projectDetails(item: ConsoleProject) { return [
    statusLabel(item),
    ...(recoveryGuidance(item) ? [recoveryGuidance(item)] : []),
    ...(item.recovery.kind === "automatic_retry" || item.recovery.kind === "repair" ? [t("cli.project.refreshHint", "Refresh status only updates this page.")] : []),
    `${item.project.teamName} · ${item.project.instanceOrigin}`,
    item.project.type === "git"
      ? t("cli.review.git", "Git: {identity}", { identity: item.project.repositoryIdentity ?? item.project.repositoryRemote ?? item.project.name })
      : t("cli.review.directory", "Directory: {path}", { path: item.project.path }),
    ...item.project.adapterIds.map(id => {
      const job = item.jobs.find(job => job.adapterId === id)
      const state = job?.state === "failed" ? t("cli.state.failed", "Needs attention")
        : job?.state === "partial" ? t("cli.project.someSkipped", "Some conversations skipped")
        : job?.hasMore ? t("cli.project.syncingHistory", "Syncing history")
        : item.state === "waiting" ? t("cli.state.waiting", "No conversations yet")
        : job?.lastSuccessAt ? t("cli.project.lastSynced", "Last synced {time}", { time: job.lastSuccessAt })
        : t("cli.project.waitingForSync", "Waiting for sync")
      return `${toolLabel(id)}: ${state}`
    })
  ] }
  private diagnostics(item: ConsoleProject, refresh = false, notice?: string) {
    const back = () => this.detail(item.project)
    const running = Boolean(this.latest?.collector.running)
    this.show({ kind: "menu", diagnostics: true, refreshable: true, title: t("cli.project.syncDetails", "Sync details"), ...(notice ? { notice } : {}), details: [
      item.project.name, recoveryGuidance(item),
      ...(this.latest?.collector.collectorFailure ? [this.latest.collector.collectorFailure.message] : []),
      ...item.jobs.flatMap(job => [
        `${toolLabel(job.adapterId)}: ${jobStateLabel(job.state)}`,
        ...(job.failureMessage ? [job.failureMessage] : []),
        ...(job.failureReason ? [failureGuidance(job.failureReason)] : []),
        ...(job.lastSuccessAt ? [t("cli.diagnostics.lastCompleted", "Last completed: {time}", { time: job.lastSuccessAt })] : []),
        ...(job.sourceFailures?.flatMap(failure => [`${failure.source}`, sourceFailureGuidance(failure.reason)]) ?? []),
        ...(job.sourceFailuresTruncated ? [t("cli.diagnostics.moreSkipped", "This sync report contains only a sample of skipped sources. Later cycles may report additional sources.")] : [])
      ]), t("cli.diagnostics.refreshHint", "Refresh status only updates the page; it does not restart sync.")
    ], options: [
      ...(item.recovery.kind === "sign_in" ? [{ value: "login", label: t("cli.project.signInResume", "Sign in again and resume") }] : []),
      ...(item.recovery.kind === "sign_in_elsewhere" ? [{ value: "unblock", label: t("cli.project.signInForProject", "Sign in for {project} and resume", { project: item.recovery.project.name }) }] : []),
      ...(!running && item.recovery.kind !== "sign_in" && item.recovery.kind !== "sign_in_elsewhere" ? [{ value: "start", label: t("cli.project.startAll", "Start sync for all projects") }] : []),
      ...(item.recovery.kind === "tool" ? [this.projectOptions(item)[0]!] : [])
    ] }, value => {
      if (value === "refresh") this.refreshConsole()
      else this.consoleAction(String(value), item)
    }, back, refresh ? this.screen.revision : undefined)
    this.consoleTarget = item.project
  }
  private consoleAction(value: string, item?: ConsoleProject) {
    const back = () => item ? this.detail(item.project) : this.list()
    if (value.startsWith("project:")) {
      const selected = this.latest?.projects.find(item => `project:${item.project.instanceOrigin}:${item.project.id}` === value)
      if (selected) { this.focusedProject = value; this.detail(selected.project) }
    } else if (value === "add") this.pathScreen(true)
    else if (value === "exit") this.close()
    else if (value === "refresh") this.refreshConsole()
    else if (value === "start") this.work(t("cli.console.startingSync", "Starting background sync"), startExperienceCollector(), back, undefined, back)
    else if (value === "stop") this.confirm(t("cli.console.stopSyncTitle", "Stop background sync?"), [t("cli.console.stopSyncDetail", "This stops future collection for ALL local Projects. Captured history is retained.")], t("cli.console.stopAll", "Stop all sync"), () => this.work(t("cli.console.stoppingSync", "Stopping background sync"), stopExperienceCollector(), () => this.list(), undefined, back), back)
    else if (value === "settings") this.settings()
    else if (value === "tools") item ? this.configureTools(back, back) : this.tools(back)
    else if (item && value === "tool" && item.recovery.kind === "tool") {
      const { adapterId, action } = item.recovery
      if (action === "update") return this.tools(back, true)
      this.work(action === "install"
        ? t("cli.console.installingReader", "Installing ATape's {tool} reader", { tool: toolLabel(adapterId) })
        : t("cli.console.updatingReader", "Updating ATape's {tool} reader", { tool: toolLabel(adapterId) }),
        updateSyncReader(adapterId, item.project).pipe(Effect.andThen(inspectCLIExperience())),
        snapshot => this.showConsole(snapshot, item.project, false,
          t("cli.console.readerInstalled", "ATape reader installed. Background sync will use it on its next attempt. The last sync result is shown below.")), undefined, back)
    }
    else if (item && value === "diagnostics") this.diagnostics(item)
    else if (item && value === "unblock" && item.recovery.kind === "sign_in_elsewhere") {
      this.instanceOrigin = item.recovery.project.instanceOrigin
      this.login(() => this.work(t("cli.console.checkingAccount", "Checking account and resuming"), startExperienceCollector(), back, undefined, back), back)
    }
    else if (item && value === "login") {
      this.instanceOrigin = item.project.instanceOrigin
      this.login(() => this.work(t("cli.console.checkingAccount", "Checking account and resuming"), startExperienceCollector(), back, undefined, back), back)
    } else if (item && value === "remove") this.confirm(t("cli.console.disconnectTitle", "Disconnect project?"), [
      `${item.project.name} · ${item.project.instanceOrigin}`,
      t("cli.console.disconnectFuture", "Future cycles will stop collecting this Project. An in-flight upload may finish."),
      t("cli.console.disconnectRetained", "Server conversations and history will be retained.")
    ], t("cli.project.disconnect", "Disconnect project"), () => this.work(t("cli.console.disconnecting", "Disconnecting project"), removeExperienceProject(item.project), () => this.list(), undefined, back), back)
  }
  private tools(back = () => this.list(), refresh = false, notice?: string) {
    this.work(t("cli.tools.checkingVersions", "Checking tool versions"), inspectToolUpdates(this.options.version, refresh), releases => {
      const updateable = releases.filter(release => release.status === "available" ||
        release.source === "local" && release.status === "current")
      const releaseName = (release: ToolRelease) => release.id === "cli"
        ? release.label : t("cli.tools.releaseSyncName", "{label} sync", { label: release.label })
      this.show({ kind: "menu", title: t("cli.console.toolsAndUpdates", "Tools and updates"), ...(notice ? { notice } : {}), details: [
        t("cli.tools.intro", "Manage ATape and its conversation sync integrations."),
        ...releases.map(release => {
          const older = release.status === "ahead" ? t("cli.tools.releaseOlder", " (older)") : ""
          const latest = release.latest
            ? release.status === "available"
              ? t("cli.tools.releaseLatest", " → {version} (latest)", { version: release.latest })
              : t("cli.tools.releaseLatestOlder", " · latest {version}{older}", { version: release.latest, older })
            : release.status === "unavailable" ? t("cli.tools.releaseUnavailable", " · latest unavailable")
              : release.status === "development" ? t("cli.tools.releaseDevelopment", " · development build")
              : t("cli.tools.releaseManual", " · manual update")
          const flags = `${
            release.id === "cli" ? "" : release.enabled ? t("cli.tools.releaseEnabled", " · enabled") : t("cli.tools.releaseDisabled", " · disabled")}${
            release.source === "local" ? t("cli.tools.releaseLocal", " · file/URL install") : release.source === "custom" ? t("cli.tools.releaseCustom", " · custom package") : ""}`
          return `${releaseName(release)}: ${release.version}${latest}${flags}`
        }),
        t("cli.tools.cacheNotice", "Latest versions are cached for 12 hours.")
      ], options: [
        ...updateable.map(release => ({ value: `update:${release.id}`, label: release.source === "local"
          ? t("cli.tools.usePublished", "Use published {label} integration {version}", { label: release.label, version: release.latest ?? "" })
          : t("cli.tools.updateRelease", "Update {name} to {version}", { name: releaseName(release), version: release.latest ?? "" }) })),
        { value: "configure", label: t("cli.tools.chooseTools", "Choose tools to sync") },
        { value: "check", label: t("cli.tools.checkAgain", "Check again") },
        { value: "maintenance", label: t("cli.tools.maintenance", "Integration maintenance") }
      ] }, value => {
        if (value === "configure") this.configureTools(() => this.tools(back), () => this.tools(back))
        else if (value === "check") this.tools(back, true)
        else if (value === "maintenance") this.maintenance(() => this.tools(back))
        else {
          const release = updateable.find(release => `update:${release.id}` === value)
          if (release) this.updateRelease(release, back)
        }
      }, back)
    }, undefined, back)
  }
  private maintenance(back: () => void, notice?: string) {
    this.work(t("cli.tools.reading", "Reading tools"), inspectClient(), config => this.show({
      kind: "menu", title: t("cli.tools.maintenance", "Integration maintenance"), ...(notice ? { notice } : {}),
      details: [t("cli.maintenance.intro", "Install trusted packages, refresh their original source, or clean up old versions. Installation does not enable conversation capture."),
        ...config.adapters.map(adapter => `${adapter.displayName} ${adapter.version} · ${adapter.upgradeSpec}`)],
      options: [
        { value: "install", label: t("cli.maintenance.install", "Install from a package or path") },
        { value: "prune", label: t("cli.maintenance.prune", "Clean up old integration versions") },
        ...config.adapters.map(adapter => ({ value: `refresh:${adapter.adapterId}`,
          label: t("cli.maintenance.refresh", "Refresh {tool} from its original source", { tool: adapter.displayName }) }))
      ]
    }, value => {
      const again = () => this.maintenance(back)
      if (value === "install") this.installPackage(back)
      else if (value === "prune") this.prunePackages(back)
      else {
        const adapter = config.adapters.find(adapter => value === `refresh:${adapter.adapterId}`)
        if (adapter) this.confirm(t("cli.maintenance.refreshTitle", "Refresh integration?"), [adapter.displayName, adapter.upgradeSpec,
          t("cli.maintenance.preserve", "Tool selection, connected projects and sync progress will be retained. Stopped sync stays stopped.")],
          t("cli.maintenance.refreshAction", "Refresh integration"), () => this.work(t("cli.maintenance.working", "Updating integration"), upgradeAdapters(adapter.adapterId),
            () => this.maintenance(back, t("cli.maintenance.updated", "Integration updated. Running sync will use it on its next attempt.")), undefined, again), again)
      }
    }, back), undefined, back)
  }
  private installPackage(back: () => void, initial = "") {
    const again = () => this.maintenance(back)
    this.show({ kind: "input", title: t("cli.maintenance.install", "Install from a package or path"), initial,
      details: [t("cli.maintenance.source", "Enter an npm package, local directory, tarball path or HTTPS URL. Only install packages you trust.")]
    }, value => {
      const spec = String(value).trim()
      if (!spec) return this.installPackage(back)
      this.confirm(t("cli.maintenance.installTitle", "Install integration?"), [spec,
        t("cli.maintenance.inert", "After installation, use Choose tools to sync to enable capture. Existing tool selection and sync progress are retained.")],
        t("cli.maintenance.installAction", "Install integration"), () => this.work(t("cli.maintenance.installing", "Installing integration"), installAdapter(spec),
          () => this.maintenance(back, t("cli.maintenance.installed", "Integration installed. Choose tools to sync controls capture.")),
          error => this.failed(error, () => this.installPackage(back, spec), () => this.installPackage(back, spec)), () => this.installPackage(back, spec)),
        () => this.installPackage(back, spec))
    }, again)
  }
  private prunePackages(back: () => void) {
    const again = () => this.maintenance(back)
    this.work(t("cli.maintenance.inspecting", "Inspecting old versions"), pruneAdapterPackages(), report => {
      const details = [t("cli.maintenance.retention", "Keep one inactive version per package. Current versions, versions in use and untracked installations are protected. Stop older ATape processes before cleanup."),
        ...report.slots.map(slot => `${slot.packageName ?? slot.slot} ${slot.version ?? ""} · ${t(`cli.maintenance.slot.${slot.state}`)}`),
        ...(report.more ? [t("cli.maintenance.more", "More versions remain. Review cleanup again after this pass.")] : [])]
      if (!report.slots.some(slot => slot.state === "eligible")) return this.show({ kind: "menu", title: t("cli.maintenance.prune", "Clean up old integration versions"),
        details: [t("cli.maintenance.none", "No old versions are eligible for cleanup."), ...details], options: [] }, () => {}, again)
      this.confirm(t("cli.maintenance.pruneTitle", "Remove unused integration versions?"), details,
        t("cli.maintenance.remove", "Remove unused versions"), () => this.work(t("cli.maintenance.removing", "Removing unused versions"), pruneAdapterPackages({ apply: true }),
          result => this.maintenance(back, t("cli.maintenance.removed", "Removed {count} unused versions. Current installations and sync progress are retained.", { count: result.removed })), undefined, again), again)
    }, undefined, again)
  }
  private updateRelease(release: ToolRelease, back: () => void, error?: unknown) {
    const recovery = error instanceof CLIUpgradeError ? error.recovery : undefined
    const stale = typeof error === "object" && error !== null && "reason" in error && error.reason === "conflict"
    if (error) {
      this.show({ kind: "menu", title: recovery ? t("cli.presenter.updatedSyncStopped", "Updated, but sync is stopped") : t("cli.presenter.updateFailed", "Update could not finish"),
        details: [error instanceof Error ? error.message : String(error)], options: [
          { value: stale ? "check" : "retry", label: stale ? t("cli.presenter.checkVersionsAgain", "Check versions again") : recovery ? t("cli.presenter.resumeSyncContinue", "Resume sync and continue") : t("cli.presenter.retryUpdate", "Retry update") },
          ...(recovery ? [{ value: "continue", label: t("cli.presenter.continueStopped", "Continue with sync stopped") }] : [])
        ] }, value => {
          if (value === "continue" && recovery) this.close(true)
          else if (value === "check") this.tools(back, true)
        else if (value === "maintenance") this.maintenance(() => this.tools(back))
          else if (value === "retry") this.applyRelease(release, back, recovery)
        }, recovery ? () => this.close(true) : () => this.tools(back))
    } else this.applyRelease(release, back)
  }
  private applyRelease(release: ToolRelease, back: () => void, recovery?: CLIUpgradeError["recovery"]) {
    if (release.id === "cli") this.work(recovery ? t("cli.presenter.resumingSync", "Resuming sync") : t("cli.presenter.updating", "Updating ATape"),
      recovery ? resumeCLIUpgrade(recovery) : upgradeCLI(this.options.version), result => {
        if (result.updated) this.close(true)
        else this.tools(back)
      }, error => this.updateRelease(release, back, error), () => this.tools(back))
    else this.work(t("cli.presenter.updatingIntegration", "Updating {label} integration", { label: release.label }), updateToolRelease(release), () => this.tools(back, false,
      t("cli.presenter.integrationUpdated", "{label} integration updated. Running sync will use it on its next attempt.", { label: release.label })),
      error => this.updateRelease(release, back, error), () => this.tools(back))
  }
  private configureTools(after: () => void, back: () => void, selected?: ReadonlyArray<string>) {
    this.work(t("cli.tools.reading", "Reading tools"), inspectTools(), inspection => this.showSources(t("cli.tools.whichConversations", "Which conversations should ATape sync?"), inspection.choices, selected, [
      t("cli.tools.selectionApplies", "This selection applies to all connected projects on this machine."),
      t("cli.tools.selectionSetup", "ATape will set up the selected tools when you save."),
    ], ids => this.work(t("cli.tools.reviewingChanges", "Reviewing tool changes"), planToolChange(ids), plan => {
      const apply = () => this.work(t("cli.tools.settingUp", "Setting up tools"), applyToolChange(plan), () => {
        this.toolsConfigured = true; this.enabledTools = plan.ids
        if (!this.hasProjects && plan.ids.length === 0) this.list()
        else after()
      }, error => {
        if ("reason" in error && error.reason === "changed" && !("instanceOrigin" in error && error.instanceOrigin)) {
          this.show({ kind: "menu", title: t("cli.tools.reviewAgainTitle", "Review tool changes again"), details: [error.message],
            options: [{ value: "review", label: t("cli.tools.reviewChanges", "Review changes") }]
          }, () => this.configureTools(after, back, ids), () => this.configureTools(after, back, ids))
        } else this.failed(error, () => this.configureTools(after, back, ids), () => this.configureTools(after, back, ids))
      }, () => this.configureTools(after, back, ids))
      if (plan.projects.length === 0 || plan.projects.every(change => change.added.length === 0 && change.removed.length === 0)) return apply()
      const tools = ids.map(toolLabel).join(", ") || t("cli.tools.noneSelected", "None")
      this.confirm(t("cli.tools.applyTitle", "Apply tools to all projects?"), [
        t("cli.tools.applySummary", "Tools: {tools} · {projects} connected projects", { tools, projects: plan.projects.length }),
        ...plan.projects.map(change => `${change.project.name} · ${change.project.teamName} · ${change.project.instanceOrigin}: ${[
          ...change.added.map(id => `+ ${toolLabel(id)}`), ...change.removed.map(id => `− ${toolLabel(id)}`)
        ].join(", ") || t("cli.tools.unchanged", "unchanged")}`),
        t("cli.tools.applyImport", "Added tools import existing history and keep syncing. Disabled tools retain captured history."),
        t("cli.tools.applyTiming", "Changes apply to later cycles; an in-flight upload may finish."),
      ], t("cli.tools.applyAll", "Apply to all projects"), apply, () => this.configureTools(after, back, ids))
    }, undefined, () => this.configureTools(after, back, ids)), back), undefined, back)
  }
  private settings() {
    this.work(t("cli.settings.reading", "Reading settings"), inspectCLIExperience(), snapshot => this.show({ kind: "menu", title: t("cli.console.settings", "Settings"),
      details: [t("cli.settings.server", "Server: {origin}", { origin: this.instanceOrigin }),
        snapshot.collector.running ? t("cli.settings.syncRunning", "Background sync is running. Exiting keeps it running.") : t("cli.settings.syncStopped", "Background sync is stopped.")],
      options: [{ value: "accounts", label: t("cli.settings.accounts", "Accounts") },
        { value: "language", label: t("cli.settings.language", "Language") }, { value: "server", label: t("cli.settings.changeServer", "Change server") },
        { value: snapshot.collector.running ? "stop" : "start", label: snapshot.collector.running
          ? t("cli.settings.stopAll", "Stop sync for all projects") : t("cli.console.startSync", "Start sync") }]
    }, value => value === "accounts" ? this.accounts() : value === "language" ? this.language() : value === "server" ? this.instanceScreen(() => this.settings(), () => this.settings())
      : this.consoleAction(String(value)), () => this.list()))
  }
  private language() {
    this.show({ kind: "menu", title: t("cli.settings.language", "Language"),
      details: [t("cli.settings.languageHint", "Choose the language for future ATape sessions. A launch flag or ATAPE_LANG takes precedence.")],
      options: [{ value: "en", label: "English" }, { value: "zh-CN", label: "简体中文" }]
    }, value => {
      if (typeof value !== "string" || !isLocale(value)) return
      this.work(t("cli.settings.savingLanguage", "Saving language"), setClientLocale(value),
        () => this.show({ kind: "menu", title: t("cli.settings.language", "Language"),
          details: [t("cli.settings.languageSaved", "Language saved. Reopen ATape to use it.")], options: [] }, () => {}, () => this.settings()),
        undefined, () => this.language())
    }, () => this.settings())
  }
  private accounts() {
    this.work(t("cli.accounts.reading", "Reading accounts"), inspectClient(), config => {
      const instances = [...new Set([this.instanceOrigin, ...config.projects.map(project => project.instanceOrigin)])]
      this.show({ kind: "menu", title: t("cli.settings.accounts", "Accounts"), details: [t("cli.accounts.shared", "Sign-in is shared by projects on the same server.")],
        options: instances.map(origin => ({ value: origin, label: origin }))
      }, value => {
        const origin = String(value)
        this.show({ kind: "menu", title: t("cli.accounts.account", "Account"), details: [origin], options: [
          { value: "login", label: t("cli.accounts.signIn", "Sign in") }, { value: "logout", label: t("cli.accounts.signOut", "Sign out") }
        ] }, action => {
          this.instanceOrigin = origin
          if (action === "login") this.login(() => this.accounts(), () => this.accounts())
          else this.confirm(t("cli.accounts.signOutTitle", "Sign out?"), [origin, t("cli.accounts.signOutDetail", "Projects on this server will need sign-in before syncing.")], t("cli.accounts.signOut", "Sign out"),
            () => this.work(t("cli.accounts.signingOut", "Signing out"), logoutCLI({ instanceOrigin: origin }), () => this.accounts(), undefined, () => this.accounts()), () => this.accounts())
        }, () => this.accounts())
      }, () => this.settings())
    }, undefined, () => this.settings())
  }
  private confirm(title: string, details: ReadonlyArray<string>, label: string, apply: () => void, back: () => void) {
    this.show({ kind: "menu", title, details, options: [{ value: "back", label: t("cli.common.cancel", "Cancel") }, { value: "confirm", label }] }, value => value === "confirm" ? apply() : back(), back)
  }
}
