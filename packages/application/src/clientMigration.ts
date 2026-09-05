import type { CollectorCheckpoint, CollectorRawObjectProgress } from "@atape/domain"
import { Clock, Context, Effect, Schema } from "effect"
import { ClientConfigStore, inspectClient } from "./clientManagement.ts"
import { CollectorStateStore } from "./collector.ts"

export class ClientMigrationError extends Schema.TaggedError<ClientMigrationError>()("ClientMigrationError", {
  reason: Schema.Literals(["not_found", "conflict", "collector_running", "unsafe", "io"]),
  message: Schema.String
}) {}

export type LegacyMigrationSource = {
  readonly kind: "config" | "collector_state" | "collector_process" | "collector_status" | "collector_log" | "adapters"
  readonly path: string
}

export type ClientMigrationPlan = {
  readonly version: "atape.local-migration.v1"
  readonly destinationRoot: string
  readonly sources: ReadonlyArray<LegacyMigrationSource>
  readonly canApply: boolean
  readonly blockers: ReadonlyArray<string>
  readonly discardedAuthority: ReadonlyArray<string>
  readonly unresolved: ReadonlyArray<string>
}

export type ClientMigrationResult = ClientMigrationPlan & {
  readonly applied: true
  readonly importDirectory: string
  readonly createdConfig: string
}

export type LegacyCollectorCheckpoint = {
  readonly projectId: string
  readonly projectCreatedAt: string
  readonly adapterId: string
  readonly adapterVersion: string
  readonly revision: number
  readonly cursor: string | null
  readonly rawObjects: ReadonlyArray<CollectorRawObjectProgress>
  readonly updatedAt: string
}

// Filesystem discovery/copying differs by host and is intentionally hidden
// behind one migration Seam. Callers see the safety plan, not legacy layouts.
export class ClientMigration extends Context.Service<ClientMigration, {
  plan(): Effect.Effect<ClientMigrationPlan, ClientMigrationError>
  apply(): Effect.Effect<ClientMigrationResult, ClientMigrationError>
  readCheckpoint(input: {
    readonly importId: string
    readonly projectId: string
    readonly adapterId: string
  }): Effect.Effect<LegacyCollectorCheckpoint, ClientMigrationError>
}>()("atape/application/ClientMigration") {}

export const planClientMigration = Effect.fn("ClientMigration.plan")(function*() {
  return yield* (yield* ClientMigration).plan()
})

export const applyClientMigration = Effect.fn("ClientMigration.apply")(function*() {
  return yield* (yield* ClientMigration).apply()
})

export const adoptClientCheckpoint = Effect.fn("ClientMigration.adoptCheckpoint")(function*(input: {
  readonly importId: string
  readonly projectId: string
  readonly adapterId: string
  readonly sourceProjectId?: string
  readonly sourceAdapterId?: string
}) {
  const config = yield* inspectClient()
  const projects = config.projects.filter((project) => project.id === input.projectId)
  if (projects.length !== 1) {
    return yield* new ClientMigrationError({
      reason: projects.length === 0 ? "not_found" : "conflict",
      message: projects.length === 0
        ? `Local Project ${input.projectId} is not configured.`
        : `Project ${input.projectId} exists on multiple Instances and is ambiguous.`
    })
  }
  const project = projects[0]
  if (project === undefined || !project.adapterIds.includes(input.adapterId) ||
    !config.adapters.some((adapter) => adapter.adapterId === input.adapterId)) {
    return yield* new ClientMigrationError({
      reason: "conflict",
      message: `Adapter ${input.adapterId} must be installed and enabled for Project ${input.projectId}.`
    })
  }
  const migration = yield* ClientMigration
  const legacy = yield* migration.readCheckpoint({
    importId: input.importId,
    projectId: input.sourceProjectId ?? input.projectId,
    adapterId: input.sourceAdapterId ?? input.adapterId
  })
  const adoptedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
  const checkpoint: CollectorCheckpoint = {
    ...legacy,
    instanceOrigin: project.instanceOrigin,
    userId: project.userId,
    projectId: project.id,
    projectCreatedAt: project.createdAt,
    adapterId: input.adapterId,
    revision: 1,
    updatedAt: adoptedAt
  }
  const states = yield* CollectorStateStore
  yield* states.commit({
    instanceOrigin: project.instanceOrigin,
    userId: project.userId,
    projectId: project.id,
    adapterId: input.adapterId,
    expectedRevision: 0,
    checkpoint
  })
  return {
    importId: input.importId,
    source: { projectId: legacy.projectId, adapterId: legacy.adapterId },
    target: {
      instanceOrigin: project.instanceOrigin,
      userId: project.userId,
      projectId: project.id,
      adapterId: input.adapterId
    },
    sourceRevision: legacy.revision,
    revision: checkpoint.revision
  }
})

export type ClientCheckpointAdoptionRequirements = ClientMigration | ClientConfigStore | CollectorStateStore
