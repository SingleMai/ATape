import type { ProjectMemory, SessionSummary } from "@atape/domain"
import { Avatar, Badge, Button, Eyebrow } from "@atape/ui"
import type { LoadableView } from "../presenters/memoryPresenter"

type Props = {
  readonly state: LoadableView<ProjectMemory>
  readonly onOpenSession: (sessionId: string) => void
  readonly onRetry: () => void
}

const formatAbsoluteTime = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))

const formatRelativeTime = (value: string) => {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1_000))
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 10) return "just now"
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`
  const minutes = Math.floor(elapsedSeconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return formatAbsoluteTime(value)
}

const PresenceTime = ({ value }: { readonly value: string }) => (
  <time dateTime={value} title={formatAbsoluteTime(value)}>{formatRelativeTime(value)}</time>
)

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
        <strong>{session.actor.name} is working with {session.actor.harness}</strong>
        <small>{session.branch || "No branch"} · updated <PresenceTime value={session.updatedAt} /></small>
      </span>
      <Badge
        className="session-status"
        tone={session.status === "active" ? "success" : "neutral"}
      >
        Active now
      </Badge>
    </div>
    <h3>{session.title}</h3>
    {session.summary && <p>{session.summary}</p>}
    {session.insight && <blockquote>{session.insight}</blockquote>}
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
      <small>{session.actor.name} · {session.actor.harness}{session.insight ? ` · ${session.insight}` : ""}</small>
    </span>
    <span className="trail-tags">
      <Badge tone={session.status === "active" ? "success" : "neutral"}>{session.status}</Badge>
      {session.branch && <Badge>{session.branch}</Badge>}
      <PresenceTime value={session.updatedAt} />
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
          {state.refreshing ? "Syncing new events…" : <>Auto-sync · updated <PresenceTime value={memory.capturedThrough} /></>}
        </span>
      </div>

      <section className="memory-section" aria-labelledby="happening-title">
        <header className="section-heading">
          <div>
            <h2 id="happening-title">Happening now</h2>
            <p>{memory.active.length} conversations updated in the last 5 minutes</p>
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
