import type { WorkspaceSearchResult } from "@atape/application"
import type { Workspace } from "@atape/domain"
import { Button } from "@atape/ui"
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { useNavigate } from "@tanstack/react-router"
import { SearchOverlayContext, type SearchSeed } from "../presenters/searchOverlayContext"
import { useWorkspaceSearchPresenter, type WorkspaceSearchViewModel } from "../presenters/searchPresenter"
import { useWorkspacePresenter } from "../presenters/workspacePresenter"
import { SearchIcon } from "./WorkspaceIcons"
import { formatDate, t } from "../i18n"

export const GlobalSearchProvider = ({ children }: { readonly children: ReactNode }) => {
  const [open, setOpen] = useState(false)
  const [seed, setSeed] = useState<SearchSeed>()
  const [started, setStarted] = useState(false)
  const openSearch = useCallback((next?: SearchSeed) => {
    if (next) setSeed({ ...next })
    setStarted(true)
    setOpen(true)
    document
      .querySelector<HTMLInputElement>(".global-search-dialog[open] input")
      ?.focus({ preventScroll: true })
  }, [])
  const close = useCallback(() => setOpen(false), [])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        openSearch()
      }
    }
    window.addEventListener("keydown", shortcut)
    return () => window.removeEventListener("keydown", shortcut)
  }, [openSearch])
  return (
    <SearchOverlayContext.Provider value={{ openSearch, hasSearch: started }}>
      {children}
      {started && <GlobalSearchDialog open={open} onClose={close} seed={seed} />}
    </SearchOverlayContext.Provider>
  )
}

const GlobalSearchDialog = ({
  open,
  onClose,
  seed
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly seed: SearchSeed | undefined
}) => {
  const workspace = useWorkspacePresenter()
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (!open) {
      element.close()
      return
    }
    element.showModal()
    input.current?.focus({ preventScroll: true })
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previousOverflow
      element.close()
    }
  }, [open])
  return (
    <dialog
      className="global-search-dialog"
      ref={dialog}
      aria-labelledby="global-search-title"
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          // Some browsers send focus to browser chrome at a native dialog boundary.
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>("button, input, select, a[href], [tabindex]")
          ).filter(
            (element) =>
              element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0
          )
          const first = controls[0]
          const last = controls.at(-1)
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }
        if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect()
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose()
        }
      }}
    >
      <header className="global-search-heading">
        <h2 id="global-search-title">{t("search.title", "Search everything")}</h2>
        <button type="button" className="search-dismiss" onClick={onClose} aria-label={t("search.closeSearch", "Close search")}>
          {t("search.close", "Close")} <kbd>Esc</kbd>
        </button>
      </header>
      {workspace.state._tag === "Loading" && (
        <p className="search-feedback" role="status">
          {t("search.loadingProjects", "Loading searchable projects…")}
        </p>
      )}
      {workspace.state._tag === "Failed" && (
        <div className="search-feedback" role="alert">
          <p>{t(workspace.state.messageKey)}</p>
          <Button onClick={workspace.reload}>{t("common.tryAgain", "Try again")}</Button>
        </div>
      )}
      {workspace.state._tag === "Ready" && (
        <SearchContents workspace={workspace.state.value} seed={seed} onClose={onClose} inputRef={input} />
      )}
    </dialog>
  )
}

