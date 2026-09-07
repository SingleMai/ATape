import type { Actor, CanonicalEvent, Conversation } from "@atape/domain"

export type ConversationTurnView = {
  readonly id: string
  readonly userMessage?: CanonicalEvent
  readonly agentResponse?: CanonicalEvent
  readonly processEvents: ReadonlyArray<CanonicalEvent>
}

type PendingTurn = {
  readonly id: string
  readonly userMessage?: CanonicalEvent
  readonly events: Array<CanonicalEvent>
}

const sameAuthor = (left: string, right: string) =>
  left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase()

const isUserMessage = (event: CanonicalEvent, actor: Actor) =>
  event.kind === "message" && sameAuthor(event.author, actor.name)

const isAgentMessage = (event: CanonicalEvent, actor: Actor) =>
  event.kind === "message" && sameAuthor(event.author, actor.harness)

const finishTurn = (turn: PendingTurn, actor: Actor): ConversationTurnView => {
  const agentResponse = turn.events.findLast((event) => isAgentMessage(event, actor))
  return {
    id: turn.id,
    ...(turn.userMessage === undefined ? {} : { userMessage: turn.userMessage }),
    ...(agentResponse === undefined ? {} : { agentResponse }),
    processEvents: turn.events.filter((event) => event !== agentResponse)
  }
}

export const presentConversationTurns = (conversation: Conversation): ReadonlyArray<ConversationTurnView> => {
  const turns: Array<ConversationTurnView> = []
  let current: PendingTurn | undefined

  for (const event of conversation.events) {
    if (isUserMessage(event, conversation.session.actor)) {
      if (current !== undefined) turns.push(finishTurn(current, conversation.session.actor))
      current = { id: event.id, userMessage: event, events: [] }
      continue
    }

    if (current === undefined) current = { id: event.id, events: [] }
    current.events.push(event)
  }

  if (current !== undefined) turns.push(finishTurn(current, conversation.session.actor))
  return turns
}
