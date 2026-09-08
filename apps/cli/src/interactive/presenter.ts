import {
  CLIAuthenticationInteraction, CLISetupPlatform, changeProjectSources, completeGuidedSetup,
  experienceWebURL, guidedSourceChoices, inspectCLIExperience, inspectClient, inspectProjectSources,
  loginCLI, observeInitialSync, prepareGuidedSetup, removeExperienceProject, selectInstanceOrigin,
  setActiveInstance, startExperienceCollector, stopExperienceCollector,
  type CLIExperienceSnapshot, type ConsoleProject, type GuidedSetupPlan, type SourceChoice
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
  readonly suggestions?: ReadonlyArray<string>
  readonly pathInput?: boolean
  readonly refreshError?: string
}
const stateLabels = {
  no_sources: "No sources enabled", stopped: "Sync stopped", waiting: "Waiting for a first conversation",
  syncing: "Syncing", queued: "History queued", up_to_date: "Up to date",
  partial: "Partial coverage", failed: "Needs attention"
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
    this.show({ kind: "busy", title, details: ["Escape to cancel · completed configuration is retained"] }, undefined, back)
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
        { value: "retry", label: "Retry" },
        ...(reason === "unauthenticated" || reason === "changed" ? [{ value: "login", label: "Sign in again" }] : []),
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
      if (this.options.setup || config.projects.length === 0) this.pathScreen()
      else this.list()
    }, undefined, () => this.close())
    void this.run(Effect.gen(function*(this: ExperiencePresenter) {
      while (true) {
        yield* Effect.sleep(2_000)
        if (this.consoleTarget === undefined) continue
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
  private pathScreen() {
    this.show({ kind: "input", title: "Connect a Project", initial: this.path, pathInput: true,
      details: [`Instance: ${this.instanceOrigin}`, "Choose a project directory. Git worktrees and clones share one repository.", "Enter to continue · Tab completes a directory"] }, value => {
      this.path = String(value)
      this.prepare()
    }, () => this.setupOptions())
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
    const controller = new AbortController()
    this.suggestions = controller
    const revision = this.screen.revision
    void this.run(Effect.gen(function*() {
      yield* Effect.sleep(120)
      const platform = yield* CLISetupPlatform
      return yield* platform.suggestDirectories(value)
    }).pipe(Effect.catch(() => Effect.succeed([] as string[]))), AbortSignal.any([controller.signal, this.lifetime.signal])).then(suggestions => {
      if (!controller.signal.aborted && this.screen.revision === revision) this.publish({ ...this.screen, suggestions })
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
          this.publish({ ...this.screen, title: "Sign in through your browser", details: [
            `Instance: ${challenge.instanceOrigin}`, `Open: ${challenge.verificationUri}`, `Code: ${challenge.userCode}`,
            "Waiting for browser approval… · Escape to cancel"
          ] })
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
      "Detected means a local data directory exists. It may contain no conversations for this Project.",
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
    if (ids.length === 0) return this.sourcesScreen(plan, teamId, ids, name)
    const team = plan.project.teams.find(team => team.id === teamId)!
    const exact = plan.project.exactMatches.find(match => match.team.id === teamId)
    const projectName = exact?.project.name ?? plan.existingDirectory?.name ?? name ?? plan.project.local.name
    const details = [
      `Instance: ${plan.project.instanceOrigin}`, `Account: ${plan.project.user.displayName}`, `Team: ${team.displayName}`,
      `Project: ${projectName} · ${exact || plan.existingDirectory ? "connect existing" : "create new"}`,
      plan.project.local.type === "git" ? `Git: ${exact?.project.repositoryIdentity ?? plan.project.local.repositoryRemote}` : `Directory: ${plan.project.local.path}`,
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
  private list() { this.work("Refreshing Projects", inspectCLIExperience(), snapshot => this.showConsole(snapshot, "list"), undefined, () => this.close()) }
  private detail(project: LocalProject) { this.work("Refreshing Project", inspectCLIExperience(), snapshot => this.showConsole(snapshot, project), undefined, () => this.list()) }
  private showConsole(snapshot: CLIExperienceSnapshot, target: LocalProject | "list", refresh = false) {
    this.latest = snapshot
    const selected = target === "list" ? undefined : snapshot.projects.find(item => item.project.id === target.id && item.project.instanceOrigin === target.instanceOrigin)
    const revision = this.screen.revision
    const options = selected ? this.projectOptions(selected) : [
      ...snapshot.projects.map(item => ({ value: `project:${item.project.instanceOrigin}:${item.project.id}`, label: `${item.project.name} · ${item.project.teamName} · ${stateLabels[item.state]}` })),
      { value: "add", label: "Add Project" },
      ...(!snapshot.collector.running ? [{ value: "start", label: "Start background sync" }] : []),
      ...(snapshot.collector.running ? [{ value: "stop", label: "Stop sync for ALL Projects" }] : []),
      { value: "refresh", label: "Refresh" }, { value: "exit", label: "Exit" }
    ]
    this.show({ kind: "menu", title: selected ? selected.project.name : "Your Projects", details: selected ? this.projectDetails(selected, snapshot) : [
      snapshot.collector.running ? "Background sync is running. Exiting keeps it running." : "Background sync is stopped. After a reboot, run atape start.",
      ...(snapshot.projects.length === 0 ? ["Connect a Project to start sharing conversations."] : []),
      ...(snapshot.collector.collectorFailure ? [snapshot.collector.collectorFailure.message] : [])
    ], options }, value => this.consoleAction(String(value), selected), selected ? () => this.list() : () => this.close(), refresh ? revision : undefined)
    this.consoleTarget = selected?.project ?? "list"
  }
  private projectOptions(item: ConsoleProject) { return [
    { value: "web", label: "Open Project in Web" }, { value: "sources", label: "Manage sources" },
    ...(this.latest?.collector.running ? [] : [{ value: "start", label: "Start background sync" }]),
    { value: "login", label: "Sign in again and resume" }, { value: "refresh", label: "Refresh" },
    { value: "remove", label: "Remove local capture" }, { value: "back", label: "All Projects" }
  ] }
  private projectDetails(item: ConsoleProject, snapshot: CLIExperienceSnapshot) { return [
    stateLabels[item.state], `${item.project.teamName} · ${item.project.instanceOrigin}`,
    item.project.type === "git" ? `Git: ${item.project.repositoryIdentity ?? item.project.repositoryRemote ?? item.project.name}` : `Directory: ${item.project.path}`,
    `Sources: ${item.project.adapterIds.join(", ") || "none"}`,
    ...item.jobs.flatMap(job => [
      ...(job.failureMessage ? [`${job.adapterId}: ${job.failureMessage}`] : []),
      ...(job.lastSuccessAt ? [`${job.adapterId} last completed: ${job.lastSuccessAt}`] : []),
      ...(job.sourceFailures?.slice(0, 3).map(failure => `${job.adapterId}: ${failure.reason} · ${failure.source}`) ?? []),
      ...(job.sourceFailuresTruncated || (job.sourceFailures?.length ?? 0) > 3 ? ["More skipped sources: use atape status --json for details."] : [])
    ]),
    ...(item.state === "partial" ? ["Some sources were skipped. Healthy conversations continue syncing."] : []),
    ...(snapshot.collector.running ? [] : ["Start resumes all enabled Projects after checking their accounts."])
  ] }
  private consoleAction(value: string, item?: ConsoleProject) {
    const back = () => item ? this.detail(item.project) : this.list()
    if (value.startsWith("project:")) {
      const selected = this.latest?.projects.find(item => `project:${item.project.instanceOrigin}:${item.project.id}` === value)
      if (selected) this.detail(selected.project)
    } else if (value === "add") this.pathScreen()
    else if (value === "exit") this.close()
    else if (value === "back") this.list()
    else if (value === "refresh") back()
    else if (value === "start") this.work("Starting background sync", startExperienceCollector(), back, undefined, back)
    else if (value === "stop") this.confirm("Stop background sync?", ["This stops future collection for ALL local Projects. Captured history is retained."], "Stop all sync", () => this.work("Stopping background sync", stopExperienceCollector(), () => this.list(), undefined, back), back)
    else if (item && value === "web") this.work("Opening Project", this.openWeb(item.project), url => this.show({ kind: "menu", title: "Project in Web", details: [url], options: [{ value: "back", label: "Back to Project" }] }, back, back), undefined, back)
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
