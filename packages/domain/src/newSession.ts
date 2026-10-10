import { Schema } from "effect"
import { NewSessionVersion } from "./client.ts"
import { GitSource } from "./collector.ts"

export const CreationReceiptVersion = "atape.creation-receipt.v1" as const
const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max), Schema.isPattern(/^[^\0]+$/))
const path = text(4096).check(Schema.isPattern(/^\//))
export const CreationReceiptPrefix = Schema.Struct({
  bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(64 * 1024 * 1024)),
  rows: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1_000_000)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
})
export type CreationReceiptPrefix = typeof CreationReceiptPrefix.Type
export const CreationReceiptAttemptInput = Schema.Struct({
  sourceId: text(200), stateDirectory: path, profile: text(200), sourcePath: path
})
export type CreationReceiptAttemptInput = typeof CreationReceiptAttemptInput.Type
export const CreationReceiptAttempt = Schema.Struct({
  protocolVersion: Schema.Literal(CreationReceiptVersion),
  attemptId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)),
  adapterId: text(200), ...CreationReceiptAttemptInput.fields,
  origin: Schema.Struct({ ...GitSource.fields, sourceId: text(200), originKey: text(200), cwd: path,
    repositoryRemote: Schema.optionalKey(text(4096).check(Schema.isPattern(/^[^\r\n\0]+$/))) }),
  recordedAt: text(64)
})
export type CreationReceiptAttempt = typeof CreationReceiptAttempt.Type
export const ConfirmedCreationReceipt = Schema.Struct({
  ...CreationReceiptAttempt.fields, confirmedAt: text(64), prefix: CreationReceiptPrefix
})
export type ConfirmedCreationReceipt = typeof ConfirmedCreationReceipt.Type
export type CreationReceiptReader = {
  readonly readConfirmed: (input: { readonly stateDirectory: string; readonly sourceId: string }, signal: AbortSignal) => Promise<ConfirmedCreationReceipt | undefined>
}
export type NewSessionStartRequest = {
  readonly origin: { readonly cwd: string; readonly repositoryRemote?: string }
  readonly initialPrompt?: string
  readonly signal: AbortSignal
  readonly creation: {
    readonly recordAttempt: (input: CreationReceiptAttemptInput, signal: AbortSignal) => Promise<CreationReceiptAttempt>
    readonly confirm: (input: { readonly prefix: CreationReceiptPrefix }, signal: AbortSignal) => Promise<ConfirmedCreationReceipt>
    readonly abandon: (signal: AbortSignal) => Promise<void>
  }
}
export const NewSessionResult = Schema.Struct({
  sourceId: text(200), creation: Schema.Literals(["confirmed", "unconfirmed"]),
  exitCode: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(255))
})
export type NewSessionResult = typeof NewSessionResult.Type
export type NewSessionRuntime = {
  readonly protocolVersion: typeof NewSessionVersion
  readonly start: (request: NewSessionStartRequest) => unknown | PromiseLike<unknown>
}
