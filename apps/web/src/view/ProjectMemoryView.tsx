import type { ProjectMemory, SessionSummary } from "@atape/domain"
import { Badge, Button } from "@atape/ui"
import { useState } from "react"
import type { LoadableView, RefreshSettingsView } from "../presenters/memoryPresenter"
import { RefreshControl } from "./RefreshControl"

type Props = {
  readonly state: LoadableView<ProjectMemory>
  readonly refresh: RefreshSettingsView
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
  <time dateTime={value} title={formatAbsoluteTime(value)}>
    {formatRelativeTime(value)}
  </time>
)

const TrailItem = ({
  session,
  onOpen
}: {
  readonly session: SessionSummary
  readonly onOpen: () => void
}) => (
  <button className="trail-item" type="button" onClick={onOpen}>
    <span className="conversation-status-dot" data-active={session.status === "active"} aria-hidden="true" />
    <span className="trail-copy">
      <strong>{session.title}</strong>
      <small>
        {session.actor.name} · {session.actor.harness}
        {session.branch ? ` · ${session.branch}` : ""}
      </small>
    </span>
    <span className="trail-tags">
      <Badge tone={session.status === "active" ? "success" : "neutral"}>{session.status}</Badge>
      <PresenceTime value={session.updatedAt} />
    </span>
  </button>
)

export const ProjectMemoryView = ({ state, refresh, onOpenSession, onRetry }: Props) => {
  const [activeOnly, setActiveOnly] = useState(false)
  if (state._tag === "Loading") {
    return (
      <section className="state-card" aria-live="polite">
        Gathering project memory…
      </section>
    )
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
  const sessions = [
    ...new Map([...memory.active, ...memory.trail].map((session) => [session.id, session])).values()
  ]
    .filter((session) => !activeOnly || session.status === "active")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  return (
    <section className="project-conversations" aria-labelledby="project-memory-title">
      <header className="project-page-heading">
        <div>
          <p className="project-page-context">{memory.project.name}</p>
          <h1 id="project-memory-title">Conversations</h1>
        </div>
        <details className="quiet-disclosure">
          <summary>Updates</summary>
          <div className="quiet-disclosure-panel">
            <RefreshControl
              settings={refresh}
              refreshing={state.refreshing}
              refreshFailure={state.refreshFailure}
              status={
                <>
                  Updated <PresenceTime value={memory.capturedThrough} />
                </>
              }
              onRefresh={onRetry}
            />
          </div>
        </details>
      </header>
      {state.refreshFailure && (
        <p className="compact-warning" role="status">
          Refresh failed · showing previous conversations
        </p>
      )}
      <div className="conversation-list-toolbar">
        <div role="group" aria-label="Conversation status">
          <button type="button" aria-pressed={!activeOnly} onClick={() => setActiveOnly(false)}>
            All conversations
          </button>
          <button type="button" aria-pressed={activeOnly} onClick={() => setActiveOnly(true)}>
            Active <span>{memory.active.length}</span>
          </button>
        </div>
        <span>
          {sessions.length} {sessions.length === 1 ? "conversation" : "conversations"}
        </span>
      </div>
      <div className="trail-list">
        {sessions.map((session) => (
          <TrailItem key={session.id} session={session} onOpen={() => onOpenSession(session.id)} />
        ))}
        {sessions.length === 0 && (
          <div className="empty-memory empty-trail">
            <strong>{activeOnly ? "No active conversations" : "No conversations yet"}</strong>
            <span>
              {activeOnly
                ? "Choose All conversations to browse captured work."
                : "Conversations will appear after this project is captured."}
            </span>
          </div>
        )}
      </div>
    </section>
  )
}
