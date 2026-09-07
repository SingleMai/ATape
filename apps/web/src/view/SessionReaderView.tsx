import {
  projectConversationNarrative,
  type CanonicalEvent,
  type Conversation,
  type NarrativeExchange
} from "@atape/domain"
import { Badge, Button, Eyebrow } from "@atape/ui"
import { useEffect } from "react"
import ReactMarkdown from "react-markdown"
import type { LoadableView, RefreshSettingsView } from "../presenters/memoryPresenter"
import { RefreshControl } from "./RefreshControl"

type Props = {
  readonly state: LoadableView<Conversation>
  readonly refresh: RefreshSettingsView
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

const eventLabel: Record<CanonicalEvent["kind"], string> = {
  message: "Message",
  thought: "Thinking",
  tool_call: "Tool call",
  tool_result: "Tool result",
  artifact: "Artifact",
  spawn: "Delegation",
  lifecycle: "Activity",
  context: "Context",
  notice: "Notice"
}

const isToolEvent = (event: CanonicalEvent) =>
  event.kind === "tool_call" || event.kind === "tool_result"

const eventClassName = (base: string, event: CanonicalEvent, highlightedEventId?: string) =>
  `${base}${event.id === highlightedEventId ? " event-highlighted" : ""}`

const MarkdownText = ({ text }: { readonly text: string }) => (
  <div className="narrative-markdown">
    <ReactMarkdown>{text}</ReactMarkdown>
  </div>
)

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

const PromptView = ({ event, onOpenThread, highlightedEventId }: {
  readonly event: CanonicalEvent
  readonly onOpenThread: (threadId: string) => void
  readonly highlightedEventId: string | undefined
}) => (
  <article
    className={eventClassName("narrative-prompt", event, highlightedEventId)}
    id={`event-${event.id}`}
    tabIndex={-1}
  >
    <header>
      <strong>{event.author}</strong>
      <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
    </header>
    <MarkdownText text={event.text} />
    <ChildThreadButton event={event} onOpenThread={onOpenThread} />
  </article>
)

const PrimaryResponseView = ({ event, onOpenThread, highlightedEventId }: {
  readonly event: CanonicalEvent
  readonly onOpenThread: (threadId: string) => void
  readonly highlightedEventId: string | undefined
}) => (
  <article
    className={eventClassName("narrative-response", event, highlightedEventId)}
    id={`event-${event.id}`}
    tabIndex={-1}
  >
    <header>
      <strong>{event.author}</strong>
      <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
    </header>
    <MarkdownText text={event.text} />
    <ChildThreadButton event={event} onOpenThread={onOpenThread} />
  </article>
)

const describeActivity = (events: ReadonlyArray<CanonicalEvent>) => {
  const toolCount = events.filter(isToolEvent).length
  const thoughtCount = events.filter((event) => event.kind === "thought").length
  const updateCount = events.filter((event) => event.kind === "message").length
  const backgroundCount = events.length - toolCount - thoughtCount - updateCount
  return [
    updateCount > 0 ? `${updateCount} update${updateCount === 1 ? "" : "s"}` : undefined,
    thoughtCount > 0 ? `${thoughtCount} thought${thoughtCount === 1 ? "" : "s"}` : undefined,
    toolCount > 0 ? `${toolCount} tool event${toolCount === 1 ? "" : "s"}` : undefined,
    backgroundCount > 0 ? `${backgroundCount} other event${backgroundCount === 1 ? "" : "s"}` : undefined
  ].filter((label): label is string => label !== undefined).join(" · ")
}

const ActivityEventView = ({ event, onOpenThread, highlightedEventId }: {
  readonly event: CanonicalEvent
  readonly onOpenThread: (threadId: string) => void
  readonly highlightedEventId: string | undefined
}) => (
  <article
    className={eventClassName(`narrative-activity-event narrative-activity-event-${event.kind}`, event, highlightedEventId)}
    id={`event-${event.id}`}
    tabIndex={-1}
  >
    <header>
      <span>
        <strong>{event.toolLabel || eventLabel[event.kind]}</strong>
        {event.toolLabel && <small>{eventLabel[event.kind]}</small>}
      </span>
      <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
    </header>
    <MarkdownText text={event.text} />
    <ChildThreadButton event={event} onOpenThread={onOpenThread} />
  </article>
)

const ActivityDetails = ({ exchange, onOpenThread, highlightedEventId }: {
  readonly exchange: NarrativeExchange
  readonly onOpenThread: (threadId: string) => void
  readonly highlightedEventId: string | undefined
}) => {
  if (exchange.activity.length === 0) return null
  const containsHighlight = exchange.activity.some((event) => event.id === highlightedEventId)
  const isIncomplete = exchange.primaryResponse === undefined
  return (
    <details className="narrative-activity" open={containsHighlight || isIncomplete || undefined}>
      <summary>
        <span>
          <strong>Activity</strong>
          <small>{describeActivity(exchange.activity)}</small>
        </span>
        <span className="activity-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="narrative-activity-list">
        {exchange.activity.map((event) => (
          <ActivityEventView
            key={event.id}
            event={event}
            onOpenThread={onOpenThread}
            highlightedEventId={highlightedEventId}
          />
        ))}
      </div>
    </details>
  )
}

const HighlightView = ({ event, onOpenThread, highlightedEventId }: {
  readonly event: CanonicalEvent
  readonly onOpenThread: (threadId: string) => void
  readonly highlightedEventId: string | undefined
}) => (
  <article
    className={eventClassName(`narrative-highlight narrative-highlight-${event.kind}`, event, highlightedEventId)}
    id={`event-${event.id}`}
    tabIndex={-1}
  >
    <header>
      <span>
        <strong>{event.kind === "message" ? event.author : eventLabel[event.kind]}</strong>
        {event.kind === "message" && <small>Unclassified message</small>}
      </span>
      <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
    </header>
    <MarkdownText text={event.text} />
    <ChildThreadButton event={event} onOpenThread={onOpenThread} />
  </article>
)

export const SessionReaderView = ({
  state,
  refresh,
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
  const narrative = projectConversationNarrative(conversation)
  return (
    <section aria-labelledby="session-title">
      <nav className="reader-nav" aria-label="Session navigation">
        <Button className="back-link" variant="ghost" onClick={searchOrigin?.onReturn ?? onBack}>
          {searchOrigin ? "Back to search results" : `Back to ${projectName}`}
        </Button>
        <div className="reader-actions">
          <RefreshControl
            settings={refresh}
            refreshing={state.refreshing}
            refreshFailure={state.refreshFailure}
            status={<>Updated <time dateTime={conversation.session.updatedAt}>{formatTime(conversation.session.updatedAt)}</time></>}
            onRefresh={onRetry}
          />
          <Button variant="secondary" onClick={onOpenRaw}>View Raw source</Button>
        </div>
      </nav>

      <header className="session-reader-header">
        <div>
          <Eyebrow>Shared conversation</Eyebrow>
          <h1 id="session-title">{conversation.session.title}</h1>
        </div>
        <div className="session-reader-tags" aria-label="Conversation metadata">
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
        {narrative.map((exchange, index) => (
          <section className="narrative-exchange" aria-label={`Conversation exchange ${index + 1}`} key={exchange.id}>
            {exchange.prompt && (
              <PromptView
                event={exchange.prompt}
                onOpenThread={onOpenThread}
                highlightedEventId={highlightedEventId}
              />
            )}
            <ActivityDetails
              exchange={exchange}
              onOpenThread={onOpenThread}
              highlightedEventId={highlightedEventId}
            />
            {exchange.primaryResponse && (
              <PrimaryResponseView
                event={exchange.primaryResponse}
                onOpenThread={onOpenThread}
                highlightedEventId={highlightedEventId}
              />
            )}
            {exchange.highlights.map((event) => (
              <HighlightView
                key={event.id}
                event={event}
                onOpenThread={onOpenThread}
                highlightedEventId={highlightedEventId}
              />
            ))}
          </section>
        ))}
        {narrative.length === 0 && (
          <div className="empty-conversation">
            <strong>No messages captured yet</strong>
            <span>ATape will add the conversation here as new events arrive.</span>
          </div>
        )}
      </div>

      <p className="mirror-note">This is a read-only mirror. Refresh when you want to check for newly captured events.</p>
    </section>
  )
}
