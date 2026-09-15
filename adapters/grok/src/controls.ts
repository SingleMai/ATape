import { fail, id, object, time, type Row } from "./source.ts"

const count = (v: unknown) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail("format", "Grok control counter is invalid.")
  return v as number
}
export const updateOf = (row: Row) => object(object(row.params).update)
export const emptyBackground = (row: Row) => {
  const update = updateOf(row)
  if (row.method !== "_x.ai/session/update" || update.sessionUpdate !== "background_tasks" || !Array.isArray(update.tasks) || update.tasks.length)
    fail("unsupported", "Grok active background tasks require a wider native profile.")
}
export const retryTelemetry = (row: Row) => {
  const update = updateOf(row)
  if (row.method !== "_x.ai/session/update" || update.type !== "retrying" || update.error_type !== "rate_limited" ||
    count(update.attempt) < 1 || count(update.max_retries) < count(update.attempt) || typeof update.reason !== "string")
    fail("unsupported", "Grok retry telemetry requires a wider native profile.")
}

/** Manual host commands are persisted after their checkpoint notifications.
 * Their native prompt index does not advance the model-turn sequence. Never
 * open checkpoint_file: the conversation log remains the source of history.
 */
export const compactionTurn = (rows: readonly Row[], modelTurns: number): "completed" | "failed" | undefined => {
  const updates = rows.map(updateOf)
  const host = updates.find(update => object(update._meta).hostTurn === true)
  if (!host) return undefined
  if (host.sessionUpdate !== "user_message_chunk" || object(host.content).type !== "text" ||
    typeof object(host.content).text !== "string" || !/^\/compact(?:\s|$)/.test(object(host.content).text as string) || object(host._meta).promptIndex !== undefined)
    fail("unsupported", "Grok host command requires a wider native profile.")
  const at = rows.map(row => count(object(object(row.params)._meta).agentTimestampMs))
  const terminal = updates.at(-1)!
  if (terminal.usage !== undefined) fail("unsupported", "Grok host command has unexpected model usage.")
  if (rows.length === 2 && updates[0] === host && terminal.stop_reason === "error" && typeof terminal.agent_result === "string" && terminal.agent_result.length > 0 && at[0]! <= at[1]!)
    return "failed"
  if (rows.length !== 4 || updates[2] !== host || terminal.stop_reason !== "end_turn" ||
    updates[0]!.sessionUpdate !== "compaction_checkpoint" || updates[1]!.sessionUpdate !== "auto_compact_completed" ||
    rows[0]!.method !== "_x.ai/session/update" || rows[1]!.method !== "_x.ai/session/update")
    fail("unsupported", "Grok manual compaction has an incomplete or unsupported control sequence.")
  const checkpoint = updates[0]!, completed = updates[1]!, checkpointId = id(checkpoint.checkpoint_id)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(checkpointId) || checkpoint.schema_version !== 1 || checkpoint.prompt_index_at_compaction !== modelTurns ||
    checkpoint.checkpoint_file !== `compaction_checkpoints/${checkpointId}.json` || completed.summary_preview !== null)
    fail("unsupported", "Grok compaction checkpoint has an unsupported identity or summary profile.")
  if (Date.parse(time(checkpoint.created_at)) !== at[0] || at[2]! > at[0]! || at[0]! > at[1]! || at[1]! > at[3]!)
    fail("unsupported", "Grok compaction crosses its native command boundary.")
  count(completed.tokens_before); count(completed.tokens_after)
  return "completed"
}
