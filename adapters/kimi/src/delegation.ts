import { fail, id, object, timestamp, type Row, type snapshot } from "./source.ts"
import { backgroundReceipt, completedNotification } from "./background.ts"

type Source = Awaited<ReturnType<typeof snapshot>>
type Call = { uuid: string; args: Row; output: string; taskId?: string; terminal?: Row; notification?: Row }

/** Native receipts, metadata and exact delegated turns jointly establish ownership. */
export const delegation = (source: Source) => {
  const calls = new Map<string, Call[]>(), links = new Map<string, Map<string, string>>()
  const taskRows = new Map<Row, string>()
  const children = new Map(source.children.map(child => [child.id, child]))
  for (const parent of [{ id: "main", records: source.records }, ...source.children]) {
    const pending = new Map<string, Row>(), callChildren = new Map<string, string>()
    const tasks = new Map<string, { call: Call; childId: string; delivered: boolean }>()
    const starts = new Map<string, Row>()
    links.set(parent.id, callChildren)
    for (const { row } of parent.records) {
      if (children.size && (String(row.type).startsWith("full_compaction.") || ["context.undo", "context.apply_compaction", "forked"].includes(String(row.type))))
        fail("unsupported", "Kimi child history with compaction, undo or fork requires a wider source profile.")
      if (row.type === "task.started") {
        const info = object(row.info), taskId = id(info.taskId), call = [...pending.values()].find(call => call.toolCallId === info.parentToolCallId && !callChildren.has(String(call.uuid)))
        if (parent.id !== "main" || !call || object(call.args).run_in_background !== true || starts.has(taskId) || info.kind !== "agent" || info.detached !== true || info.status !== "running" || info.endedAt !== null || info.description !== object(call.args).description || timestamp(info.startedAt) !== timestamp(row.time))
          fail("unsupported", "Kimi background task start disagrees with its Agent call.")
        starts.set(taskId, row); taskRows.set(row, taskId)
      } else if (row.type === "task.terminated") {
        const info = object(row.info), taskId = id(info.taskId), task = tasks.get(taskId), start = object(starts.get(taskId)?.info)
        if (!task || task.call.terminal || info.status !== "completed" || timestamp(info.endedAt) < timestamp(start.startedAt) || timestamp(row.time) < timestamp(info.endedAt) ||
          JSON.stringify({ ...info, status: "running", endedAt: null }) !== JSON.stringify(start))
          fail("unsupported", "Kimi background task termination disagrees with its start.")
        task!.call.terminal = row; taskRows.set(row, taskId)
      } else if (row.type === "turn.prompt" && object(row.origin).kind === "task") {
        const taskId = id(object(row.origin).taskId), task = tasks.get(taskId)
        if (!task || !task.call.terminal || task.call.notification || timestamp(row.time) < timestamp(task.call.terminal.time)) fail("unsupported", "Kimi task notification has no unique completed background launch.")
        taskRows.set(row, completedNotification(row, { taskId, childId: task!.childId, description: task!.call.args.description }))
        task!.call.notification = row
      } else if (row.type === "context.append_message" && object(object(row.message).origin).kind === "task") {
        const message = object(row.message), task = tasks.get(id(object(message.origin).taskId)), prompt = task?.call.notification
        if (!task || !prompt || task.delivered || message.role !== "user" || message.id != null || !Array.isArray(message.toolCalls) || message.toolCalls.length ||
          JSON.stringify(message.origin) !== JSON.stringify(prompt.origin) || JSON.stringify(message.content) !== JSON.stringify(prompt.input))
          fail("unsupported", "Kimi task context has no unique matching notification prompt.")
        task!.delivered = true; taskRows.set(row, taskRows.get(prompt!)!)
      }
      if (row.type !== "context.append_loop_event") continue
      const event = object(row.event)
      if (event.type === "tool.call" && event.name === "Agent") {
        const uuid = id(event.uuid), args = object(event.args)
        if (pending.has(uuid) || typeof args.prompt !== "string" || args.run_in_background !== undefined && typeof args.run_in_background !== "boolean" || args.fork !== undefined && args.fork !== false || args.run_in_background === true && parent.id !== "main")
          fail("unsupported", "Kimi requires a unique supported Agent call.")
        pending.set(uuid, event)
      } else if (event.type === "tool.result" && pending.has(String(event.parentUuid))) {
        const uuid = id(event.parentUuid), call = pending.get(uuid)!, args = object(call.args), result = object(event.result)
        const background = args.run_in_background === true && typeof result.output === "string" ? backgroundReceipt(result.output, args.description) : undefined
        const receipt = background ? ["", background.childId, background.profile] : typeof result.output === "string" ? /^agent_id: (agent-[a-zA-Z0-9_-]+)\nactual_subagent_type: ([^\n]+)\nstatus: completed\nstop_reason: completed\n\n\[summary\]\n/.exec(result.output) : null
        if (!receipt || result.isError === true || event.toolCallId !== call.toolCallId || callChildren.has(uuid))
          fail("unsupported", "Kimi Agent has no unique supported native receipt.")
        const childId = receipt![1]!, profile = receipt![2]!, history = calls.get(childId) ?? []
        const labels = object(object(object(source.meta.agents)[childId]).labels)
        if (!children.has(childId) || labels.parentAgentId !== parent.id || labels.profileName !== profile ||
          args.subagent_type !== undefined && args.subagent_type !== profile ||
          (history.length ? args.resume !== childId || args.subagent_type !== undefined : args.resume != null))
          fail("unsupported", "Kimi Agent receipt disagrees with child metadata or resume identity.")
        const captured: Call = { uuid, args, output: result.output as string, ...(background ? { taskId: background.taskId } : {}) }
        if (background) {
          const info = object(starts.get(background.taskId)?.info)
          if (tasks.has(background.taskId) || info.agentId !== childId || info.subagentType !== profile || info.parentToolCallId !== call.toolCallId)
            fail("unsupported", "Kimi background task identity disagrees with its launch receipt.")
          tasks.set(background.taskId, { call: captured, childId, delivered: false })
        }
        history.push(captured); calls.set(childId, history); callChildren.set(uuid, childId)
      }
    }
    if (pending.size !== callChildren.size) fail("format", "Kimi Agent calls are incomplete; retry.")
    if (tasks.size !== starts.size || [...tasks.values()].some(task => !task.delivered)) fail("format", "Kimi background task has no completed notification in context; retry.")
  }
  if (calls.size !== children.size)
    fail("format", "Kimi Agent calls or declared child histories are incomplete; retry.")
  return { taskRows, callChildren: links.get("main")!, children: source.children.map(child => {
    const expected = calls.get(child.id)!, agentMeta = object(object(source.meta.agents)[child.id])
    if (expected.some(call => call.taskId) && links.get(child.id)!.size) fail("unsupported", "Kimi background children combined with nested delegation require a wider profile.")
    let turn = 0, active = false, answer = ""
    for (const { row } of child.records) {
      if (String(row.type).startsWith("full_compaction.") || ["context.undo", "context.apply_compaction", "forked"].includes(String(row.type)))
        fail("unsupported", "Kimi child context operations require a wider source profile.")
      if (row.type === "turn.prompt") {
        const call = expected[turn], origin = object(row.origin)
        if (active || !call || origin.kind !== "system_trigger" || origin.name !== "subagent" ||
          JSON.stringify(row.input) !== JSON.stringify([{ type: "text", text: call.args.prompt }]))
          fail("unsupported", "Kimi child prompt disagrees with its parent delegation.")
        active = true; answer = ""
      } else if (row.type === "context.append_loop_event") {
        const event = object(row.event)
        if (event.type === "step.begin") answer = ""
        if (event.type === "content.part" && object(event.part).type === "text") answer += String(object(event.part).text)
        if (event.type === "tool.call" && event.name === "AgentSwarm")
          fail("unsupported", "Kimi AgentSwarm requires a wider source profile.")
      } else if (row.type === "turn.ended") {
        const call = expected[turn], profile = object(agentMeta.labels).profileName
        const receipt = `agent_id: ${child.id}\nactual_subagent_type: ${profile}\nstatus: completed\nstop_reason: completed\n\n[summary]\n${answer}\n\nresume_hint: Continue with Agent(resume="${child.id}", prompt="..."). Use agent_id only; do not set subagent_type. The subagent retains its prior context; redo any unfinished tool call if its result was lost.`
        if (!active || !call || row.reason !== "completed" || !answer || (call.taskId ? !call.terminal || timestamp(row.time) > timestamp(object(call.terminal.info).endedAt) : call.output !== receipt))
          fail("format", "Kimi child completion disagrees with its parent receipt; retry.")
        if (call!.taskId && call!.terminal!.outputTail !== undefined) {
          const bytes = Buffer.from(answer, "utf8")
          if (call!.terminal!.outputTail !== bytes.subarray(Math.max(0, bytes.length - 4096)).toString("utf8"))
            fail("format", "Kimi background output tail disagrees with the child answer; retry.")
        }
        active = false; turn++
      }
    }
    if (active || turn !== expected.length) fail("format", "Kimi delegated turns are incomplete; retry.")
    const description = expected[0]!.args.description
    const label = typeof description === "string" && description && Buffer.byteLength(description) <= 200 ? description : "Kimi child"
    return { ...child, label, parentId: id(object(agentMeta.labels).parentAgentId), callChildren: links.get(child.id)! }
  }) }
}
