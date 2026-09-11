import { Schema } from "effect"

export const ClientConfigVersion = 3 as const
export const AdapterProtocolVersion = "atape.adapter.v1alpha1" as const
export const SourceCaptureVersion = "atape.source-capture.v1" as const
export const GitAttributionVersion = "atape.git-attribution.v1" as const

export const ProjectRegistration = Schema.Struct({
  id: Schema.String,
  instanceOrigin: Schema.String,
  userId: Schema.String,
  teamId: Schema.String,
  teamSlug: Schema.String,
  teamName: Schema.String,
  name: Schema.String,
  type: Schema.Literals(["git", "directory"]),
  path: Schema.String,
  repositoryRemote: Schema.optionalKey(Schema.String),
  repositoryIdentity: Schema.optionalKey(Schema.String),
  createdAt: Schema.String
})
export type ProjectRegistration = typeof ProjectRegistration.Type

// Effective collection view; tool selection is never persisted on a Project.
export const LocalProject = Schema.Struct({
  ...ProjectRegistration.fields,
  adapterIds: Schema.Array(Schema.String)
})
export type LocalProject = typeof LocalProject.Type

export const AdapterInstallation = Schema.Struct({
  adapterId: Schema.String,
  packageName: Schema.String,
  packageSlot: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))),
  upgradeSpec: Schema.String,
  displayName: Schema.String,
  version: Schema.String,
  installedAt: Schema.String,
  updatedAt: Schema.String
})
export type AdapterInstallation = typeof AdapterInstallation.Type

export const ClientConfig = Schema.Struct({
  version: Schema.Literal(ClientConfigVersion),
  locale: Schema.optionalKey(Schema.String),
  activeInstanceOrigin: Schema.optionalKey(Schema.String),
  projects: Schema.Array(ProjectRegistration),
  adapters: Schema.Array(AdapterInstallation),
  toolsConfigured: Schema.Boolean,
  enabledAdapterIds: Schema.Array(Schema.String)
})
export type ClientConfig = typeof ClientConfig.Type

export const AdapterManifest = Schema.Struct({
  protocolVersion: Schema.Literal(AdapterProtocolVersion),
  adapterId: Schema.String,
  displayName: Schema.String,
  entry: Schema.String,
  harnesses: Schema.Array(Schema.String),
  gitAttribution: Schema.optionalKey(Schema.Literal(GitAttributionVersion)),
  rawCapturePolicy: Schema.optionalKey(Schema.Literal("atape.raw-capture.v1")),
  sourceCapture: Schema.optionalKey(Schema.Literal(SourceCaptureVersion))
})
export type AdapterManifest = typeof AdapterManifest.Type

export const emptyClientConfig = (): ClientConfig => ({
  version: ClientConfigVersion,
  projects: [],
  adapters: [],
  toolsConfigured: false,
  enabledAdapterIds: []
})
