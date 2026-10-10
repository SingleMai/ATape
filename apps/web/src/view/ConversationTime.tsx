import { formatDate, t } from "../i18n"

const knownDate = (value: string | null): Date | undefined => {
  if (value === null) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : undefined
}

export const formatConversationTime = (
  value: string | null,
  options?: Intl.DateTimeFormatOptions
): string => {
  const date = knownDate(value)
  return date === undefined ? t("time.unknown", "Time unknown") : formatDate(date, options)
}

const relativeTime = (date: Date): string => {
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1_000))
  if (seconds < 10) return t("time.justNow", "just now")
  if (seconds < 60) return t("time.secondsAgo", "{count}s ago", { count: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t("time.minutesAgo", "{count}m ago", { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t("time.hoursAgo", "{count}h ago", { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t("time.daysAgo", "{count}d ago", { count: days })
  return formatDate(date, { dateStyle: "medium", timeStyle: "short" })
}

export const ConversationTime = ({ value, options, relative = false }: {
  readonly value: string | null
  readonly options?: Intl.DateTimeFormatOptions
  readonly relative?: boolean
}) => {
  const date = knownDate(value)
  if (date === undefined || value === null) {
    return <span className="conversation-time">{t("time.unknown", "Time unknown")}</span>
  }
  return (
    <time
      className="conversation-time"
      dateTime={value}
      title={relative ? formatDate(date, { dateStyle: "medium", timeStyle: "short" }) : undefined}
    >
      {relative ? relativeTime(date) : formatDate(date, options)}
    </time>
  )
}
