import {
  CLIAuthenticationInteraction, CLISetupPlatform, changeProjectSources, completeGuidedSetup,
  experienceWebURL, guidedSourceChoices, inspectCLIExperience, inspectClient, inspectProjectSources,
  loginCLI, observeInitialSync, prepareGuidedSetup, removeExperienceProject, selectInstanceOrigin,
  setActiveInstance, startExperienceCollector, stopExperienceCollector,
  type CLIExperienceSnapshot, type ConsoleProject, type DirectorySuggestion, type GuidedSetupPlan, type SourceChoice, type ProjectRecovery
} from "@atape/application"
import type { LocalProject } from "@atape/domain"
import { Effect, type Layer } from "effect"
import { launchBrowser } from "../runtime/authenticationLayers.ts"
import type { makeNodeClientLayer } from "../runtime/clientLayers.ts"

export type ExperienceRequirements = Layer.Success<ReturnType<typeof makeNodeClientLayer>>
export type ExperienceRunner = <A, E>(effect: Effect.Effect<A, E, ExperienceRequirements>, signal: AbortSignal) => Promise<A>
export type Screen = {
  readonly revision: number
  readonly kind: "busy" | "input" | "menu" | "sources"
  readonly title: string
  readonly details: ReadonlyArray<string>
  readonly options?: ReadonlyArray<{ value: string; label: string }>
  readonly initial?: string
  readonly selected?: ReadonlyArray<string>
  readonly suggestions?: ReadonlyArray<DirectorySuggestion>
  readonly directoriesLoading?: boolean
  readonly pathInput?: boolean
  readonly refreshing?: boolean
  readonly refreshError?: string
  readonly layout?: "welcome" | "projects"
  readonly actions?: ReadonlyArray<{ value: string; label: string }>
  readonly projects?: ReadonlyArray<{ value: string; name: string; sources: string; status: string; team: string }>
  readonly focusedProject?: string
  readonly notice?: string
  readonly context?: string
  readonly diagnostics?: boolean
}
const stateLabels = {
  no_sources: "No sources enabled", stopped: "Sync stopped", waiting: "Waiting for a first conversation",
  syncing: "Syncing", queued: "History queued", up_to_date: "Up to date",
  partial: "Partial coverage", failed: "Needs attention"
} as const
const recoveryLabels: Record<ProjectRecovery["kind"], string | undefined> = {
  sources: "No sources enabled", sign_in: "Sign-in required", sign_in_elsewhere: "Blocked by sign-in",
  resume: "Sync stopped", automatic_retry: "Waiting to retry", repair: "Needs a fix", partial: "Partial coverage", none: undefined
}
const statusLabel = (item: ConsoleProject) => recoveryLabels[item.recovery.kind] ?? stateLabels[item.state]
const recoveryGuidance = (item: ConsoleProject, running: boolean): string => {
  switch (item.recovery.kind) {
    case "sources": return "Choose which conversation sources to sync."
    case "sign_in": return "Sign in again to resume background sync for all enabled projects."
    case "sign_in_elsewhere": return `${item.recovery.project.name} needs sign-in before background sync can continue.`
    case "resume": return "Start sync for all projects to resume. Access is checked before starting."
    case "automatic_retry": return "Sync will retry automatically in a later background cycle. No action is needed."
    case "repair": return running ? "Review the issue below. Background checks continue, but it may need a fix." : "Review the issue below, then start sync for all projects."
    case "partial": return "Some conversations were skipped. Other conversations continue syncing."
    case "none": return item.state === "waiting" ? "Use a connected source in this project. New conversations will sync automatically." : ""
  }
}
const failureGuidance = {
  unauthenticated: "Sign in again from this project to resume sync.",
  transport: "Check your network and access to the ATape instance.",
  adapter: "Check that the source data is available and its integration is compatible.",
  state: "Check the local ATape data directory, permissions and free disk space.",
  contract: "Check integration compatibility; update the affected adapter if needed."
} as const
const sourceFailureGuidance = {
  io: "Source data could not be read. Check its path and permissions.",
  format: "Source data could not be parsed. Check the source and integration version.",
  unsupported: "This source format is not supported by the installed integration.",
  changed: "The source changed during capture. Check the source data.",
  limit: "This source exceeded a capture limit. Inspect the affected source.",
  duplicate: "Conflicting source identities were found. Inspect the affected source.",
  attribution: "The project could not be identified safely. Check repository metadata; some historical identity may be unavailable."
} as const
export const safeTerminalText = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")

