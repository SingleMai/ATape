import { Schema } from "effect"

export const CLIAuthorizationProtocol = "atape.cli-authorization.v1" as const
export const CLICapabilityVersion = "atape-cli.v1" as const
export const CLICredentialFileVersion = 1 as const
export const DefaultInstanceOrigin = "https://atape.dev" as const

const OpaqueIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/)
)
const Timestamp = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))
const OriginText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_048))
const DisplayText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[^\r\n\u0000]+$/)
)

export const CLIDeviceAuthorization = Schema.Struct({
  protocol: Schema.Literal(CLIAuthorizationProtocol),
  deviceCode: Schema.String.check(
    Schema.isMinLength(8),
    Schema.isMaxLength(512),
    Schema.isPattern(/^atd_v1_[A-Za-z0-9_-]+$/)
  ),
  userCode: Schema.String.check(
    Schema.isPattern(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
  ),
  verificationUri: OriginText,
  verificationUriComplete: OriginText,
  expiresInSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
  intervalSeconds: Schema.Int.check(Schema.isGreaterThan(0))
})
export type CLIDeviceAuthorization = typeof CLIDeviceAuthorization.Type

export const CLIIdentity = Schema.Struct({
  id: OpaqueIdentifier,
  displayName: DisplayText
})
export type CLIIdentity = typeof CLIIdentity.Type

export const IssuedCLICredential = Schema.Struct({
  tokenType: Schema.Literal("Bearer"),
  credential: Schema.String.check(
    Schema.isMinLength(8),
    Schema.isMaxLength(512),
    Schema.isPattern(/^atc_v1_[A-Za-z0-9_-]+$/)
  ),
  credentialId: OpaqueIdentifier,
  capabilityVersion: Schema.Literal(CLICapabilityVersion),
  createdAt: Timestamp,
  user: CLIIdentity
})
export type IssuedCLICredential = typeof IssuedCLICredential.Type

export const StoredCLICredential = Schema.Struct({
  version: Schema.Literal(CLICredentialFileVersion),
  instanceOrigin: OriginText,
  apiOrigin: OriginText,
  credential: Schema.String.check(
    Schema.isMinLength(8),
    Schema.isMaxLength(512),
    Schema.isPattern(/^atc_v1_[A-Za-z0-9_-]+$/)
  ),
  credentialId: OpaqueIdentifier,
  capabilityVersion: Schema.Literal(CLICapabilityVersion),
  createdAt: Timestamp,
  user: CLIIdentity
})
export type StoredCLICredential = typeof StoredCLICredential.Type

export type InstanceOriginPolicy = {
  readonly allowLoopbackHttp: boolean
}

export type NormalizedInstanceTopology = {
  readonly instanceOrigin: string
  readonly webOrigin: string
  readonly apiOrigin: string
}

/**
 * Normalizes a user-selected Instance to an origin. Production Instances are
 * HTTPS-only. Plain HTTP is deliberately limited to an explicitly enabled,
 * entirely loopback development topology.
 */
export const normalizeInstanceOrigin = (
  input: string,
  policy: InstanceOriginPolicy = { allowLoopbackHttp: false }
): string | undefined => normalizeOrigin(input, policy)

export const normalizeInstanceTopology = (
  input: NormalizedInstanceTopology,
  policy: InstanceOriginPolicy = { allowLoopbackHttp: false }
): NormalizedInstanceTopology | undefined => {
  const instanceOrigin = normalizeOrigin(input.instanceOrigin, policy)
  const webOrigin = normalizeOrigin(input.webOrigin, policy)
  const apiOrigin = normalizeOrigin(input.apiOrigin, policy)
  if (instanceOrigin === undefined || webOrigin === undefined || apiOrigin === undefined) return undefined
  if (instanceOrigin !== webOrigin) return undefined
  if (instanceOrigin.startsWith("http:") &&
    (!isLoopbackOrigin(instanceOrigin) || !isLoopbackOrigin(webOrigin) || !isLoopbackOrigin(apiOrigin))) {
    return undefined
  }
  return { instanceOrigin, webOrigin, apiOrigin }
}

const normalizeOrigin = (input: string, policy: InstanceOriginPolicy): string | undefined => {
  try {
    if (input.trim() !== input || input === "") return undefined
    const parsed = new URL(input)
    if (parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" ||
      parsed.search !== "" || parsed.hash !== "") return undefined
    if (parsed.protocol === "https:") return parsed.origin
    if (parsed.protocol === "http:" && policy.allowLoopbackHttp && isLoopbackHostname(parsed.hostname)) {
      return parsed.origin
    }
    return undefined
  } catch {
    return undefined
  }
}

const isLoopbackOrigin = (input: string): boolean => {
  try {
    return isLoopbackHostname(new URL(input).hostname)
  } catch {
    return false
  }
}

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (normalized === "localhost" || normalized === "::1") return true
  const parts = normalized.split(".")
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part)) && Number(parts[0]) === 127 &&
    parts.every((part) => Number(part) <= 255)
}
