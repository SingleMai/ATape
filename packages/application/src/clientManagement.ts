import { refreshManagedCollector } from "./collectorDaemonProcess.ts"
import type {
  AdapterInstallation,
  AdapterManifest,
  ClientConfig,
  LocalProject,
  ProjectRegistration
} from "@atape/domain"
import { Clock, Context, Effect, Schema, type Scope } from "effect"

export class ClientConfigStoreError extends Schema.TaggedError<ClientConfigStoreError>()("ClientConfigStoreError", {
  reason: Schema.Literals(["io", "decode"]),
  message: Schema.String
}) {}

export class ProjectLocatorError extends Schema.TaggedError<ProjectLocatorError>()("ProjectLocatorError", {
  reason: Schema.Literals(["missing", "not_directory", "not_git", "io"]),
  path: Schema.String,
  message: Schema.String
}) {}

export class AdapterPackageError extends Schema.TaggedError<AdapterPackageError>()("AdapterPackageError", {
  reason: Schema.Literals(["invalid_spec", "install", "manifest", "io"]),
  packageSpec: Schema.String,
  message: Schema.String
}) {}

export class ClientManagementError extends Schema.TaggedError<ClientManagementError>()("ClientManagementError", {
  reason: Schema.Literals(["invalid", "not_found", "conflict"]),
  resource: Schema.String,
  message: Schema.String
}) {}

export type LocatedProject = {
  readonly path: string
  readonly name: string
  readonly type: "git" | "directory"
  readonly repositoryRemote?: string
}

export type InstalledAdapterPackage = {
  readonly packageName: string
  readonly packageSlot?: string
  readonly upgradeSpec: string
  readonly version: string
  readonly manifest: AdapterManifest
}

export type ClientConfigChange<A> = {
  readonly value: A
  readonly config?: ClientConfig
}

// These platform Seams keep the client management Module independent of Node
// while remaining real: filesystem/Git/npm Layers differ from controlled test
// Adapters and from a future packaged desktop host.
export class ClientConfigStore extends Context.Service<ClientConfigStore, {
  transact<A, E, R>(
    change: (config: ClientConfig) => Effect.Effect<ClientConfigChange<A>, E, R>
  ): Effect.Effect<A, E | ClientConfigStoreError, R>
}>()("atape/application/ClientConfigStore") {}

export class ProjectLocator extends Context.Service<ProjectLocator, {
  locate(path: string, preference: "auto" | "git" | "directory"): Effect.Effect<LocatedProject, ProjectLocatorError>
}>()("atape/application/ProjectLocator") {}

export class AdapterPackages extends Context.Service<AdapterPackages, {
  // Keep preparation alive through configuration activation, not just npm exit.
  install(packageSpec: string): Effect.Effect<InstalledAdapterPackage, AdapterPackageError, Scope.Scope>
  prune(input: { readonly apply: boolean; readonly keep: number }): Effect.Effect<AdapterPruneReport, AdapterPackageError | ClientConfigStoreError, ClientConfigStore>
}>()("atape/application/AdapterPackages") {}

export type AdapterPruneSlot = {
  readonly slot: string
  readonly packageName?: string
  readonly version?: string
  readonly state: "current" | "in_use" | "retained" | "eligible" | "removed" | "unmanaged"
}

export type AdapterPruneReport = {
  readonly applied: boolean
  readonly slots: ReadonlyArray<AdapterPruneSlot>
  readonly removed: number
  readonly more: boolean
}

export const pruneAdapterPackages = Effect.fn("Client.pruneAdapterPackages")(function*(input: {
  readonly apply?: boolean
  readonly keep?: number
} = {}) {
  const keep = input.keep ?? 1
  if (!Number.isSafeInteger(keep) || keep < 0 || keep > 20) {
    return yield* new ClientManagementError({ reason: "invalid", resource: "adapter", message: "The retained version count must be an integer from 0 to 20." })
  }
  return yield* (yield* AdapterPackages).prune({ apply: input.apply === true, keep })
})

export type SetupProjectInput = {
  readonly path: string
  readonly instanceOrigin: string
  readonly userId: string
  readonly teamId: string
  readonly teamSlug: string
  readonly teamName: string
  readonly projectId: string
  readonly name: string
  readonly createdAt: string
  readonly repositoryIdentity?: string
  readonly expectedRepositoryRemote?: string
  readonly type?: "auto" | "git" | "directory"
  readonly expectedToolIds?: ReadonlyArray<string>
}

