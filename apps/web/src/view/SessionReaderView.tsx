import {
  projectConversationNarrative,
  type CanonicalEvent,
  type Conversation,
  type NarrativeExchange
} from "@atape/domain"
import { Avatar, Button } from "@atape/ui"
import { createContext, useContext, useEffect, useId, useMemo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import { useMarkdownPlugins } from "../presenters/markdownPresenter"
import type { LoadableView, RefreshSettingsView } from "../presenters/memoryPresenter"
import { RefreshControl } from "./RefreshControl"
import { ConversationReadingFrame } from "./UserMessageIndex"
import { MarkdownCodeBlock } from "./MarkdownCodeBlock"
import { formatDate, t, type WebMessageKey } from "../i18n"

export type SessionReaderProps = {
  readonly state: LoadableView<Conversation>
  readonly refresh: RefreshSettingsView
  readonly projectName: string
  readonly onBack: () => void
  readonly onOpenThread: (threadId: string, label?: string) => void
  readonly onRetry: () => void
  readonly onOpenRaw: () => void
  readonly onNextPage?: (head: string, after: string) => void
  readonly onFirstPage?: () => void
  readonly highlightedEventId?: string
  readonly embedded?: boolean
  readonly searchOrigin?: {
    readonly query: string
    readonly onReturn: () => void
  }
}

const EventPrefix = createContext("")
const useEventId = (id: string) => `${useContext(EventPrefix)}event-${id}`

const formatTime = (value: string) =>
  formatDate(new Date(value), { hour: "2-digit", minute: "2-digit", second: "2-digit" })

const eventLabel: Record<CanonicalEvent["kind"], WebMessageKey> = {
  message: "session.event.message",
  thought: "session.event.thought",
  tool_call: "session.event.toolCall",
  tool_result: "session.event.toolResult",
  artifact: "session.event.artifact",
  spawn: "session.event.delegation",
  lifecycle: "session.event.activity",
  context: "session.event.context",
  notice: "session.event.notice"
}

const isToolEvent = (event: CanonicalEvent) => event.kind === "tool_call" || event.kind === "tool_result"

const eventClassName = (base: string, event: CanonicalEvent, highlightedEventId?: string) =>
  `${base}${event.id === highlightedEventId ? " event-highlighted" : ""}`

const markdownComponents: Components = {
  // Captured conversations have no artifact host or source-workspace URL base.
  a: ({ href, title, children }) =>
    href && /^(https?:\/\/|mailto:)/i.test(href) ? (
      <a href={href} title={title}>{children}</a>
    ) : (
      <span title={t("session.unavailableLinks", "File and local links are unavailable in captured conversations.")}>{children}</span>
    ),
  pre: MarkdownCodeBlock,
  table: ({ children }) => (
    <div className="narrative-table-scroll" role="region" aria-label={t("session.markdownTable", "Markdown table")} tabIndex={0}>
      <table>{children}</table>
    </div>
  )
}

const MarkdownText = ({ text }: { readonly text: string }) => {
  const plugins = useMarkdownPlugins(text)
  return (
    <div className="narrative-markdown">
      <ReactMarkdown {...plugins} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

const ToolDetails = ({ event }: { readonly event: CanonicalEvent }) =>
  event.tool ? (
    <div className="tool-details">
      <small>{t("session.toolCallId", "Tool call · {id}", { id: event.tool.toolCallId })}</small>
      {Object.hasOwn(event.tool, "rawInput") && (
        <details>
          <summary>{t("session.input", "Input")}</summary>
          <pre>{JSON.stringify(event.tool.rawInput, null, 2)}</pre>
        </details>
      )}
      {Object.hasOwn(event.tool, "rawOutput") && (
        <details>
          <summary>{t("session.output", "Output")}</summary>
          <pre>
            {typeof event.tool.rawOutput === "string"
              ? event.tool.rawOutput
              : JSON.stringify(event.tool.rawOutput, null, 2)}
          </pre>
        </details>
      )}
    </div>
  ) : null

const ChildThreadButton = ({
  event,
  onOpenThread
}: {
  readonly event: CanonicalEvent
  readonly onOpenThread: (threadId: string, label?: string) => void
}) => {
  const childThread = event.childThread
  return childThread ? (
    <button className="child-thread" type="button" onClick={() => onOpenThread(childThread.id, childThread.label)}>
      <span>
        <strong>{t("session.childThread", "{label} · child thread", { label: childThread.label })}</strong>
        <small>
          {t("session.childThreadMeta", "{summary} · {status} · {count} events", { summary: childThread.summary, status: childThread.captureStatus, count: childThread.eventCount })}
        </small>
      </span>
      <strong>{t("session.openInSidePanel", "Open in side panel ↗")}</strong>
    </button>
  ) : null
}

const MessageMetadata = ({ event }: { readonly event: CanonicalEvent }) => (
  <footer className="message-metadata">
    <span>{event.author}</span>
    <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
  </footer>
)

const PromptView = ({
  event,
  onOpenThread,
  highlightedEventId
}: {
  readonly event: CanonicalEvent
  readonly onOpenThread: (threadId: string, label?: string) => void
  readonly highlightedEventId: string | undefined
}) => (
  <article
    className={eventClassName("narrative-prompt", event, highlightedEventId)}
    id={useEventId(event.id)}
    data-event-id={event.id}
    tabIndex={0}
  >
    <MarkdownText text={event.text} />
    <ToolDetails event={event} />
    <ChildThreadButton event={event} onOpenThread={onOpenThread} />
    <MessageMetadata event={event} />
  </article>
)

const PrimaryResponseView = ({
  event,
  onOpenThread,
  highlightedEventId
}: {
  readonly event: CanonicalEvent
  readonly onOpenThread: (threadId: string, label?: string) => void
  readonly highlightedEventId: string | undefined
}) => (
  <article
    className={eventClassName("narrative-response", event, highlightedEventId)}
    id={useEventId(event.id)}
    data-event-id={event.id}
    tabIndex={0}
  >
    <MarkdownText text={event.text} />
    <ToolDetails event={event} />
    <ChildThreadButton event={event} onOpenThread={onOpenThread} />
    <MessageMetadata event={event} />
  </article>
)

const describeActivity = (events: ReadonlyArray<CanonicalEvent>) => {
  const toolCount = events.filter(isToolEvent).length
  const thoughtCount = events.filter((event) => event.kind === "thought").length
  const updateCount = events.filter((event) => event.kind === "message").length
  const backgroundCount = events.length - toolCount - thoughtCount - updateCount
  return [
    updateCount > 0 ? t("session.activity.update", "{count, plural, one {# update} other {# updates}}", { count: updateCount }) : undefined,
    thoughtCount > 0 ? t("session.activity.thought", "{count, plural, one {# thought} other {# thoughts}}", { count: thoughtCount }) : undefined,
    toolCount > 0 ? t("session.activity.toolEvent", "{count, plural, one {# tool event} other {# tool events}}", { count: toolCount }) : undefined,
    backgroundCount > 0 ? t("session.activity.otherEvent", "{count, plural, one {# other event} other {# other events}}", { count: backgroundCount }) : undefined
  ]
    .filter((label): label is string => label !== undefined)
    .join(" · ")
}

const ActivityEventView = ({
  event,
  onOpenThread,
  highlightedEventId
}: {
  readonly event: CanonicalEvent
  readonly onOpenThread: (threadId: string, label?: string) => void
  readonly highlightedEventId: string | undefined
}) => (
  <article
    className={eventClassName(
      `narrative-activity-event narrative-activity-event-${event.kind}`,
      event,
      highlightedEventId
    )}
    id={useEventId(event.id)}
    data-event-id={event.id}
    tabIndex={0}
  >
    {event.kind !== "message" && <header>
      <span>
        <strong>{event.toolLabel || t(eventLabel[event.kind])}</strong>
        {event.toolLabel && <small>{t(eventLabel[event.kind])}</small>}
      </span>
    </header>}
    <MarkdownText text={event.text} />
    <ToolDetails event={event} />
    <ChildThreadButton event={event} onOpenThread={onOpenThread} />
    <MessageMetadata event={event} />
  </article>
)

const ActivityDetails = ({
  exchange,
  onOpenThread,
  highlightedEventId
}: {
  readonly exchange: NarrativeExchange
  readonly onOpenThread: (threadId: string, label?: string) => void
  readonly highlightedEventId: string | undefined
}) => {
  if (exchange.activity.length === 0) return null
  const containsHighlight = exchange.activity.some((event) => event.id === highlightedEventId)
  const isIncomplete = exchange.primaryResponse === undefined
  return (
    <details className="narrative-activity" open={containsHighlight || isIncomplete || undefined}>
      <summary>
        <span>
          <strong>{t("session.activity", "Activity")}</strong>
          <small>{describeActivity(exchange.activity)}</small>
        </span>
        <span className="activity-chevron" aria-hidden="true">
          ⌄
        </span>
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

const HighlightView = ({
  event,
  onOpenThread,
  highlightedEventId
}: {
  readonly event: CanonicalEvent
  readonly onOpenThread: (threadId: string, label?: string) => void
  readonly highlightedEventId: string | undefined
}) => (
  <article
    className={eventClassName(
      `narrative-highlight narrative-highlight-${event.kind}`,
      event,
      highlightedEventId
    )}
    id={useEventId(event.id)}
    data-event-id={event.id}
    tabIndex={0}
  >
    <header>
      <strong>{event.kind === "message" ? t("session.unclassifiedMessage", "Unclassified message") : t(eventLabel[event.kind])}</strong>
    </header>
    <MarkdownText text={event.text} />
    <ToolDetails event={event} />
    <ChildThreadButton event={event} onOpenThread={onOpenThread} />
    <MessageMetadata event={event} />
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
  onNextPage,
  onFirstPage,
  highlightedEventId,
  searchOrigin,
  embedded = false
}: SessionReaderProps) => {
  const readerId = useId()
  const titleId = `${readerId}-title`
  const prefix = embedded ? `${readerId}-` : ""
  const ready = state._tag === "Ready"
  const threadId = ready ? state.value.thread.id : undefined
  const value = ready ? state.value : undefined
  const narrative = useMemo(() => (value ? projectConversationNarrative(value) : []), [value])
  const prompts = useMemo(
    () => narrative.flatMap((exchange) => (exchange.prompt ? [exchange.prompt] : [])),
    [narrative]
  )
  useEffect(() => {
    if (!ready || !highlightedEventId) return
    const event = document.getElementById(`${prefix}event-${highlightedEventId}`)
    event?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      block: "center"
    })
    event?.focus({ preventScroll: true })
  }, [highlightedEventId, ready, threadId, value, prefix])

  if (state._tag === "Loading") {
    return (
      <section className="state-card" aria-live="polite">
        {t("session.loading", "Reconstructing conversation…")}
      </section>
    )
  }

  if (state._tag === "Failed") {
    return (
      <section className="state-card error-card" role="alert">
        <Button className="back-link" variant="ghost" onClick={searchOrigin?.onReturn ?? onBack}>
          {embedded ? t("session.closeThreadTab", "Close thread tab") : searchOrigin ? t("session.backToSearch", "Back to search results") : t("session.backToProject", "Back to {project}", { project: projectName })}
        </Button>
        <h1>{state.refreshRequired ? t("session.changed", "Conversation has changed") : t("session.unavailable", "Conversation is unavailable")}</h1>
        <p>{t(state.messageKey)}</p>
        {state.retryable && <Button onClick={onRetry}>{state.refreshRequired ? t("session.reloadConversation", "Reload conversation") : t("common.tryAgain", "Try again")}</Button>}
      </section>
    )
  }

  const conversation = state.value
  return (
    <EventPrefix.Provider value={prefix}>
    <section aria-labelledby={titleId}>
      <header className="clean-reader-heading">
        <div className="clean-reader-title">
          <Button className="back-link" variant="ghost" onClick={onBack} aria-label={embedded ? t("session.closeThreadTab", "Close thread tab") : t("session.backToConversations", "Back to conversations")}>
            {embedded ? "×" : "←"}
          </Button>
          <div>
            <h1 id={titleId}>{embedded ? conversation.thread.label : conversation.session.title}</h1>
            <p className="reader-user">
              <Avatar name={conversation.session.capturedBy?.displayName ?? conversation.session.actor.name} src={conversation.session.capturedBy?.avatarUrl} size="small" />
              <span>{conversation.session.capturedBy?.displayName ?? conversation.session.actor.name} · {conversation.session.actor.harness}
              {conversation.session.branch ? ` · ${conversation.session.branch}` : ""}</span>
            </p>
          </div>
        </div>
        <details className="quiet-disclosure">
          <summary aria-label={t("session.conversationDetails", "Conversation details and actions")}>{t("session.more", "More")}</summary>
          <div className="quiet-disclosure-panel">
            <p>
              {t("session.statusCapture", "{status} · Capture: {captureStatus}", { status: conversation.session.status, captureStatus: conversation.session.captureStatus })}
            </p>
            <RefreshControl
              settings={refresh}
              refreshing={state.refreshing}
              refreshFailure={state.refreshFailureKey === undefined ? undefined : t(state.refreshFailureKey)}
              status={
                <>
                  {t("session.updatedLabel", "Updated")}{" "}
                  <time dateTime={conversation.session.updatedAt}>
                    {formatTime(conversation.session.updatedAt)}
                  </time>
                </>
              }
              onRefresh={onRetry}
            />
            <Button variant="ghost" onClick={onOpenRaw}>
              {t("session.viewRawSource", "View Raw source")}
            </Button>
          </div>
        </details>
      </header>
      {(conversation.session.captureStatus === "partial" ||
        conversation.session.captureStatus === "degraded") && (
        <p className="compact-warning" role="status">
          {t("session.captureIncomplete", "Capture is {status} · some conversation content may be missing.", { status: conversation.session.captureStatus })}
        </p>
      )}
      {state.refreshFailureKey && (
        <p className="compact-warning" role="status">
          {t("session.refreshFailed", "Refresh failed · showing previous conversation")}
        </p>
      )}
      {searchOrigin && (
        <div className="compact-search-origin">
          <button type="button" onClick={searchOrigin.onReturn}>
            {t("session.searchResultsFor", "← Search results for “{query}”", { query: searchOrigin.query })}
          </button>
        </div>
      )}
      {conversation.threadPath.length > 1 && (
        <nav className="thread-path" aria-label={t("session.threadPath", "Thread path")}>
          {conversation.threadPath.map((thread, index) => (
            <span className="thread-path-item" key={thread.id}>
              {index > 0 && <span aria-hidden="true">/</span>}
              <button
                className={thread.id === conversation.thread.id ? "current" : ""}
                type="button"
                onClick={() => onOpenThread(thread.id, thread.label)}
                aria-current={thread.id === conversation.thread.id ? "page" : undefined}
              >
                {thread.label}
              </button>
            </span>
          ))}
        </nav>
      )}

      {onFirstPage && <Button variant="ghost" onClick={onFirstPage}>{t("session.readFromBeginning", "Read from the beginning")}</Button>}
      <ConversationReadingFrame key={`${conversation.thread.id}:${conversation.events[0]?.id ?? "empty"}`} prompts={prompts} embedded={embedded}>
        <div className="conversation-stream">
          {narrative.map((exchange, index) => (
            <section
              className="narrative-exchange"
              aria-label={t("session.exchange", "Conversation exchange {index}", { index: index + 1 })}
              key={exchange.id}
            >
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
              <strong>{t("session.noMessagesTitle", "No messages captured yet")}</strong>
              <span>{t("session.noMessagesBody", "ATape will add the conversation here as new events arrive.")}</span>
            </div>
          )}
        </div>
      </ConversationReadingFrame>
      {conversation.head && conversation.nextEventId && onNextPage && (
        <nav aria-label={t("session.pages", "Conversation pages")}>
          <Button disabled={state.refreshing} onClick={() => onNextPage(conversation.head!, conversation.nextEventId!)}>{t("session.nextPage", "Next page")}</Button>
        </nav>
      )}
    </section>
    </EventPrefix.Provider>
  )
}
