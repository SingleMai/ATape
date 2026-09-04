import type { SearchPage, SearchResult } from "@atape/domain"
import { Badge, Button, Eyebrow } from "@atape/ui"
import { useEffect, useState, type ReactNode } from "react"
import type { LoadableView } from "../presenters/memoryPresenter"

type Props = {
  readonly state: LoadableView<SearchPage>
  readonly query: string
  readonly onSearch: (query: string) => void
  readonly onClose: () => void
  readonly onOpenResult: (result: SearchResult) => void
  readonly onNextPage: (cursor: string) => void
  readonly onRetry: () => void
}

const formatTime = (value: string) => new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit"
}).format(new Date(value))

const HighlightedText = ({ text, query }: { readonly text: string; readonly query: string }) => {
  const tokens = [...new Set(query.trim().split(/\s+/).filter((token) => token.length > 1))]
  if (tokens.length === 0) return <>{text}</>
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const matcher = new RegExp(`(${escaped.join("|")})`, "gi")
  const parts = text.split(matcher)
  const normalized = new Set(tokens.map((token) => token.toLocaleLowerCase()))
  return <>{parts.map((part, index): ReactNode => normalized.has(part.toLocaleLowerCase())
    ? <mark key={`${part}-${index}`}>{part}</mark>
    : part)}</>
}

const ResultCard = ({ result, query, onOpen }: {
  readonly result: SearchResult
  readonly query: string
  readonly onOpen: () => void
}) => (
  <button className="search-result" type="button" onClick={onOpen}>
    <header>
      <span className="search-result-path">
        {result.sessionTitle}
        <small>{result.threadPath.map((thread) => thread.label).join(" / ")}</small>
      </span>
      <time dateTime={result.occurredAt}>{formatTime(result.occurredAt)}</time>
    </header>
    <p><HighlightedText text={result.text} query={query} /></p>
    <footer>
      <span className="search-result-tags">
        <Badge>{result.author}</Badge>
        <Badge>{result.harness}</Badge>
        {result.toolLabel && <Badge>{result.toolLabel}</Badge>}
      </span>
      <strong>Open exact message <span aria-hidden="true">→</span></strong>
    </footer>
  </button>
)

export const SearchView = ({
  state,
  query,
  onSearch,
  onClose,
  onOpenResult,
  onNextPage,
  onRetry
}: Props) => {
  const [draft, setDraft] = useState(query)
  useEffect(() => setDraft(query), [query])
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", close)
    return () => window.removeEventListener("keydown", close)
  }, [onClose])

  const page = state._tag === "Ready" ? state.value : undefined
  return (
    <section className="search-stage" aria-labelledby="search-title">
      <div className="search-panel">
        <header className="search-panel-heading">
          <div>
            <Eyebrow>Canonical conversations</Eyebrow>
            <h1 id="search-title">Find the moment the team decided.</h1>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close Search">Close <kbd>Esc</kbd></Button>
        </header>

        <form
          className="search-form"
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            onSearch(draft.trim())
          }}
        >
          <span aria-hidden="true" className="search-icon">⌕</span>
          <label className="visually-hidden" htmlFor="project-search">Search conversations</label>
          <input
            id="project-search"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Search a decision, error, key, or phrase…"
            maxLength={200}
          />
          <Button type="submit">Search</Button>
        </form>

        {state._tag === "Loading" && (
          <div className="search-state" aria-live="polite">Searching shared conversations…</div>
        )}

        {state._tag === "Failed" && (
          <div className="search-state error-card" role="alert">
            <strong>Search is temporarily unavailable.</strong>
            <span>{state.message}</span>
            {state.retryable && <Button onClick={onRetry}>Try again</Button>}
          </div>
        )}

        {page && page.query === "" && (
          <div className="search-empty">
            <div className="search-empty-mark" aria-hidden="true">✦</div>
            <h2>Search the team’s shared trail</h2>
            <p>Try a decision such as “idempotency key”, an error message, or a tool action. Results open directly at the matching Event.</p>
            <div className="search-suggestions" aria-label="Suggested searches">
              {["idempotency key", "visibility timeout", "shadow writes"].map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => onSearch(suggestion)}>{suggestion}</button>
              ))}
            </div>
          </div>
        )}

        {page && page.query !== "" && (
          <div className="search-results">
            <header className="search-results-heading">
              <div>
                <strong>{page.results.length === 0 ? "No matching moments" : `Results for “${page.query}”`}</strong>
                <span>{page.indexedThrough ? `Indexed through ${formatTime(page.indexedThrough)}` : "The index is catching up"}</span>
              </div>
              {state._tag === "Ready" && state.refreshing && <span>Refreshing…</span>}
            </header>
            {page.results.length === 0 ? (
              <div className="search-no-results">
                <p>Try a shorter phrase or a concrete identifier from the conversation.</p>
              </div>
            ) : (
              <div className="search-result-list">
                {page.results.map((result) => (
                  <ResultCard
                    key={result.eventId}
                    result={result}
                    query={page.query}
                    onOpen={() => onOpenResult(result)}
                  />
                ))}
              </div>
            )}
            {page.nextCursor && (
              <Button className="search-next" variant="ghost" onClick={() => onNextPage(page.nextCursor!)}>
                Show more results
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
