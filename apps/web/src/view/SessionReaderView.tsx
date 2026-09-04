import type { CanonicalEvent, Conversation } from "@atape/domain"
import { Badge, Button, Eyebrow } from "@atape/ui"
import { useEffect } from "react"
import type { LoadableView } from "../presenters/memoryPresenter"

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

const EventView = ({ event, onOpenThread, highlighted }: {
  readonly event: CanonicalEvent
  readonly onOpenThread: (threadId: string) => void
  readonly highlighted: boolean
}) => (
  <article
    className={`event event-${event.kind}${highlighted ? " event-highlighted" : ""}`}
    id={`event-${event.id}`}
    tabIndex={-1}
  >
    <header>
      <strong>{event.author}</strong>
      <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
    </header>
    <p>{event.text}</p>
    {event.toolLabel && <span className="tool-label">{event.toolLabel}</span>}
    {event.childThread && (
      <button className="child-thread" type="button" onClick={() => onOpenThread(event.childThread!.id)}>
        <span>
          <strong>{event.childThread.label} · child thread</strong>
          <small>{event.childThread.summary} · {event.childThread.captureStatus} · {event.childThread.eventCount} events</small>
        </span>
        <strong>Follow thread</strong>
      </button>
    )}
  </article>
)

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
        {conversation.events.map((event) => (
          <EventView
            key={event.id}
            event={event}
            onOpenThread={onOpenThread}
            highlighted={event.id === highlightedEventId}
          />
        ))}
      </div>

      <p className="mirror-note">This is a read-only mirror. New captured events appear automatically.</p>
    </section>
  )
}
