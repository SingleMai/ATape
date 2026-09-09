import { Context, Effect, Schema } from "effect"
import { AccessError } from "./access.ts"

export const RawCapturePolicy = Schema.Literals(["force", "personal", "close"])
export type RawCapturePolicy = typeof RawCapturePolicy.Type
export const RawCapturePreference = Schema.Literals(["enable", "disable"])
export type RawCapturePreference = typeof RawCapturePreference.Type
export const RawCaptureSettings = Schema.Struct({
  teamPolicy: RawCapturePolicy, userPreference: RawCapturePreference, enabled: Schema.Boolean
})
export class RawCaptureGateway extends Context.Service<RawCaptureGateway, {
  readTeam(slug: string): Effect.Effect<typeof RawCaptureSettings.Type, AccessError>
  setTeam(slug: string, policy: RawCapturePolicy): Effect.Effect<typeof RawCaptureSettings.Type, AccessError>
  readUser(): Effect.Effect<{ readonly preference: RawCapturePreference }, AccessError>
  setUser(preference: RawCapturePreference): Effect.Effect<{ readonly preference: RawCapturePreference }, AccessError>
}>()("atape/application/RawCaptureGateway") {}

export const loadTeamRawCapture = Effect.fn("RawCapture.loadTeam")(function*(slug: string) {
  return yield* (yield* RawCaptureGateway).readTeam(slug)
})
export const setTeamRawCapture = Effect.fn("RawCapture.setTeam")(function*(slug: string, policy: RawCapturePolicy) {
  return yield* (yield* RawCaptureGateway).setTeam(slug, policy)
})
export const loadUserRawCapture = Effect.fn("RawCapture.loadUser")(function*() {
  return yield* (yield* RawCaptureGateway).readUser()
})
export const setUserRawCapture = Effect.fn("RawCapture.setUser")(function*(preference: RawCapturePreference) {
  return yield* (yield* RawCaptureGateway).setUser(preference)
})
