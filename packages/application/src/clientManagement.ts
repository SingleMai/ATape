import type {
  AdapterInstallation,
  AdapterManifest,
  ClientConfig,
  LocalProject
} from "@atape/domain"
import { Clock, Context, Effect, Schema } from "effect"

export class ClientConfigStoreError extends Schema.TaggedError<ClientConfigStoreError>()("ClientConfigStoreError", {
  reason: Schema.Literals(["io", "decode", "migration_required"]),
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
  install(packageSpec: string): Effect.Effect<InstalledAdapterPackage, AdapterPackageError>
}>()("atape/application/AdapterPackages") {}

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
  readonly type?: "auto" | "git" | "directory"
  readonly adapterIds?: ReadonlyArray<string>
}

export type SetupProjectResult = {
  readonly project: LocalProject
  readonly created: boolean
}

export type AdapterInstallResult = {
  readonly adapter: AdapterInstallation
  readonly created: boolean
}

export const inspectClient = Effect.fn("Client.inspect")(function*() {
  const store = yield* ClientConfigStore
  return yield* store.transact<ClientConfig, never, never>((config) => Effect.succeed({ value: config }))
})

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
  const projectName = input.name.trim()
  const projectId = input.projectId.trim()
  yield* validateText("project", projectName)

  const adapterIds = [...new Set(input.adapterIds ?? [])].sort()
  return yield* store.transact<SetupProjectResult, ClientManagementError, never>((config) => Effect.gen(function*() {
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
    if (existing) {
      const same = existing.userId === input.userId.trim() && existing.teamId === input.teamId.trim() &&
        existing.teamSlug === input.teamSlug.trim() && existing.teamName === input.teamName.trim() &&
        existing.name === projectName && existing.type === located.type && existing.path === located.path &&
        existing.repositoryRemote === located.repositoryRemote && sameStrings(existing.adapterIds, adapterIds)
      if (!same) {
        return yield* new ClientManagementError({
          reason: "conflict",
          resource: "project",
          message: `Project ${projectId} is already configured with immutable identity or path fields.`
        })
      }
      return {
        value: { project: existing, created: false } satisfies SetupProjectResult,
        ...(config.activeInstanceOrigin === input.instanceOrigin
          ? {}
          : { config: { ...config, activeInstanceOrigin: input.instanceOrigin } })
      }
    }
    const pathOwner = config.projects.find((project) => project.path === located.path)
    if (pathOwner) {
      return yield* new ClientManagementError({
        reason: "conflict",
        resource: "project",
        message: `${located.path} is already configured as Project ${pathOwner.id}.`
      })
    }

    const project: LocalProject = {
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
      adapterIds,
      createdAt: input.createdAt
    }
    return {
      value: { project, created: true } satisfies SetupProjectResult,
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

export const installAdapter = Effect.fn("Client.installAdapter")(function*(packageSpec: string) {
  const store = yield* ClientConfigStore
  const packages = yield* AdapterPackages
  return yield* store.transact<AdapterInstallResult, ClientManagementError | AdapterPackageError, never>((config) => Effect.gen(function*() {
    const installed = yield* packages.install(packageSpec)
    yield* validateIdentifier("adapter", installed.manifest.adapterId)
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
})

export const setProjectAdapter = Effect.fn("Client.setProjectAdapter")(function*(input: {
  readonly projectId: string
  readonly adapterId: string
  readonly enabled: boolean
}) {
  const store = yield* ClientConfigStore
  return yield* store.transact<LocalProject, ClientManagementError, never>((config) => Effect.gen(function*() {
    if (!config.adapters.some((adapter) => adapter.adapterId === input.adapterId)) {
      return yield* new ClientManagementError({
        reason: "not_found", resource: "adapter", message: `Adapter ${input.adapterId} is not installed.`
      })
    }
    const matches = config.projects.filter((item) => item.id === input.projectId)
    if (matches.length > 1) {
      return yield* new ClientManagementError({
        reason: "conflict", resource: "project",
        message: `Project ${input.projectId} exists on more than one Instance; select an Instance explicitly.`
      })
    }
    const project = matches[0]
    if (!project) {
      return yield* new ClientManagementError({
        reason: "not_found", resource: "project", message: `Project ${input.projectId} is not configured locally.`
      })
    }
    const adapterIds = input.enabled
      ? [...new Set([...project.adapterIds, input.adapterId])].sort()
      : project.adapterIds.filter((adapterId) => adapterId !== input.adapterId)
    if (sameStrings(project.adapterIds, adapterIds)) return { value: project }
    const updated: LocalProject = { ...project, adapterIds }
    return {
      value: updated,
      config: {
        ...config,
        projects: config.projects.map((item) => item.id === project.id ? updated : item)
      }
    }
  }))
})

export const upgradeAdapters = Effect.fn("Client.upgradeAdapters")(function*(target: string | "all") {
  const store = yield* ClientConfigStore
  const packages = yield* AdapterPackages
  const snapshot = yield* store.transact<ClientConfig, never, never>((config) => Effect.succeed({ value: config }))
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
    const updated = yield* store.transact<AdapterInstallation, ClientManagementError | AdapterPackageError, never>((config) => Effect.gen(function*() {
      const current = config.adapters.find((adapter) => adapter.adapterId === adapterId)
      if (!current) {
        return yield* new ClientManagementError({
          reason: "not_found", resource: "adapter", message: `Adapter ${adapterId} is no longer installed.`
        })
      }
      const packageSpec = current.upgradeSpec === current.packageName
        ? `${current.packageName}@latest`
        : current.upgradeSpec
      const installed = yield* packages.install(packageSpec)
      if (installed.packageName !== current.packageName || installed.manifest.adapterId !== current.adapterId) {
        return yield* new ClientManagementError({
          reason: "conflict",
          resource: "adapter",
          message: `Upgrade for ${current.adapterId} returned a different package or Adapter identity.`
        })
      }
      const next: AdapterInstallation = {
        ...current,
        displayName: installed.manifest.displayName,
        version: installed.version,
        updatedAt: new Date(yield* Clock.currentTimeMillis).toISOString()
      }
      return {
        value: next,
        config: {
          ...config,
          adapters: config.adapters.map((adapter) => adapter.adapterId === current.adapterId ? next : adapter)
        }
      }
    }))
    upgraded.push(updated)
  }
  return upgraded
})

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