export type SetupProjectResult = {
  readonly project: LocalProject
  readonly created: boolean
  readonly updated?: boolean
}

export type AdapterInstallResult = {
  readonly adapter: AdapterInstallation
  readonly created: boolean
}

export const inspectClient = Effect.fn("Client.inspect")(function*() {
  const store = yield* ClientConfigStore
  return yield* store.transact<ClientSnapshot, never, never>((config) => Effect.succeed({ value: effectiveClientConfig(config) }))
})

export type ClientSnapshot = Omit<ClientConfig, "projects"> & { readonly projects: ReadonlyArray<LocalProject> }

// Every caller, including the Collector, sees the authoritative global selection.
export const effectiveClientConfig = (config: ClientConfig): ClientSnapshot =>
  ({ ...config, projects: config.projects.map(project => ({ ...project, adapterIds: config.enabledAdapterIds })) })

// A reviewed selection is an optimistic concurrency check, never a Project override.
export const validateProjectToolSelection = (config: ClientConfig, ids?: ReadonlyArray<string>) =>
  ids !== undefined && !sameStrings([...ids].sort(), [...config.enabledAdapterIds].sort())
    ? Effect.fail(new ClientManagementError({ reason: "conflict", resource: "tools",
      message: "Global tools changed. Review this Project again." }))
    : Effect.void

export const setActiveInstance = Effect.fn("Client.setActiveInstance")(function*(instanceOrigin: string) {
  const store = yield* ClientConfigStore
  return yield* store.transact<string, never, never>((config) => Effect.succeed(
    config.activeInstanceOrigin === instanceOrigin
      ? { value: instanceOrigin }
      : { value: instanceOrigin, config: { ...config, activeInstanceOrigin: instanceOrigin } }
  ))
})

