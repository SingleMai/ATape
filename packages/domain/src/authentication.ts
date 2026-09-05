import { Schema } from "effect"

const OpaqueIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/)
)
const DisplayText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[^\r\n\u0000]+$/)
)
const Timestamp = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
const URIText = Schema.String.check(Schema.isMaxLength(2_048))

export const User = Schema.Struct({
  id: OpaqueIdentifier,
  displayName: DisplayText,
  avatarUrl: URIText
})
export type User = typeof User.Type

export const ProviderRegistration = Schema.Struct({
  id: OpaqueIdentifier,
  label: DisplayText
})
export type ProviderRegistration = typeof ProviderRegistration.Type

export const InstanceMetadata = Schema.Struct({
  protocol: Schema.Literal("atape.instance.v1"),
  instanceOrigin: URIText,
  webOrigin: URIText,
  apiOrigin: URIText,
  protocols: Schema.Array(OpaqueIdentifier),
  releaseVersion: OpaqueIdentifier,
  authEpoch: Schema.Literal("auth-v1"),
  minimumCliVersion: OpaqueIdentifier
})
export type InstanceMetadata = typeof InstanceMetadata.Type

export const WebSession = Schema.Struct({
  id: OpaqueIdentifier,
  createdAt: Timestamp,
  lastUsedAt: Timestamp,
  reauthenticatedAt: Timestamp,
  absoluteExpiresAt: Timestamp,
  current: Schema.optionalKey(Schema.Boolean)
})
export type WebSession = typeof WebSession.Type

export const AuthenticatedSession = Schema.Struct({
  user: User,
  webSession: WebSession
})
export type AuthenticatedSession = typeof AuthenticatedSession.Type

export const ExternalIdentity = Schema.Struct({
  id: OpaqueIdentifier,
  providerRegistrationId: OpaqueIdentifier,
  displayName: DisplayText,
  avatarUrl: URIText,
  createdAt: Timestamp,
  lastVerifiedAt: Timestamp
})
export type ExternalIdentity = typeof ExternalIdentity.Type

export const CLICredential = Schema.Struct({
  id: OpaqueIdentifier,
  capability: Schema.Literal("atape-cli.v1"),
  createdAt: Timestamp,
  lastUsedAt: Timestamp
})
export type CLICredential = typeof CLICredential.Type

export const CLIDeviceGrantStatus = Schema.Literals([
  "pending",
  "approved_unclaimed",
  "denied",
  "expired",
  "claimed"
])
export type CLIDeviceGrantStatus = typeof CLIDeviceGrantStatus.Type

export const CLIDeviceGrantView = Schema.Struct({
  grantViewId: OpaqueIdentifier,
  userCode: Schema.String.check(Schema.isPattern(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)),
  instanceOrigin: URIText,
  clientLabel: Schema.Literal("atape-cli"),
  capabilityVersion: Schema.Literal("atape-cli.v1"),
  permissionSummary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  expiresAt: Timestamp,
  status: CLIDeviceGrantStatus
})
export type CLIDeviceGrantView = typeof CLIDeviceGrantView.Type

export type SignInOptions = {
  readonly instance: InstanceMetadata
  readonly providers: ReadonlyArray<ProviderRegistration>
}

export const safeLocalReturnTo = (input: string | undefined, fallback = "/"): string => {
  if (input === undefined || input.length === 0 || input.length > 2_048 ||
    !input.startsWith("/") || input.startsWith("//") || /[\\\r\n\0]/.test(input)) {
    return fallback
  }
  try {
    const parsed = new URL(input, "https://atape.invalid")
    if (parsed.origin !== "https://atape.invalid" || parsed.hash !== "" || parsed.pathname === "" ||
      parsed.pathname.startsWith("//") || /[\\\r\n\0]/.test(parsed.pathname)) {
      return fallback
    }
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return fallback
  }
}

const deviceCodeAlphabet = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/

export const normalizeDeviceUserCode = (input: string): string | undefined => {
  const compact = input.trim().toUpperCase().replaceAll(" ", "")
  return deviceCodeAlphabet.test(compact) ? compact : undefined
}

export const safeAuthorizationURI = (input: string): string | undefined => {
  try {
    const parsed = new URL(input)
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return undefined
    return parsed.href
  } catch {
    return undefined
  }
}
