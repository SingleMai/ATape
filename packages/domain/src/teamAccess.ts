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
const TeamSlug = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(63),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
)
const TeamJoinCode = Schema.String.check(
  Schema.isPattern(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
)

export const TeamRole = Schema.Literals(["owner", "member"])
export type TeamRole = typeof TeamRole.Type

export const Team = Schema.Struct({
  id: OpaqueIdentifier,
  slug: TeamSlug,
  displayName: DisplayText,
  membership: Schema.Struct({ role: TeamRole }),
  createdAt: Timestamp,
  updatedAt: Timestamp
})
export type Team = typeof Team.Type

export const TeamMember = Schema.Struct({
  userId: OpaqueIdentifier,
  displayName: DisplayText,
  avatarUrl: Schema.String.check(Schema.isMaxLength(2_048)),
  role: TeamRole,
  joinedAt: Timestamp,
  updatedAt: Timestamp
})
export type TeamMember = typeof TeamMember.Type

export const JoinCodeStatus = Schema.Struct({
  enabled: Schema.Boolean,
  generation: Schema.Natural,
  updatedAt: Timestamp
})
export type JoinCodeStatus = typeof JoinCodeStatus.Type

export const JoinCodeGrant = Schema.Struct({
  code: TeamJoinCode,
  generation: Schema.Natural,
  rotatedAt: Timestamp
})
export type JoinCodeGrant = typeof JoinCodeGrant.Type

export const normalizeTeamJoinCode = (input: string): string | undefined => {
  const normalized = input.trim().toUpperCase().replaceAll(" ", "")
  return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(normalized) ? normalized : undefined
}

export const slugifyTeamName = (input: string): string => input
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 63)

export const validTeamSlug = (input: string): boolean =>
  input.length >= 2 && input.length <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input)
