import type { ProjectMemory, SessionSummary } from "@atape/domain"
import { Badge, Button } from "@atape/ui"
import { useState } from "react"
import type { LoadableView, RefreshSettingsView } from "../presenters/memoryPresenter"
import { RefreshControl } from "./RefreshControl"
import { formatDate, t } from "../i18n"

type Props = {
  readonly state: LoadableView<ProjectMemory>
  readonly refresh: RefreshSettingsView
  readonly onOpenSession: (sessionId: string) => void
  readonly onRetry: () => void
}

const formatAbsoluteTime = (value: string) =>
  formatDate(new Date(value), { dateStyle: "medium", timeStyle: "short" })

const formatRelativeTime = (value: string) => {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1_000))
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 10) return t("time.justNow", "just now")
  if (elapsedSeconds < 60) return t("time.secondsAgo", "{count}s ago", { count: elapsedSeconds })
  const minutes = Math.floor(elapsedSeconds / 60)
  if (minutes < 60) return t("time.minutesAgo", "{count}m ago", { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t("time.hoursAgo", "{count}h ago", { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t("time.daysAgo", "{count}d ago", { count: days })
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
        {t("memory.loading", "Gathering project memory…")}
      </section>
    )
  }

  if (state._tag === "Failed") {
    return (
      <section className="state-card error-card" role="alert">
        <h1>{t("memory.unavailableTitle", "Project memory is unavailable")}</h1>
        <p>{t(state.messageKey)}</p>
        {state.retryable && <Button onClick={onRetry}>{t("common.tryAgain", "Try again")}</Button>}
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
          <h1 id="project-memory-title">{t("memory.conversationsTitle", "Conversations")}</h1>
        </div>
        <details className="quiet-disclosure">
          <summary>{t("memory.updates", "Updates")}</summary>
          <div className="quiet-disclosure-panel">
            <RefreshControl
              settings={refresh}
              refreshing={state.refreshing}
              refreshFailure={state.refreshFailureKey === undefined ? undefined : t(state.refreshFailureKey)}
              status={
                <>
                  {t("memory.updatedLabel", "Updated")} <PresenceTime value={memory.capturedThrough} />
                </>
              }
              onRefresh={onRetry}
            />
          </div>
        </details>
      </header>
      {state.refreshFailureKey && (
        <p className="compact-warning" role="status">
          {t("memory.refreshFailed", "Refresh failed · showing previous conversations")}
        </p>
      )}
      <div className="conversation-list-toolbar">
        <div role="group" aria-label={t("memory.conversationStatus", "Conversation status")}>
          <button type="button" aria-pressed={!activeOnly} onClick={() => setActiveOnly(false)}>
            {t("memory.allConversations", "All conversations")}
          </button>
          <button type="button" aria-pressed={activeOnly} onClick={() => setActiveOnly(true)}>
            {t("memory.active", "Active")} <span>{memory.active.length}</span>
          </button>
        </div>
        <span>
          {t("memory.conversationCount", "{count, plural, one {# conversation} other {# conversations}}", { count: sessions.length })}
        </span>
      </div>
      <div className="trail-list">
        {sessions.map((session) => (
          <TrailItem key={session.id} session={session} onOpen={() => onOpenSession(session.id)} />
        ))}
        {sessions.length === 0 && (
          <div className="empty-memory empty-trail">
            <strong>{activeOnly ? t("memory.noActiveConversations", "No active conversations") : t("memory.noConversations", "No conversations yet")}</strong>
            <span>
              {activeOnly
                ? t("memory.noActiveBody", "Choose All conversations to browse captured work.")
                : t("memory.noConversationsBody", "Conversations will appear after this project is captured.")}
            </span>
          </div>
        )}
      </div>
    </section>
  )
}
