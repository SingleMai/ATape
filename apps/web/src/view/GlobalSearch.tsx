import type { WorkspaceSearchResult } from "@atape/application"
import type { Workspace } from "@atape/domain"
import { Button } from "@atape/ui"
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { useNavigate } from "@tanstack/react-router"
import { SearchOverlayContext, type SearchSeed } from "../presenters/searchOverlayContext"
import { useWorkspaceSearchPresenter, type WorkspaceSearchViewModel } from "../presenters/searchPresenter"
import { useWorkspacePresenter } from "../presenters/workspacePresenter"
import { SearchIcon } from "./WorkspaceIcons"

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
        <h2 id="global-search-title">Search everything</h2>
        <button type="button" className="search-dismiss" onClick={onClose} aria-label="Close search">
          Close <kbd>Esc</kbd>
        </button>
      </header>
      {workspace.state._tag === "Loading" && (
        <p className="search-feedback" role="status">
          Loading searchable projects…
        </p>
      )}
      {workspace.state._tag === "Failed" && (
        <div className="search-feedback" role="alert">
          <p>{workspace.state.message}</p>
          <Button onClick={workspace.reload}>Try again</Button>
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
          Search conversations
        </label>
        <input
          id="global-search-input"
          ref={inputRef}
          autoFocus
          value={draft}
          type="search"
          autoComplete="off"
          placeholder="Search a phrase, decision, or error…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault()
              scroll.current?.querySelector<HTMLButtonElement>(".global-result")?.focus()
            }
          }}
        />
        <button type="submit" className="search-submit">
          Search
        </button>
      </form>
      <div className="global-search-filters">
        <span>{!teamId && !projectId ? "All projects" : "Searching within"}</span>
        {teamId && (
          <button
            type="button"
            className="filter-chip"
            onClick={presenter.clearTeam}
            aria-label="Remove team filter"
          >
            {workspace.teams.find((team) => team.id === teamId)?.name} ×
          </button>
        )}
        {projectId && (
          <button
            type="button"
            className="filter-chip"
            onClick={() => presenter.setProject("")}
            aria-label="Remove project filter"
          >
            {projects.find((project) => project.projectId === projectId)?.projectName ??
              "Unavailable project"}{" "}
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
          Filters{filtersOpen ? " −" : " +"}
        </button>
        {(teamId || projectId) && (
          <button type="button" className="filter-toggle" onClick={presenter.clearFilters}>
            Clear filters
          </button>
        )}
        {filtersOpen && (
          <div id="search-scope-filters" className="search-scope-fields">
            {workspace.teams.length > 1 && (
              <label>
                Team
                <select
                  aria-label="Team"
                  value={teamId}
                  onChange={(event) => presenter.setTeam(event.target.value)}
                >
                  <option value="">All teams</option>
                  {workspace.teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Project
              <select
                aria-label="Project"
                value={projectId}
                onChange={(event) => presenter.setProject(event.target.value)}
              >
                <option value="">All projects</option>
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
        <span>↑ ↓ Navigate · Enter Open</span>
        <span>⌘ K Search anywhere</span>
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
        This query is too long. Try fewer words.
      </p>
    )
  if (!query && !pending)
    return (
      <div className="search-start">
        <h3>Find it across your conversations.</h3>
        <p>Search messages, decisions, and tool activity across {projects.length} projects.</p>
        {recent.length > 0 && (
          <div className="recent-searches">
            <span>Recent searches</span>
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
        Searching conversations…
      </p>
    )
  if (state._tag === "Failed")
    return (
      <div className="search-feedback" role="alert">
        <p>Search could not finish across the selected projects.</p>
        <p>{state.message}</p>
        {state.retryable && <Button onClick={presenter.reload}>Try again</Button>}
      </div>
    )
  if (!page) return null
  return (
    <>
      <p className="global-result-count" role="status">
        {page.results.length} {page.results.length === 1 ? "match" : "matches"} on this page · Grouped by
        project
      </p>
      {page.results.length === 0 && (
        <div className="search-start">
          <h3>No matching conversations</h3>
          <p>Try fewer words or a specific phrase from the conversation.</p>
          {(teamId || projectId) && (
            <Button variant="ghost" onClick={presenter.clearFilters}>
              Search all projects
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
              <span>{new Date(result.occurredAt).toLocaleDateString()}</span>
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
        <nav className="global-search-pagination" aria-label="Search pages">
          <Button variant="ghost" disabled={pageIndex === 0} onClick={presenter.previous}>
            Previous
          </Button>
          <span>Page {pageIndex + 1}</span>
          <Button
            variant="ghost"
            disabled={Object.keys(page.nextCursors).length === 0}
            onClick={presenter.next}
          >
            Next
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
