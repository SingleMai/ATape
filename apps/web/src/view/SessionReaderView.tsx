import type { CanonicalEvent, Conversation } from "@atape/domain"
import { Badge, Button, Eyebrow } from "@atape/ui"
import { useEffect } from "react"
import type { LoadableView } from "../presenters/memoryPresenter"
import { presentConversationTurns } from "../presenters/sessionReaderPresenter"

type Props = {
  readonly state: LoadableView<Conversation>
  readonly projectName: string
  readonly onBack: () => void
  readonly onOpenThread: (threadId: string) => void
  readonly onRetry: () => void
  readonly onOpenRaw: () => void
  readonly highlightedEventId?: string
  readonly searchOrigin?: {
    readonly query: string
    readonly onReturn: () => void
  }
}

const formatTime = (value: string) =>
  new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value))

const ChildThreadButton = ({ event, onOpenThread }: {
  readonly event: CanonicalEvent
  readonly onOpenThread: (threadId: string) => void
}) => {
  const childThread = event.childThread
  return childThread ? (
    <button className="child-thread" type="button" onClick={() => onOpenThread(childThread.id)}>
      <span>
        <strong>{childThread.label} · child thread</strong>
        <small>{childThread.summary} · {childThread.captureStatus} · {childThread.eventCount} events</small>
      </span>
      <strong>Follow thread</strong>
    </button>
  ) : null
}

const MessageView = ({ event, role, onOpenThread, highlighted }: {
  readonly event: CanonicalEvent
  readonly role: "user" | "agent"
  readonly onOpenThread: (threadId: string) => void
  readonly highlighted: boolean
}) => (
  <article
    className={`event turn-message turn-message-${role}${highlighted ? " event-highlighted" : ""}`}
    id={`event-${event.id}`}
    tabIndex={-1}
  >
    <header>
      <strong>{event.author}</strong>
      <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
    </header>
    <p>{event.text}</p>
    <ChildThreadButton event={event} onOpenThread={onOpenThread} />
  </article>
)

const processLabel: Record<CanonicalEvent["kind"], string> = {
  message: "Agent update",
  thought: "Thinking",
  tool_call: "Tool call",
  tool_result: "Tool result",
  artifact: "Artifact",
  spawn: "Delegation",
  lifecycle: "Activity",
  context: "Context",
  notice: "Notice"
}

const isToolEvent = (event: CanonicalEvent) => event.kind === "tool_call" || event.kind === "tool_result"

const ProcessEventView = ({ event, onOpenThread, highlighted }: {
  readonly event: CanonicalEvent
  readonly onOpenThread: (threadId: string) => void
  readonly highlighted: boolean
}) => {
  const isTool = isToolEvent(event)
  const content = (
    <article
      className={`process-event process-event-${event.kind}${highlighted ? " event-highlighted" : ""}`}
      id={`event-${event.id}`}
      tabIndex={-1}
    >
      {!isTool && (
        <header>
          <strong>{processLabel[event.kind]}</strong>
          <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
        </header>
      )}
      <p>{event.text}</p>
      <ChildThreadButton event={event} onOpenThread={onOpenThread} />
    </article>
  )

  if (!isTool) return content
  return (
    <details className="process-tool" open={highlighted || undefined}>
      <summary>
        <span>
          <strong>{event.toolLabel || processLabel[event.kind]}</strong>
          <small>{processLabel[event.kind]}</small>
        </span>
        <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
      </summary>
      {content}
    </details>
  )
}

const ToolActivityDetails = ({ events, onOpenThread, highlightedEventId }: {
  readonly events: ReadonlyArray<CanonicalEvent>
  readonly onOpenThread: (threadId: string) => void
  readonly highlightedEventId: string | undefined
}) => {
  if (events.length === 0) return null
  const containsHighlight = events.some((event) => event.id === highlightedEventId)
  return (
    <details className="process-tool-group" open={containsHighlight || undefined}>
      <summary>
        <span>
          <strong>Tool activity</strong>
          <small>{events.length} event{events.length === 1 ? "" : "s"}</small>
        </span>
        <span className="process-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="process-tool-list">
        {events.map((event) => (
          <ProcessEventView
            key={event.id}
            event={event}
            onOpenThread={onOpenThread}
            highlighted={event.id === highlightedEventId}
          />
        ))}
      </div>
    </details>
  )
}

const describeProcess = (events: ReadonlyArray<CanonicalEvent>) => {
  const toolCount = events.filter(isToolEvent).length
  const thoughtCount = events.filter((event) => event.kind === "thought").length
  const updateCount = events.filter((event) => event.kind === "message").length
  const backgroundCount = events.length - toolCount - thoughtCount - updateCount
  const labels = [
    updateCount > 0 ? `${updateCount} update${updateCount === 1 ? "" : "s"}` : undefined,
    thoughtCount > 0 ? `${thoughtCount} thought${thoughtCount === 1 ? "" : "s"}` : undefined,
    toolCount > 0 ? `${toolCount} tool event${toolCount === 1 ? "" : "s"}` : undefined,
    backgroundCount > 0 ? `${backgroundCount} other event${backgroundCount === 1 ? "" : "s"}` : undefined
  ].filter((label): label is string => label !== undefined)
  return labels.join(" · ")
}