const SearchContents = ({
  workspace,
  seed,
  onClose,
  inputRef
}: {
  readonly workspace: Workspace
  readonly seed: SearchSeed | undefined
  readonly onClose: () => void
  readonly inputRef: RefObject<HTMLInputElement | null>
}) => {
  const navigate = useNavigate()
  const presenter = useWorkspaceSearchPresenter(workspace, seed)
  const { draft, setDraft, query, teamId, projectId, projects, pageIndex, pending } = presenter
  const [filtersOpen, setFiltersOpen] = useState(false)
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 0
  }, [query, teamId, projectId, pageIndex])
  const openResult = (result: WorkspaceSearchResult) => {
    presenter.rememberQuery()
    onClose()
    void navigate({
      to: "/teams/$teamId/projects/$projectId/sessions/$sessionId",
      params: { teamId: result.teamId, projectId: result.projectId, sessionId: result.sessionId },
      search: { thread: result.threadId, event: result.eventId, from: "search", q: query }
    })
  }
  return (
    <>
      <form
        className="global-search-input"
        role="search"
        onSubmit={(event) => {
          event.preventDefault()
          presenter.submit()
        }}
      >
        <SearchIcon />
        <label className="visually-hidden" htmlFor="global-search-input">
          {t("search.searchConversations", "Search conversations")}
        </label>
        <input
          id="global-search-input"
          ref={inputRef}
          autoFocus
          value={draft}
          type="search"
          autoComplete="off"
          placeholder={t("search.placeholder", "Search a phrase, decision, or error…")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault()
              scroll.current?.querySelector<HTMLButtonElement>(".global-result")?.focus()
            }
          }}
        />
        <button type="submit" className="search-submit">
          {t("search.submit", "Search")}
        </button>
      </form>
      <div className="global-search-filters">
        <span>{!teamId && !projectId ? t("search.allProjects", "All projects") : t("search.searchingWithin", "Searching within")}</span>
        {teamId && (
          <button
            type="button"
            className="filter-chip"
            onClick={presenter.clearTeam}
            aria-label={t("search.removeTeamFilter", "Remove team filter")}
          >
            {workspace.teams.find((team) => team.id === teamId)?.name} ×
          </button>
        )}
        {projectId && (
          <button
            type="button"
            className="filter-chip"
            onClick={() => presenter.setProject("")}
            aria-label={t("search.removeProjectFilter", "Remove project filter")}
          >
            {projects.find((project) => project.projectId === projectId)?.projectName ??
              t("search.unavailableProject", "Unavailable project")}{" "}
            ×
          </button>
        )}
        <button
          type="button"
          className="filter-toggle"
          aria-expanded={filtersOpen}
          aria-controls="search-scope-filters"
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          {t("search.filters", "Filters")}{filtersOpen ? " −" : " +"}
        </button>
        {(teamId || projectId) && (
          <button type="button" className="filter-toggle" onClick={presenter.clearFilters}>
            {t("search.clearFilters", "Clear filters")}
          </button>
        )}
        {filtersOpen && (
          <div id="search-scope-filters" className="search-scope-fields">
            {workspace.teams.length > 1 && (
              <label>
                {t("search.team", "Team")}
                <select
                  aria-label={t("search.team", "Team")}
                  value={teamId}
                  onChange={(event) => presenter.setTeam(event.target.value)}
                >
                  <option value="">{t("search.allTeams", "All teams")}</option>
                  {workspace.teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              {t("search.project", "Project")}
              <select
                aria-label={t("search.project", "Project")}
                value={projectId}
                onChange={(event) => presenter.setProject(event.target.value)}
              >
                <option value="">{t("search.allProjects", "All projects")}</option>
                {projects
                  .filter((project) => !teamId || project.teamId === teamId)
                  .map((project) => (
                    <option key={project.projectId} value={project.projectId}>
                      {workspace.teams.length > 1 ? `${project.teamName} / ` : ""}
                      {project.projectName}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        )}
      </div>
      <div className="global-search-results" ref={scroll} aria-busy={pending}>
        <SearchResults
          presenter={presenter}
          multipleTeams={workspace.teams.length > 1}
          inputRef={inputRef}
          onOpenResult={openResult}
        />
      </div>
      <footer className="global-search-footer">
        <span>{t("search.footerNavigate", "↑ ↓ Navigate · Enter Open")}</span>
        <span>{t("search.footerShortcut", "⌘ K Search anywhere")}</span>
      </footer>
    </>
  )
}

const SearchResults = ({
  presenter,
  multipleTeams,
  inputRef,
  onOpenResult
}: {
  readonly presenter: WorkspaceSearchViewModel
  readonly multipleTeams: boolean
  readonly inputRef: RefObject<HTMLInputElement | null>
  readonly onOpenResult: (result: WorkspaceSearchResult) => void
}) => {
  const {
    validQuery,
    query,
    pending,
    projects,
    recent,
    setDraft,
    state,
    page,
    teamId,
    projectId,
    pageIndex
  } = presenter
  if (!validQuery)
    return (
      <p className="search-feedback" role="alert">
        {t("search.queryTooLong", "This query is too long. Try fewer words.")}
      </p>
    )
  if (!query && !pending)
    return (
      <div className="search-start">
        <h3>{t("search.startTitle", "Find it across your conversations.")}</h3>
        <p>{t("search.startBody", "Search messages, decisions, and tool activity across {count} projects.", { count: projects.length })}</p>
        {recent.length > 0 && (
          <div className="recent-searches">
            <span>{t("search.recentSearches", "Recent searches")}</span>
            {recent.map((item) => (
              <button type="button" key={item} onClick={() => setDraft(item)}>
                <SearchIcon />
                {item}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  if (pending)
    return (
      <p className="search-feedback" role="status">
        {t("search.searching", "Searching conversations…")}
      </p>
    )
  if (state._tag === "Failed")
    return (
      <div className="search-feedback" role="alert">
        <p>{t("search.failedTitle", "Search could not finish across the selected projects.")}</p>
        <p>{t(state.messageKey)}</p>
        {state.retryable && <Button onClick={presenter.reload}>{t("common.tryAgain", "Try again")}</Button>}
      </div>
    )
  if (!page) return null
  return (
    <>
      <p className="global-result-count" role="status">
        {t("search.resultCount", "{count, plural, one {# match} other {# matches}} on this page · Grouped by project", { count: page.results.length })}
      </p>
      {page.results.length === 0 && (
        <div className="search-start">
          <h3>{t("search.noMatchesTitle", "No matching conversations")}</h3>
          <p>{t("search.noMatchesBody", "Try fewer words or a specific phrase from the conversation.")}</p>
          {(teamId || projectId) && (
            <Button variant="ghost" onClick={presenter.clearFilters}>
              {t("search.searchAllProjects", "Search all projects")}
            </Button>
          )}
        </div>
      )}
      <div
        className="global-result-list"
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(".global-result")
          )
          const index = buttons.indexOf(event.target as HTMLButtonElement)
          if (index < 0) return
          event.preventDefault()
          if (index === 0 && event.key === "ArrowUp") inputRef.current?.focus()
          else buttons[Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))]?.focus()
        }}
      >
        {page.results.map((result) => (
          <button
            className="global-result"
            type="button"
            key={`${result.projectId}/${result.eventId}`}
            onClick={() => onOpenResult(result)}
          >
            <span className="global-result-context">
              {multipleTeams ? `${result.teamName} / ` : ""}
              {result.projectName}
              <span>{formatDate(new Date(result.occurredAt))}</span>
            </span>
            <strong>{result.sessionTitle}</strong>
            <p>
              <SearchExcerpt text={result.text} query={query} />
            </p>
            <small>
              {result.author} · {result.harness}
              {result.toolLabel ? ` · ${result.toolLabel}` : ""}
            </small>
          </button>
        ))}
      </div>
      {(pageIndex > 0 || Object.keys(page.nextCursors).length > 0) && (
        <nav className="global-search-pagination" aria-label={t("search.pages", "Search pages")}>
          <Button variant="ghost" disabled={pageIndex === 0} onClick={presenter.previous}>
            {t("common.previous", "Previous")}
          </Button>
          <span>{t("search.pageNumber", "Page {page}", { page: pageIndex + 1 })}</span>
          <Button
            variant="ghost"
            disabled={Object.keys(page.nextCursors).length === 0}
            onClick={presenter.next}
          >
            {t("common.next", "Next")}
          </Button>
        </nav>
      )}
    </>
  )
}

const SearchExcerpt = ({ text, query }: { readonly text: string; readonly query: string }) => {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  if (index < 0)
    return (
      <>
        {text.slice(0, 280)}
        {text.length > 280 ? "…" : ""}
      </>
    )
  const start = Math.max(0, index - 90),
    end = Math.min(text.length, index + query.length + 180)
  return (
    <>
      {start > 0 && "…"}
      {text.slice(start, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length, end)}
      {end < text.length && "…"}
    </>
  )
}
