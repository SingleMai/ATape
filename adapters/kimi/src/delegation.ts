import { fail, id, object, type Row, type snapshot } from "./source.ts"

type Source = Awaited<ReturnType<typeof snapshot>>
type Call = { uuid: string; args: Row; output: string }

/** Native receipts, metadata and exact delegated turns jointly establish ownership. */
export const delegation = (source: Source) => {
  const pending = new Map<string, Row>(), calls = new Map<string, Call[]>(), callChildren = new Map<string, string>()
  const children = new Map(source.children.map(child => [child.id, child]))
  for (const { row } of source.records) {
    if (children.size && (String(row.type).startsWith("full_compaction.") || ["context.undo", "context.apply_compaction", "forked"].includes(String(row.type))))
      fail("unsupported", "Kimi child history with compaction, undo or fork requires a wider source profile.")
    if (row.type !== "context.append_loop_event") continue
    const event = object(row.event)
    if (event.type === "tool.call" && event.name === "Agent") {
      const uuid = id(event.uuid), args = object(event.args)
      if (pending.has(uuid) || typeof args.prompt !== "string" || args.run_in_background !== undefined && args.run_in_background !== false || args.fork !== undefined && args.fork !== false)
        fail("unsupported", "Kimi requires a unique foreground Agent call.")
      pending.set(uuid, event)
    } else if (event.type === "tool.result" && pending.has(String(event.parentUuid))) {
      const uuid = id(event.parentUuid), call = pending.get(uuid)!, args = object(call.args), result = object(event.result)
      const receipt = typeof result.output === "string" ? /^agent_id: (agent-[a-zA-Z0-9_-]+)\nactual_subagent_type: ([^\n]+)\nstatus: completed\nstop_reason: completed\n\n\[summary\]\n/.exec(result.output) : null
      if (!receipt || result.isError === true || event.toolCallId !== call.toolCallId || callChildren.has(uuid))
        fail("unsupported", "Kimi Agent has no unique completed native receipt.")
      const childId = receipt![1]!, profile = receipt![2]!, history = calls.get(childId) ?? []
      if (!children.has(childId) || object(object(object(source.meta.agents)[childId]).labels).profileName !== profile ||
        args.subagent_type !== undefined && args.subagent_type !== profile ||
        (history.length ? args.resume !== childId || args.subagent_type !== undefined : args.resume != null))
        fail("unsupported", "Kimi Agent receipt disagrees with child metadata or resume identity.")
      history.push({ uuid, args, output: result.output as string }); calls.set(childId, history); callChildren.set(uuid, childId)
    }
  }
  if (pending.size !== callChildren.size || calls.size !== children.size)
    fail("format", "Kimi Agent calls or declared child histories are incomplete; retry.")
  return { callChildren, children: source.children.map(child => {
    const expected = calls.get(child.id)!, agentMeta = object(object(source.meta.agents)[child.id])
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
        if (event.type === "tool.call" && ["Agent", "AgentSwarm"].includes(String(event.name)))
          fail("unsupported", "Kimi nested delegation requires a wider source profile.")
      } else if (row.type === "turn.ended") {
        const call = expected[turn], profile = object(agentMeta.labels).profileName
        const receipt = `agent_id: ${child.id}\nactual_subagent_type: ${profile}\nstatus: completed\nstop_reason: completed\n\n[summary]\n${answer}\n\nresume_hint: Continue with Agent(resume="${child.id}", prompt="..."). Use agent_id only; do not set subagent_type. The subagent retains its prior context; redo any unfinished tool call if its result was lost.`
        if (!active || !call || row.reason !== "completed" || !answer || call.output !== receipt)
          fail("format", "Kimi child completion disagrees with its parent receipt; retry.")
        active = false; turn++
      }
    }
    if (active || turn !== expected.length) fail("format", "Kimi delegated turns are incomplete; retry.")
    const description = expected[0]!.args.description
    const label = typeof description === "string" && description && Buffer.byteLength(description) <= 200 ? description : "Kimi child"
    return { ...child, label }
  }) }
}
