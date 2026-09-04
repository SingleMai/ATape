import { Schema } from "effect"

export const ClientConfigVersion = 1 as const
export const AdapterProtocolVersion = "atape.adapter.v1alpha1" as const

export const LocalProject = Schema.Struct({
  id: Schema.String,
  teamId: Schema.String,
  teamName: Schema.String,
  name: Schema.String,
  type: Schema.Literals(["git", "directory"]),
  path: Schema.String,
  adapterIds: Schema.Array(Schema.String),
  createdAt: Schema.String
})
export type LocalProject = typeof LocalProject.Type

export const AdapterInstallation = Schema.Struct({
  adapterId: Schema.String,
  packageName: Schema.String,
  upgradeSpec: Schema.String,
  displayName: Schema.String,
  version: Schema.String,
  installedAt: Schema.String,
  updatedAt: Schema.String
})
export type AdapterInstallation = typeof AdapterInstallation.Type

export const ClientConfig = Schema.Struct({
  version: Schema.Literal(ClientConfigVersion),
  serverUrl: Schema.String,
  userId: Schema.optionalKey(Schema.String),
  projects: Schema.Array(LocalProject),
  adapters: Schema.Array(AdapterInstallation)
})
export type ClientConfig = typeof ClientConfig.Type

export const AdapterManifest = Schema.Struct({
  protocolVersion: Schema.Literal(AdapterProtocolVersion),
  adapterId: Schema.String,
  displayName: Schema.String,
  entry: Schema.String,
  harnesses: Schema.Array(Schema.String)
})
export type AdapterManifest = typeof AdapterManifest.Type

export const emptyClientConfig = (): ClientConfig => ({
  version: ClientConfigVersion,
  serverUrl: "http://127.0.0.1:8080",
  projects: [],
  adapters: []
})