const ProcessDetails = ({ events, onOpenThread, highlightedEventId }: {
  readonly events: ReadonlyArray<CanonicalEvent>
  readonly onOpenThread: (threadId: string) => void
  readonly highlightedEventId: string | undefined
}) => {
  if (events.length === 0) return null
  const containsHighlight = events.some((event) => event.id === highlightedEventId)
  const toolEvents = events.filter(isToolEvent)
  const timelineEvents = events.filter((event) => !isToolEvent(event))
  return (
    <details className="turn-process" open={containsHighlight || undefined}>
      <summary>
        <span>
          <strong>Process</strong>
          <small>{describeProcess(events)}</small>
        </span>
        <span className="process-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="turn-process-events">
        {timelineEvents.map((event) => (
          <ProcessEventView
            key={event.id}
            event={event}
            onOpenThread={onOpenThread}
            highlighted={event.id === highlightedEventId}
          />
        ))}
        <ToolActivityDetails
          events={toolEvents}
          onOpenThread={onOpenThread}
          highlightedEventId={highlightedEventId}
        />
      </div>
    </details>
  )
}

export const SessionReaderView = ({
  state,
  projectName,
  onBack,
  onOpenThread,
  onRetry,
  onOpenRaw,
  highlightedEventId,
  searchOrigin
}: Props) => {
  useEffect(() => {
    if (state._tag !== "Ready" || !highlightedEventId) return
    const event = document.getElementById(`event-${highlightedEventId}`)
    event?.scrollIntoView({ behavior: "smooth", block: "center" })
    event?.focus({ preventScroll: true })
  }, [highlightedEventId, state])

  if (state._tag === "Loading") {
    return <section className="state-card" aria-live="polite">Reconstructing conversation…</section>
  }

  if (state._tag === "Failed") {
    return (
      <section className="state-card error-card" role="alert">
        <Button className="back-link" variant="ghost" onClick={searchOrigin?.onReturn ?? onBack}>
          {searchOrigin ? "Back to search results" : `Back to ${projectName}`}
        </Button>
        <h1>Conversation is unavailable</h1>
        <p>{state.message}</p>
        {state.retryable && <Button onClick={onRetry}>Try again</Button>}
      </section>
    )
  }

  const conversation = state.value
  const turns = presentConversationTurns(conversation)
  return (
    <section aria-labelledby="session-title">
      <nav className="reader-nav" aria-label="Session navigation">
        <Button className="back-link" variant="ghost" onClick={searchOrigin?.onReturn ?? onBack}>
          {searchOrigin ? "Back to search results" : `Back to ${projectName}`}
        </Button>
        <div className="reader-actions">
          <span>{state.refreshing ? "Refreshing…" : "Read-only mirror"}</span>
          <Button variant="secondary" onClick={onOpenRaw}>View Raw source</Button>
        </div>
      </nav>

      <header className="hero session-hero">
        <Eyebrow>Shared conversation</Eyebrow>
        <h1 id="session-title">{conversation.session.title}</h1>
        <div className="tag-row">
          <Badge>{conversation.session.actor.name}</Badge>
          <Badge>{conversation.session.actor.harness}</Badge>
          <Badge>{conversation.session.branch}</Badge>
          <Badge tone="accent">{conversation.session.status} · {conversation.session.captureStatus}</Badge>
        </div>
      </header>

      {searchOrigin && (
        <div className="search-origin" role="status">
          <span>Opened from results for <strong>“{searchOrigin.query}”</strong></span>
          <button type="button" onClick={searchOrigin.onReturn}>Return to results</button>
        </div>
      )}

      <nav className="thread-path" aria-label="Thread path">
        {conversation.threadPath.map((thread, index) => (
          <span className="thread-path-item" key={thread.id}>
            {index > 0 && <span aria-hidden="true">/</span>}
            <button
              className={thread.id === conversation.thread.id ? "current" : ""}
              type="button"
              onClick={() => onOpenThread(thread.id)}
              aria-current={thread.id === conversation.thread.id ? "page" : undefined}
            >
              {thread.label}
            </button>
          </span>
        ))}
      </nav>

      <div className="conversation-stream">
        {turns.map((turn, index) => (
          <section className="conversation-turn" aria-label={`Turn ${index + 1}`} key={turn.id}>
            {turn.userMessage && (
              <MessageView
                event={turn.userMessage}
                role="user"
                onOpenThread={onOpenThread}
                highlighted={turn.userMessage.id === highlightedEventId}
              />
            )}
            <ProcessDetails
              events={turn.processEvents}
              onOpenThread={onOpenThread}
              highlightedEventId={highlightedEventId}
            />
            {turn.agentResponse && (
              <MessageView
                event={turn.agentResponse}
                role="agent"
                onOpenThread={onOpenThread}
                highlighted={turn.agentResponse.id === highlightedEventId}
              />
            )}
          </section>
        ))}
        {turns.length === 0 && (
          <div className="empty-conversation">
            <strong>No messages captured yet</strong>
            <span>ATape will add the conversation here as new events arrive.</span>
          </div>
        )}
      </div>

      <p className="mirror-note">This is a read-only mirror. New captured events appear automatically.</p>
    </section>
  )
}