export const setupProject = Effect.fn("Client.setupProject")(function*(input: SetupProjectInput) {
  yield* validateText("instance", input.instanceOrigin)
  yield* validateText("user", input.userId)
  yield* validateText("team", input.teamId)
  yield* validateText("team", input.teamSlug)
  yield* validateText("team", input.teamName)
  yield* validateText("project", input.name)
  yield* validateText("project", input.projectId)

  const store = yield* ClientConfigStore
  const locator = yield* ProjectLocator
  const located = yield* locator.locate(input.path, input.type ?? "auto")
  if (located.type === "git" && (!located.repositoryRemote || !input.repositoryIdentity ||
    input.expectedRepositoryRemote !== undefined && input.expectedRepositoryRemote !== located.repositoryRemote)) {
    return yield* new ClientManagementError({ reason: "invalid", resource: "project",
      message: "Git setup requires a supported origin and server-verified repository identity. Run authenticated setup again." })
  }
  const projectName = input.name.trim()
  const projectId = input.projectId.trim()
  yield* validateText("project", projectName)

  return yield* store.transact<SetupProjectResult, ClientManagementError, never>((config) => Effect.gen(function*() {
    yield* validateProjectToolSelection(config, input.expectedToolIds)
    const adapterIds = [...config.enabledAdapterIds]
    for (const adapterId of adapterIds) {
      if (!config.adapters.some((adapter) => adapter.adapterId === adapterId)) {
        return yield* new ClientManagementError({
          reason: "not_found",
          resource: "adapter",
          message: `Adapter ${adapterId} is not installed.`
        })
      }
    }

    const existing = config.projects.find((project) =>
      project.instanceOrigin === input.instanceOrigin && project.id === projectId)
    const pathOwner = config.projects.find((project) => project.path === located.path && project !== existing)
    if (pathOwner) {
      return yield* new ClientManagementError({ reason: "conflict", resource: "project",
        message: `${located.path} is already configured as Project ${pathOwner.id}.` })
    }
    if (existing) {
      if (located.type === "git" && existing.type === "git" &&
        existing.userId === input.userId.trim() && existing.teamId === input.teamId.trim()) {
        const next: ProjectRegistration = { ...existing,
          name: projectName, teamSlug: input.teamSlug.trim(), teamName: input.teamName.trim(),
          path: located.path, repositoryRemote: located.repositoryRemote!, repositoryIdentity: input.repositoryIdentity!
        }
        const updated = JSON.stringify(next) !== JSON.stringify(existing)
        return { value: { project: { ...next, adapterIds }, created: false, updated } satisfies SetupProjectResult,
          ...(updated || config.activeInstanceOrigin !== input.instanceOrigin ? { config: {
            ...config, activeInstanceOrigin: input.instanceOrigin,
            projects: config.projects.map(project => project === existing ? next : project)
          } } : {}) }
      }
      const same = existing.userId === input.userId.trim() && existing.teamId === input.teamId.trim() &&
        existing.teamSlug === input.teamSlug.trim() && existing.teamName === input.teamName.trim() &&
        existing.name === projectName && existing.type === located.type && existing.path === located.path &&
        existing.repositoryRemote === located.repositoryRemote
      if (!same) {
        return yield* new ClientManagementError({
          reason: "conflict",
          resource: "project",
          message: `Project ${projectId} is already configured with immutable identity or path fields.`
        })
      }
      return {
        value: { project: { ...existing, adapterIds }, created: false } satisfies SetupProjectResult,
        ...(config.activeInstanceOrigin === input.instanceOrigin
          ? {}
          : { config: { ...config, activeInstanceOrigin: input.instanceOrigin } })
      }
    }
    const project: ProjectRegistration = {
      id: projectId,
      instanceOrigin: input.instanceOrigin,
      userId: input.userId.trim(),
      teamId: input.teamId.trim(),
      teamSlug: input.teamSlug.trim(),
      teamName: input.teamName.trim(),
      name: projectName,
      type: located.type,
      path: located.path,
      ...(located.repositoryRemote === undefined ? {} : { repositoryRemote: located.repositoryRemote }),
      ...(located.type !== "git" ? {} : { repositoryIdentity: input.repositoryIdentity! }),
      createdAt: input.createdAt
    }
    return {
      value: { project: { ...project, adapterIds }, created: true } satisfies SetupProjectResult,
      config: {
        ...config,
        activeInstanceOrigin: input.instanceOrigin,
        projects: [...config.projects, project].sort((left, right) =>
          `${left.instanceOrigin}\0${left.id}`.localeCompare(`${right.instanceOrigin}\0${right.id}`))
      }
    }
  })
  )
})

export const removeProject = Effect.fn("Client.removeProject")(function*(projectId: string) {
  const store = yield* ClientConfigStore
  return yield* store.transact<void, ClientManagementError, never>((config) => Effect.gen(function*() {
    const matches = config.projects.filter((project) => project.id === projectId)
    if (matches.length === 0) {
      return yield* new ClientManagementError({
        reason: "not_found", resource: "project", message: `Project ${projectId} is not configured locally.`
      })
    }
    if (matches.length > 1) {
      return yield* new ClientManagementError({
        reason: "conflict", resource: "project",
        message: `Project ${projectId} exists on more than one Instance; select an Instance explicitly.`
      })
    }
    const selected = matches[0]
    return {
      value: undefined,
      config: { ...config, projects: config.projects.filter((project) => project !== selected) }
    }
  }))
})

