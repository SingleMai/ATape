import type { Actor, CanonicalEvent, Conversation } from "./memory.ts"

export type NarrativeExchange = {
  readonly id: string
  readonly basis: "user_message" | "thread_start"
  readonly prompt?: CanonicalEvent
  readonly primaryResponse?: CanonicalEvent
  readonly activity: ReadonlyArray<CanonicalEvent>
  readonly highlights: ReadonlyArray<CanonicalEvent>
}

type PendingExchange = {
  readonly id: string
  readonly basis: NarrativeExchange["basis"]
  readonly prompt?: CanonicalEvent
  readonly events: Array<CanonicalEvent>
}

const sameAuthor = (left: string, right: string) =>
  left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase()

const isUserMessage = (event: CanonicalEvent, actor: Actor) =>
  event.kind === "message" && sameAuthor(event.author, actor.name)

const isAgentMessage = (event: CanonicalEvent, actor: Actor) =>
  event.kind === "message" && sameAuthor(event.author, actor.harness)

const remainsVisible = (event: CanonicalEvent, actor: Actor) =>
  event.childThread !== undefined ||
  event.kind === "artifact" ||
  event.kind === "notice" ||
  (event.kind === "message" && !isAgentMessage(event, actor))

const finishExchange = (exchange: PendingExchange, actor: Actor): NarrativeExchange => {
  let primaryResponseIndex = -1
  for (let index = exchange.events.length - 1; index >= 0; index -= 1) {
    const event = exchange.events[index]
    if (event !== undefined && isAgentMessage(event, actor)) {
      primaryResponseIndex = index
      break
    }
  }

  const primaryResponse = primaryResponseIndex < 0
    ? undefined
    : exchange.events[primaryResponseIndex]
  const activity: Array<CanonicalEvent> = []
  const highlights: Array<CanonicalEvent> = []

  for (let index = 0; index < exchange.events.length; index += 1) {
    if (index === primaryResponseIndex) continue
    const event = exchange.events[index]
    if (event === undefined) continue
    if (remainsVisible(event, actor)) highlights.push(event)
    else activity.push(event)
  }

  return {
    id: exchange.id,
    basis: exchange.basis,
    ...(exchange.prompt === undefined ? {} : { prompt: exchange.prompt }),
    ...(primaryResponse === undefined ? {} : { primaryResponse }),
    activity,
    highlights
  }
}

/**
 * Builds a non-persisted reading projection from ordered Canonical Events.
 * The Canonical model and its source order remain authoritative.
 */
export const projectConversationNarrative = (
  conversation: Conversation
): ReadonlyArray<NarrativeExchange> => {
  const exchanges: Array<NarrativeExchange> = []
  let pending: PendingExchange | undefined

  for (const event of conversation.events) {
    if (isUserMessage(event, conversation.session.actor)) {
      if (pending !== undefined) {
        exchanges.push(finishExchange(pending, conversation.session.actor))
      }
      pending = {
        id: event.id,
        basis: "user_message",
        prompt: event,
        events: []
      }
      continue
    }

    if (pending === undefined) {
      pending = {
        id: event.id,
        basis: "thread_start",
        events: []
      }
    }
    pending.events.push(event)
  }

  if (pending !== undefined) {
    exchanges.push(finishExchange(pending, conversation.session.actor))
  }
  return exchanges
}
