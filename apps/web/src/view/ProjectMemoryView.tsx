import type { ProjectMemory, SessionSummary } from "@atape/domain"
import { Avatar, Badge, Button, Eyebrow } from "@atape/ui"
import type { LoadableView } from "../presenters/memoryPresenter"

type Props = {
  readonly state: LoadableView<ProjectMemory>
  readonly onOpenSession: (sessionId: string) => void
  readonly onRetry: () => void
}

const formatTime = (value: string) =>
  new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date(value))

const SessionCard = ({
  session,
  onOpen
}: {
  readonly session: SessionSummary
  readonly onOpen: () => void
}) => (
  <button className="session-card" type="button" onClick={onOpen}>
    <div className="session-card-meta">
      <Avatar name={session.actor.name} />
      <span>
        <strong>{session.actor.name} · {session.actor.harness}</strong>
        <small>{session.branch} · {formatTime(session.updatedAt)}</small>
      </span>
      <Badge
        className="session-status"
        tone={session.status === "active" ? "success" : "neutral"}
      >
        {session.status}
      </Badge>
    </div>
    <h3>{session.title}</h3>
    <p>{session.summary}</p>
    <blockquote>{session.insight}</blockquote>
    <footer>
      <span>{session.eventCount} events{session.childThreadCount > 0 ? ` · ${session.childThreadCount} child thread` : ""}</span>
      <strong>Open conversation</strong>
    </footer>
  </button>
)

const TrailItem = ({
  session,
  onOpen
}: {
  readonly session: SessionSummary
  readonly onOpen: () => void
}) => (
  <button className="trail-item" type="button" onClick={onOpen}>
    <Avatar name={session.actor.name} size="small" />
    <span className="trail-copy">
      <strong>{session.title}</strong>
      <small>{session.insight}</small>
    </span>
    <span className="trail-tags">
      <Badge>{session.actor.harness}</Badge>
      <Badge>{session.branch}</Badge>
      <time>{formatTime(session.updatedAt)}</time>
    </span>
  </button>
)

export const ProjectMemoryView = ({ state, onOpenSession, onRetry }: Props) => {
  if (state._tag === "Loading") {
    return <section className="state-card" aria-live="polite">Gathering project memory…</section>
  }

  if (state._tag === "Failed") {
    return (
      <section className="state-card error-card" role="alert">
        <h1>Project memory is unavailable</h1>
        <p>{state.message}</p>
        {state.retryable && <Button onClick={onRetry}>Try again</Button>}
      </section>
    )
  }

  const memory = state.value
  return (
    <section aria-labelledby="project-memory-title">
      <div className="hero project-hero">
        <div>
          <Eyebrow>Project memory</Eyebrow>
          <h1 id="project-memory-title">What changed while you were away?</h1>
          <p>Follow active work or retrace an earlier decision without asking someone to reconstruct the conversation.</p>
        </div>
        <span className="capture-status" aria-live="polite">
          {state.refreshing ? "Syncing new events…" : `Auto-sync · Captured through ${formatTime(memory.capturedThrough)}`}
        </span>
      </div>

      <section className="memory-section" aria-labelledby="happening-title">
        <header className="section-heading">
          <div>
            <h2 id="happening-title">Happening now</h2>
            <p>{memory.active.length} conversations recently updated</p>
          </div>
        </header>
        <div className="active-grid">
          {memory.active.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onOpen={() => onOpenSession(session.id)}
            />
          ))}
          {memory.active.length === 0 && (
            <div className="empty-memory">
              <strong>No active conversations</strong>
              <span>Captured work will appear here when a teammate starts using this Project.</span>
            </div>
          )}
        </div>
      </section>

      <section className="memory-section" aria-labelledby="trail-title">
        <header className="section-heading">
          <div>
            <h2 id="trail-title">Memory trail</h2>
            <p>Recent conversations in the order the team experienced them</p>
          </div>
        </header>
        <div className="trail-list">
          {memory.trail.map((session) => (
            <TrailItem
              key={session.id}
              session={session}
              onOpen={() => onOpenSession(session.id)}
            />
          ))}
          {memory.trail.length === 0 && (
            <div className="empty-memory empty-trail">
              <strong>This Project’s trail is ready</strong>
              <span>The first captured Session will become shared team memory here.</span>
            </div>
          )}
        </div>
      </section>
    </section>
  )
}