export const installAdapter = Effect.fn("Client.installAdapter")(function*(packageSpec: string, expected?: {
  readonly installation: AdapterInstallation
  readonly version?: string
}) {
  const store = yield* ClientConfigStore
  const packages = yield* AdapterPackages
  const before = yield* inspectClient()
  if (expected && !sameInstallation(before.adapters.find(adapter => adapter.adapterId === expected.installation.adapterId), expected.installation)) {
    return yield* installationChanged()
  }
  // Preparation is inert and owns a separate npm tree. Only the short config
  // transaction below selects it for future collection cycles.
  const installed = yield* packages.install(packageSpec)
  yield* validateIdentifier("adapter", installed.manifest.adapterId)
  // An old Host must understand the new installation layout before activation.
  yield* refreshManagedCollector()
  return yield* store.transact<AdapterInstallResult, ClientManagementError | AdapterPackageError, never>((config) => Effect.gen(function*() {
    const previous = before.adapters.find(adapter => adapter.adapterId === installed.manifest.adapterId)
    if (!sameInstallation(config.adapters.find(adapter => adapter.adapterId === installed.manifest.adapterId), previous) ||
      expected && !sameInstallation(config.adapters.find(adapter => adapter.adapterId === expected.installation.adapterId), expected.installation)) {
      return yield* installationChanged()
    }
    if (expected && (installed.manifest.adapterId !== expected.installation.adapterId || installed.packageName !== expected.installation.packageName ||
      expected.version !== undefined && installed.version !== expected.version)) {
      return yield* new ClientManagementError({ reason: "conflict", resource: "adapter", message: "The installed package does not match the selected tool release." })
    }
    const byID = config.adapters.find((adapter) => adapter.adapterId === installed.manifest.adapterId)
    if (byID && byID.packageName !== installed.packageName) {
      return yield* new ClientManagementError({
        reason: "conflict",
        resource: "adapter",
        message: `Adapter ID ${installed.manifest.adapterId} is already owned by ${byID.packageName}.`
      })
    }
    const now = new Date(yield* Clock.currentTimeMillis).toISOString()
    const adapter: AdapterInstallation = {
      adapterId: installed.manifest.adapterId,
      packageName: installed.packageName,
      ...(installed.packageSlot === undefined ? {} : { packageSlot: installed.packageSlot }),
      upgradeSpec: installed.upgradeSpec,
      displayName: installed.manifest.displayName,
      version: installed.version,
      installedAt: byID?.installedAt ?? now,
      updatedAt: now
    }
    return {
      value: { adapter, created: byID === undefined } satisfies AdapterInstallResult,
      config: {
        ...config,
        adapters: [...config.adapters.filter((item) => item.adapterId !== adapter.adapterId), adapter]
          .sort((left, right) => left.adapterId.localeCompare(right.adapterId))
      }
    }
  }))
}, Effect.scoped)

export const upgradeAdapters = Effect.fn("Client.upgradeAdapters")(function*(target: string | "all") {
  const snapshot = yield* inspectClient()
  const selectedIds = target === "all"
    ? snapshot.adapters.map((adapter) => adapter.adapterId)
    : snapshot.adapters.filter((adapter) => adapter.adapterId === target).map((adapter) => adapter.adapterId)
  if (target !== "all" && selectedIds.length === 0) {
    return yield* new ClientManagementError({
      reason: "not_found", resource: "adapter", message: `Adapter ${target} is not installed.`
    })
  }

  const upgraded: Array<AdapterInstallation> = []
  for (const adapterId of selectedIds) {
    const config = yield* inspectClient()
    const current = config.adapters.find((adapter) => adapter.adapterId === adapterId)
    if (!current) {
      return yield* new ClientManagementError({
        reason: "not_found", resource: "adapter", message: `Adapter ${adapterId} is no longer installed.`
      })
    }
    const packageSpec = current.upgradeSpec === current.packageName
      ? `${current.packageName}@latest`
      : current.upgradeSpec
    upgraded.push((yield* installAdapter(packageSpec, { installation: current })).adapter)
  }
  return upgraded
})

const sameInstallation = (left: AdapterInstallation | undefined, right: AdapterInstallation | undefined) =>
  JSON.stringify(left) === JSON.stringify(right)
const installationChanged = () => new ClientManagementError({ reason: "conflict", resource: "adapter",
  message: "This tool's installation changed. Check for updates again." })

const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/

function validateIdentifier(resource: string, value: string): Effect.Effect<void, ClientManagementError> {
  return identifierPattern.test(value)
    ? Effect.void
    : Effect.fail(new ClientManagementError({
      reason: "invalid",
      resource,
      message: `${resource} ID must use lowercase letters, numbers, dots, underscores, or hyphens.`
    }))
}

function validateText(resource: string, value: string): Effect.Effect<void, ClientManagementError> {
  return value.trim() !== "" && value.length <= 200
    ? Effect.void
    : Effect.fail(new ClientManagementError({
      reason: "invalid", resource, message: `${resource} must be between 1 and 200 characters.`
    }))
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Persist a presentation preference through the same atomic config Interface. */
export const setClientLocale = (locale: string) => ClientConfigStore.use(store =>
  store.transact(config => Effect.succeed({ value: undefined, config: { ...config, locale } })))
