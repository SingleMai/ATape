import { fail, object, type Row } from "./source.ts"

/** Launch receipts identify tasks; file paths in completion notices are Raw only. */
export const backgroundReceipt = (output: string, description: unknown) => {
  const match = /^task_id: (agent-[a-z0-9]{8})\nstatus: running\nagent_id: (agent-[a-zA-Z0-9_-]+)\nactual_subagent_type: ([^\n]+)\nautomatic_notification: true\n/.exec(output)
  if (!match || typeof description !== "string") fail("unsupported", "Kimi background Agent lacks its native launch receipt.")
  const [, taskId, childId, profile] = match!
  const expected = `task_id: ${taskId}\nstatus: running\nagent_id: ${childId}\nactual_subagent_type: ${profile}\nautomatic_notification: true\n\ndescription: ${description}\n\nnext_step: The completion arrives automatically in a later turn — do NOT wait, poll, or call TaskOutput on it; continue with other work or hand back to the user. (If you have nothing to do until it finishes, run such tasks in the foreground next time.)\nresume_hint: To continue or recover this same subagent later, call Agent(resume="${childId}", prompt="..."). The parameter is agent_id ("${childId}"), NOT task_id ("${taskId}") or source_id from a later <notification>. Recovery cases: a later <notification type="task.lost" | "task.failed" | "task.killed"> for this subagent — its conversation history is preserved across session restarts and resume will pick it up.`
  if (output !== expected) fail("unsupported", "Kimi background launch receipt has an unsupported format.")
  return { taskId: taskId!, childId: childId!, profile: profile! }
}

export const completedNotification = (row: Row, task: { taskId: string; childId: string; description: unknown }) => {
  const origin = object(row.origin), notificationId = `task:${task.taskId}:completed`
  if (origin.kind !== "task" || origin.taskId !== task.taskId || origin.status !== "completed" || origin.notificationId !== notificationId || row.promptId != null)
    fail("unsupported", "Kimi background notification has no matching completed task identity.")
  const parts = row.input, part = Array.isArray(parts) && parts.length === 1 ? object(parts[0]) : {}
  const prefix = `<notification id="${notificationId}" category="task" type="task.completed" source_kind="background_task" source_id="${task.taskId}" agent_id="${task.childId}">\nTitle: Background agent completed\nSeverity: info\n${task.description} completed.\n`
  if (part.type !== "text" || typeof part.text !== "string" || !part.text.startsWith(prefix) || !part.text.endsWith("\n</notification>"))
    fail("unsupported", "Kimi completion notification disagrees with its native launch.")
  return notificationId
}