export class ExperiencePresenter {
  private screen: Screen = { revision: 0, kind: "busy", title: "Opening ATape", details: [] }
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
  private focusedProject: string | undefined
  focusProject = (value: string) => { this.focusedProject = value }
  constructor(private run: ExperienceRunner, private exit: () => void, private options: {
    readonly path: string; readonly setup: boolean; readonly instance?: string; readonly noBrowser?: boolean
    readonly environment: NodeJS.ProcessEnv
  }) { this.path = options.path }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.screen
  submit = (value: string | string[]) => this.action(value)
  back = () => {
    const previous = this.previous
    this.cancelOperation()
    previous()
  }
  close = () => {
    if (this.lifetime.signal.aborted) return
    this.cancelOperation()
    this.lifetime.abort()
    this.exit()
  }
  private publish(screen: Screen) {
    if (this.lifetime.signal.aborted) return
    this.screen = screen
    for (const listener of this.listeners) listener()
  }
  private show(screen: Omit<Screen, "revision">, action: (value: string | string[]) => void = () => {}, previous = () => this.list(), revision = this.screen.revision + 1) {
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
    const reason = typeof error === "object" && error !== null && "reason" in error ? error.reason : undefined
    const instance = typeof error === "object" && error !== null && "instanceOrigin" in error && typeof error.instanceOrigin === "string" ? error.instanceOrigin : undefined
    this.show({ kind: "menu", title: "Let's get this working", details: [error instanceof Error ? error.message : String(error)],
      options: [
        ...(reason === "unauthenticated" || reason === "changed" ? [{ value: "login", label: "Sign in again" }] : []),
        { value: "retry", label: "Retry this operation" },
        { value: "back", label: "Back" }
      ] }, value => {
        if (value === "retry") retry()
        else if (value === "login") { if (instance) this.instanceOrigin = instance; this.login(retry, back) }
        else back()
      }, back)
  }
  start() {
    this.work("Reading local Projects", Effect.gen(function*(this: ExperiencePresenter) {
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
      if (this.options.setup) this.pathScreen()
      else if (!this.hasProjects) this.welcome()
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
        else this.publish({ ...this.screen, refreshError: `Status may be stale: ${result.error.message}` })
      }
    }.bind(this)), this.lifetime.signal).catch(() => {})
  }
  private get developmentHTTP() { return this.options.environment.ATAPE_DEVELOPMENT_ALLOW_HTTP === "true" }
  private home = () => this.hasProjects ? this.list() : this.welcome()
  private welcome() {
    this.show({ kind: "menu", layout: "welcome", title: "Welcome to ATape", details: [
      "Your conversations, together.", "Connect a project, choose your sources, and keep your history in sync."
    ], options: [
      { value: "connect", label: "Connect your first project" },
      { value: "help", label: "How syncing works" },
      { value: "instance", label: "Change Instance" }
    ] }, value => {
      if (value === "connect") this.pathScreen()
      else if (value === "instance") this.instanceScreen()
      else this.show({ kind: "menu", title: "How syncing works", details: [
        "1. Choose a directory. Git subdirectories resolve to their repository root.",
        "2. Sign in and choose which conversation sources to connect.",
        "3. Review before importing history and starting background sync.",
        "Sync continues after you exit. After a reboot, run atape start.",
        "Read conversations and manage your Team in the Web app."
      ], options: [{ value: "connect", label: "Connect a project" }, { value: "back", label: "Back" }] },
      value => value === "connect" ? this.pathScreen() : this.welcome(), () => this.welcome())
    }, () => this.close())
  }
  private pathScreen() {
    this.show({ kind: "input", title: "Connect a Project", initial: this.path, pathInput: true,
      details: [`Instance: ${this.instanceOrigin}`, "Browse or paste a directory. Git subdirectories resolve to the repository root."] }, value => {
      this.path = String(value)
      this.prepare()
    }, this.home)
    this.pathChanged(this.path)
  }
  private setupOptions() {
    this.show({ kind: "menu", title: "Project setup", details: [`Directory: ${this.path}`, `Instance: ${this.instanceOrigin}`], options: [
      { value: "path", label: "Continue with directory" }, { value: "instance", label: "Change Instance" },
      { value: "projects", label: "Project list" }, { value: "exit", label: "Exit" }
    ] }, value => value === "path" ? this.pathScreen() : value === "instance" ? this.instanceScreen() : value === "exit" ? this.close() : this.list(), () => this.close())
  }
  private instanceScreen() {
    this.show({ kind: "input", title: "ATape Instance", initial: this.instanceOrigin,
      details: ["Use https://atape.net or your self-hosted Instance origin."] }, value => {
      this.work("Checking Instance", selectInstanceOrigin({ commandLine: String(value), allowLoopbackHttp: this.developmentHTTP }), origin => {
        this.instanceOrigin = origin
        this.pathScreen()
      }, undefined, () => this.instanceScreen())
    }, () => this.pathScreen())
  }
  pathChanged = (value: string) => {
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
      return yield* platform.suggestDirectories(value)
    }).pipe(Effect.catch(() => Effect.succeed([] as DirectorySuggestion[]))), AbortSignal.any([controller.signal, this.lifetime.signal])).then(suggestions => {
      if (!controller.signal.aborted && this.screen.revision === revision) this.publish({ ...this.screen, suggestions, directoriesLoading: false })
    }).catch(() => {})
  }
  private prepare(loginAllowed = true) {
    this.work("Finding your Project", prepareGuidedSetup({ instanceOrigin: this.instanceOrigin, path: this.path }), plan => this.teamScreen(plan), error => {
      if ("reason" in error && error.reason === "no_team") this.noTeam()
      else if ("reason" in error && error.reason === "unauthenticated" && loginAllowed) this.login(() => this.prepare(false), () => this.pathScreen())
      else this.failed(error, () => this.prepare(), () => this.pathScreen())
    }, () => this.pathScreen())
  }
  private login(after: () => void, back: () => void) {
    const effect = loginCLI({ instanceOrigin: this.instanceOrigin, allowLoopbackHttp: this.developmentHTTP, openBrowser: !this.options.noBrowser }).pipe(
      Effect.provideService(CLIAuthenticationInteraction, CLIAuthenticationInteraction.of({
        presentChallenge: challenge => Effect.sync(() => {
          this.publish({ ...this.screen, kind: "menu", title: "Sign in through your browser", details: [
            `Instance: ${challenge.instanceOrigin}`, `Open: ${challenge.verificationUri}`, `Code: ${challenge.userCode}`,
            "Waiting for browser approval… Setup continues automatically after approval."
          ], options: [{ value: "open", label: "Open sign-in page" }, { value: "cancel", label: "Cancel sign-in" }] })
          this.action = value => {
            if (value === "cancel") return this.back()
            const revision = this.screen.revision
            void this.run(Effect.promise(() => launchBrowser(process.platform, challenge.verificationUri)), this.lifetime.signal)
              .then(() => { if (this.screen.revision === revision) this.publish({ ...this.screen, notice: "Sign-in page opened. Approve the code in your browser." }) })
              .catch(() => { if (this.screen.revision === revision) this.publish({ ...this.screen, notice: `Open this link in your browser: ${challenge.verificationUri}` }) })
          }
        }),
        openBrowser: uri => Effect.promise(() => launchBrowser(process.platform, uri))
      })),
      Effect.tap(() => setActiveInstance(this.instanceOrigin))
    )
    this.work("Starting browser sign-in", effect, after, undefined, back)
  }
  private noTeam(url?: string) {
    this.show({ kind: "menu", title: "Create or join a Team", details: [
      "Finish Team onboarding in the Web app, then return here and Refresh.", `Directory retained: ${this.path}`, ...(url ? [url] : [])
    ], options: [{ value: "web", label: "Open Web onboarding" }, { value: "refresh", label: "Refresh" }, { value: "back", label: "Back" }] }, value => {
      if (value === "refresh") this.prepare()
      else if (value === "web") this.work("Opening Web onboarding", this.openWeb(), url => this.noTeam(url), undefined, () => this.noTeam(url))
      else this.pathScreen()
    }, () => this.pathScreen())
  }
  private openWeb(project?: LocalProject) {
    return experienceWebURL(project?.instanceOrigin ?? this.instanceOrigin, project, this.developmentHTTP).pipe(
      Effect.tap(url => this.options.noBrowser ? Effect.void : Effect.promise(() => launchBrowser(process.platform, url)))
    )
  }
  private teamScreen(plan: GuidedSetupPlan) {
    if (plan.existingDirectory) return this.sourcesScreen(plan, plan.existingDirectory.teamId)
    if (plan.project.teams.length === 1) return this.sourcesScreen(plan, plan.project.teams[0]!.id)
    this.show({ kind: "menu", title: "Choose a Team", details: [`Signed in as ${plan.project.user.displayName}`],
      options: plan.project.teams.map(team => ({ value: team.id, label: `${team.displayName}${plan.project.exactMatches.some(match => match.team.id === team.id) ? " · existing Project" : ""}` }))
    }, value => this.sourcesScreen(plan, String(value)), () => this.pathScreen())
  }
  private sourcesScreen(plan: GuidedSetupPlan, teamId: string, selected?: ReadonlyArray<string>, name?: string) {
    const choices = guidedSourceChoices(plan, teamId)
    this.showSources("Choose conversation sources", choices, selected, [
      `Project: ${plan.project.local.name}`,
      `${plan.project.local.type === "git" ? "Git repository root" : "Directory"}: ${plan.project.local.path}`,
      "Detected means local source data exists, not necessarily conversations for this project.",
      "Selected sources import existing history and keep syncing future conversations."
    ], ids => this.reviewSetup(plan, teamId, ids, name), () => this.pathScreen())
  }
  private showSources(title: string, choices: ReadonlyArray<SourceChoice>, selected: ReadonlyArray<string> | undefined,
    details: ReadonlyArray<string>, submit: (ids: string[]) => void, back: () => void) {
    this.show({ kind: "sources", title, details, selected: selected ?? choices.filter(choice => choice.selected).map(choice => choice.id),
      options: choices.map(choice => ({ value: choice.id, label: `${choice.label} · ${choice.detected ? "detected" : "not detected"}${choice.installed ? " · installed" : " · will install"}` }))
    }, value => submit(Array.isArray(value) ? value : [value]), back)
  }
  private reviewSetup(plan: GuidedSetupPlan, teamId: string, ids: ReadonlyArray<string>, name?: string) {
    if (ids.length === 0) {
      this.sourcesScreen(plan, teamId, ids, name)
      this.publish({ ...this.screen, notice: "Select at least one source to continue." })
      return
    }
    const team = plan.project.teams.find(team => team.id === teamId)!
    const exact = plan.project.exactMatches.find(match => match.team.id === teamId)
    const projectName = exact?.project.name ?? plan.existingDirectory?.name ?? name ?? plan.project.local.name
    const details = [
      `Instance: ${plan.project.instanceOrigin}`, `Account: ${plan.project.user.displayName}`, `Team: ${team.displayName}`,
      `Project: ${projectName} · ${exact || plan.existingDirectory ? "connect existing" : "create new"}`,
      ...(plan.project.local.type === "git" ? [`Git: ${exact?.project.repositoryIdentity ?? plan.project.local.repositoryRemote}`, `Repository root: ${plan.project.local.path}`] : [`Directory: ${plan.project.local.path}`]),
      `Sources: ${ids.join(", ")}`, "Import existing conversations and continuously sync future conversations.",
      "Install or upgrade selected integrations as needed. Background sync continues after you exit."
    ]
    this.show({ kind: "menu", title: "Review and connect", details, options: [
      { value: "confirm", label: "Confirm and start syncing" }, { value: "sources", label: "Change sources" },
      ...(!exact && !plan.existingDirectory && plan.project.local.type === "directory" ? [{ value: "name", label: "Change Project name" }] : []),
      ...(!plan.existingDirectory && plan.project.teams.length > 1 ? [{ value: "team", label: "Change Team" }] : []),
      { value: "back", label: "Change directory or Instance" }
    ] }, value => {
      if (value === "confirm") {
        this.work("Connecting your Project", completeGuidedSetup({ plan, teamId, sourceIds: ids, ...(name ? { name } : {}),
          progress: title => Effect.sync(() => { this.publish({ ...this.screen, title }) })
        }).pipe(Effect.flatMap(project => observeInitialSync(project).pipe(Effect.map(snapshot => ({ project, snapshot }))))),
        ({ project, snapshot }) => this.showConsole(snapshot, project), undefined, () => this.list())
      } else if (value === "sources") this.sourcesScreen(plan, teamId, ids, name)
      else if (value === "name") this.show({ kind: "input", title: "Project name", initial: projectName, details: [] }, value => this.reviewSetup(plan, teamId, ids, String(value)), () => this.reviewSetup(plan, teamId, ids, name))
      else if (value === "team") this.show({ kind: "menu", title: "Choose a Team", details: [], options: plan.project.teams.map(team => ({ value: team.id, label: team.displayName })) }, value => this.sourcesScreen(plan, String(value)), () => this.reviewSetup(plan, teamId, ids, name))
      else this.setupOptions()
    }, () => this.sourcesScreen(plan, teamId, ids, name))
  }
  private refreshConsole() {
    const target = this.consoleTarget
    if (target === undefined || this.screen.refreshing) return
    this.cancelOperation()
    const generation = this.generation
    const controller = new AbortController()
    this.operation = controller
    this.publish({ ...this.screen, refreshing: true })
    const failed = (error: unknown) => {
      if (generation !== this.generation || this.lifetime.signal.aborted || this.consoleTarget !== target) return
      this.operation = undefined
      this.publish({ ...this.screen, refreshing: false, refreshError: `Status may be stale: ${error instanceof Error ? error.message : String(error)}` })
    }
    void this.run(inspectCLIExperience().pipe(Effect.match({
      onSuccess: snapshot => ({ ok: true as const, snapshot }),
      onFailure: error => ({ ok: false as const, error })
    })), AbortSignal.any([controller.signal, this.lifetime.signal])).then(result => {
      if (generation !== this.generation || this.lifetime.signal.aborted || this.consoleTarget !== target) return
      this.operation = undefined
      if (result.ok) this.showConsole(result.snapshot, target, true, "Status updated. Sync timing is unchanged.")
      else failed(result.error)
    }).catch(failed)
  }
  private list() { this.work("Refreshing Projects", inspectCLIExperience(), snapshot => this.showConsole(snapshot, "list"), undefined, () => this.close()) }
  private detail(project: LocalProject) { this.work("Refreshing Project", inspectCLIExperience(), snapshot => this.showConsole(snapshot, project), undefined, () => this.list()) }
  private showConsole(snapshot: CLIExperienceSnapshot, target: LocalProject | "list", refresh = false, notice?: string) {
    this.latest = snapshot
    this.hasProjects = snapshot.projects.length > 0
    if (!this.hasProjects) return this.welcome()
    const selected = target === "list" ? undefined : snapshot.projects.find(item => item.project.id === target.id && item.project.instanceOrigin === target.instanceOrigin)
    if (selected && refresh && this.screen.diagnostics) return this.diagnostics(selected, true, notice ?? this.screen.notice)
    const revision = this.screen.revision
    const options = selected ? this.projectOptions(selected) : snapshot.projects.map(item => ({
      value: `project:${item.project.instanceOrigin}:${item.project.id}`,
      label: `${item.project.name} · ${item.project.adapterIds.map(id => id === "claude" ? "Claude" : id === "codex" ? "Codex" : id).join(" + ") || "No sources"} · ${statusLabel(item)} · ${item.project.teamName}`
    }))
    const actions = [
      { value: "add", label: "Add project" },
      ...(!snapshot.collector.running ? [{ value: "start", label: "Start sync for all projects" }] : [{ value: "stop", label: "Stop sync for all projects" }]),
      { value: "refresh", label: "Refresh status" }, { value: "exit", label: "Exit" }
    ]
    this.show({ kind: "menu", title: selected ? selected.project.name : "Your Projects",
      ...(!selected ? { layout: "projects" as const, actions, projects: snapshot.projects.map(item => ({
        value: `project:${item.project.instanceOrigin}:${item.project.id}`, name: item.project.name,
        sources: item.project.adapterIds.map(id => id === "claude" ? "Claude" : id === "codex" ? "Codex" : id).join(" + ") || "None",
        status: statusLabel(item), team: item.project.teamName
      })), ...(this.focusedProject ? { focusedProject: this.focusedProject } : {}) } : {}),
      ...((notice ?? (refresh ? this.screen.notice : undefined)) ? { notice: notice ?? this.screen.notice! } : {}),
      details: selected ? this.projectDetails(selected, snapshot) : [
        snapshot.collector.running ? "Background sync is running. Exiting keeps it running." : "Sync is stopped. Start sync for all projects to resume.",
        ...(snapshot.collector.collectorFailure ? [snapshot.collector.collectorFailure.message] : [])
      ], options }, value => this.consoleAction(String(value), selected), selected ? () => this.list() : () => this.close(), refresh ? revision : undefined)
    this.consoleTarget = selected?.project ?? "list"
  }
  private projectOptions(item: ConsoleProject) {
    const primary = item.recovery.kind === "sources" ? { value: "sources", label: "Choose conversation sources" }
      : item.recovery.kind === "sign_in" ? { value: "login", label: "Sign in again and resume" }
      : item.recovery.kind === "sign_in_elsewhere" ? { value: "unblock", label: `Sign in for ${item.recovery.project.name} and resume` }
      : item.recovery.kind === "resume" ? { value: "start", label: "Start sync for all projects" }
      : item.recovery.kind === "partial" ? { value: "diagnostics", label: "Review skipped conversations" }
      : item.recovery.kind === "repair" ? { value: "diagnostics", label: "Resolve sync issue" }
      : item.recovery.kind === "automatic_retry" ? { value: "diagnostics", label: "View retry details" }
      : { value: "web", label: "Open Project in Web" }
    return [
      primary,
      ...(primary.value !== "web" ? [{ value: "web", label: "Open Project in Web" }] : []),
      { value: "settings", label: "Project settings" },
      { value: "refresh", label: "Refresh status" }, { value: "back", label: "All Projects" }
    ]
  }
  private projectSettings(item: ConsoleProject) {
    this.show({ kind: "menu", title: "Project settings", details: [item.project.name, `${item.project.teamName} · ${item.project.instanceOrigin}`], options: [
      { value: "sources", label: "Manage conversation sources" },
      { value: "diagnostics", label: "Sync details" },
      { value: "login", label: "Sign in again and resume" },
      { value: "remove", label: "Remove local capture" },
      { value: "back", label: "Back to Project" }
    ] }, value => value === "back" ? this.detail(item.project) : this.consoleAction(String(value), item), () => this.detail(item.project))
  }
  private projectDetails(item: ConsoleProject, snapshot: CLIExperienceSnapshot) { return [
    statusLabel(item),
    ...(recoveryGuidance(item, snapshot.collector.running) ? [recoveryGuidance(item, snapshot.collector.running)] : []),
    ...item.jobs.flatMap(job => job.failureMessage ? [`${job.adapterId}: ${job.failureMessage}`] : []),
    ...(snapshot.collector.collectorFailure ? [snapshot.collector.collectorFailure.message] : []),
    ...(item.recovery.kind === "automatic_retry" || item.recovery.kind === "repair" ? ["Refresh status only updates this page."] : []),
    `${item.project.teamName} · ${item.project.instanceOrigin}`,
    item.project.type === "git" ? `Git: ${item.project.repositoryIdentity ?? item.project.repositoryRemote ?? item.project.name}` : `Directory: ${item.project.path}`,
    `Sources: ${item.project.adapterIds.join(", ") || "none"}`
  ] }
  private diagnostics(item: ConsoleProject, refresh = false, notice?: string) {
    const back = () => this.detail(item.project)
    const running = Boolean(this.latest?.collector.running)
    this.show({ kind: "menu", diagnostics: true, title: "Sync details", ...(notice ? { notice } : {}), details: [
      item.project.name, recoveryGuidance(item, running),
      ...(this.latest?.collector.collectorFailure ? [this.latest.collector.collectorFailure.message] : []),
      ...item.jobs.flatMap(job => [
        `${job.adapterId}: ${job.state}`,
        ...(job.failureMessage ? [job.failureMessage] : []),
        ...(job.failureReason ? [failureGuidance[job.failureReason]] : []),
        ...(job.lastSuccessAt ? [`Last completed: ${job.lastSuccessAt}`] : []),
        ...(job.sourceFailures?.slice(0, 3).flatMap(failure => [`${failure.source}`, sourceFailureGuidance[failure.reason]]) ?? []),
        ...(job.sourceFailuresTruncated || (job.sourceFailures?.length ?? 0) > 3 ? ["More skipped sources: atape status --json"] : [])
      ]), "Refresh status only updates the page; it does not restart sync."
    ], options: [
      ...(item.recovery.kind === "sign_in" ? [{ value: "login", label: "Sign in again and resume" }] : []),
      ...(item.recovery.kind === "sign_in_elsewhere" ? [{ value: "unblock", label: `Sign in for ${item.recovery.project.name} and resume` }] : []),
      ...(!running && item.recovery.kind !== "sign_in" && item.recovery.kind !== "sign_in_elsewhere" ? [{ value: "start", label: "Start sync for all projects" }] : []),
      { value: "sources", label: "Manage conversation sources" },
      { value: "refresh", label: "Refresh status" }, { value: "back", label: "Back to Project" }
    ] }, value => {
      if (value === "back") back()
      else if (value === "refresh") this.refreshConsole()
      else this.consoleAction(String(value), item)
    }, back, refresh ? this.screen.revision : undefined)
    this.consoleTarget = item.project
  }
  private consoleAction(value: string, item?: ConsoleProject) {
    const back = () => item ? this.detail(item.project) : this.list()
    if (value.startsWith("project:")) {
      const selected = this.latest?.projects.find(item => `project:${item.project.instanceOrigin}:${item.project.id}` === value)
      if (selected) { this.focusedProject = value; this.detail(selected.project) }
    } else if (value === "add") this.pathScreen()
    else if (value === "exit") this.close()
    else if (value === "back") this.list()
    else if (value === "refresh") this.refreshConsole()
    else if (value === "start") this.work("Starting background sync", startExperienceCollector(), back, undefined, back)
    else if (value === "stop") this.confirm("Stop background sync?", ["This stops future collection for ALL local Projects. Captured history is retained."], "Stop all sync", () => this.work("Stopping background sync", stopExperienceCollector(), () => this.list(), undefined, back), back)
    else if (item && value === "web") this.work("Opening Project", this.openWeb(item.project), url => this.showConsole(this.latest!, item.project, false, `${this.options.noBrowser ? "Open" : "Opened in browser"}: ${url}`), undefined, back)
    else if (item && value === "settings") this.projectSettings(item)
    else if (item && value === "diagnostics") this.diagnostics(item)
    else if (item && value === "unblock" && item.recovery.kind === "sign_in_elsewhere") {
      this.instanceOrigin = item.recovery.project.instanceOrigin
      this.login(() => this.work("Checking account and resuming", startExperienceCollector(), back, undefined, back), back)
    }
    else if (item && value === "sources") this.manageSources(item.project)
    else if (item && value === "login") {
      this.instanceOrigin = item.project.instanceOrigin
      this.login(() => this.work("Checking account and resuming", startExperienceCollector(), back, undefined, back), back)
    } else if (item && value === "remove") this.confirm("Remove local capture?", [
      `${item.project.name} · ${item.project.instanceOrigin}`, "Future cycles will stop collecting this Project. An in-flight upload may finish.",
      "Server conversations and history will be retained."
    ], "Remove local capture", () => this.work("Removing local capture", removeExperienceProject(item.project), () => this.list(), undefined, back), back)
  }
  private manageSources(project: LocalProject) {
    this.work("Reading source integrations", inspectProjectSources(project), choices => this.showSources("Manage conversation sources", choices, undefined, [
      "Changes apply to subsequent cycles. An in-flight upload may finish.", "Newly enabled sources include existing history. No sources means no capture."
    ], ids => this.confirm("Apply source selection?", [`Sources: ${ids.join(", ") || "none"}`, "Install or upgrade selected integrations as needed."], "Apply sources",
      () => this.work("Updating sources", changeProjectSources(project, ids), () => this.detail(project), undefined, () => this.detail(project)), () => this.manageSources(project)), () => this.detail(project)), undefined, () => this.detail(project))
  }
  private confirm(title: string, details: ReadonlyArray<string>, label: string, apply: () => void, back: () => void) {
    this.show({ kind: "menu", title, details, options: [{ value: "back", label: "Cancel" }, { value: "confirm", label }] }, value => value === "confirm" ? apply() : back(), back)
  }
}
