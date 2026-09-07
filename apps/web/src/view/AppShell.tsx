import type { User, Workspace } from "@atape/domain"
import { Avatar, Button } from "@atape/ui"
import { Link } from "@tanstack/react-router"
import { useEffect, useRef, useState, type ReactNode } from "react"
import type { LoadableView } from "../presenters/memoryPresenter"
import { TapeMark } from "./AccessPrimitives"
import { SearchIcon, PanelIcon } from "./WorkspaceIcons"

type Props = {
  readonly children: ReactNode
  readonly workspace: LoadableView<Workspace>
  readonly currentUser: User
  readonly currentTeamId: string | undefined
  readonly currentProjectId: string | undefined
  readonly onOpenSearch?: () => void
  readonly onOpenTeam: (teamId: string) => void
  readonly onOpenProject: (teamId: string, projectId: string) => void
  readonly onRetryWorkspace: () => void
}

export const AppShell = ({
  children,
  workspace,
  currentUser,
  currentTeamId,
  currentProjectId,
  onOpenSearch,
  onOpenTeam,
  onOpenProject,
  onRetryWorkspace
}: Props) => {
  const [collapsed, setCollapsed] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches
  )
  const [teamOpen, setTeamOpen] = useState(false)
  const teamControl = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!teamOpen) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !teamControl.current?.contains(event.target)) setTeamOpen(false)
    }
    document.addEventListener("pointerdown", dismiss)
    return () => document.removeEventListener("pointerdown", dismiss)
  }, [teamOpen])
  const [projectFilter, setProjectFilter] = useState("")
  const teams = workspace._tag === "Ready" ? workspace.value.teams : []
  const team = teams.find((item) => item.id === currentTeamId) ?? teams[0]
  const projects = [...(team?.projects ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((project) => project.name.toLocaleLowerCase().includes(projectFilter.toLocaleLowerCase()))
  return (
    <div className={`app-shell workspace-shell${collapsed ? " sidebar-collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">
        Skip to conversations
      </a>
      <aside className="sidebar project-sidebar" aria-label="Workspace">
        <div className="sidebar-brand-row">
          <Link className="brand" to="/" aria-label="ATape home">
            <TapeMark className="brand-mark" />
            <span>ATape</span>
          </Link>
          <button
            type="button"
            className="quiet-icon"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            aria-controls="project-directory"
            onClick={() => {
              setCollapsed(!collapsed)
              setTeamOpen(false)
            }}
          >
            <PanelIcon />
          </button>
        </div>
        <button
          type="button"
          className="workspace-search"
          onClick={onOpenSearch}
          aria-label="Search all conversations"
          title="Search all conversations (⌘K)"
        >
          <SearchIcon />
          <span>Search everything</span>
          <kbd>⌘ K</kbd>
        </button>
        {team && (
          <div
            className="workspace-team-control"
            ref={teamControl}
            onKeyDown={(event) => {
              if (event.key === "Escape" && teamOpen) {
                event.preventDefault()
                event.stopPropagation()
                setTeamOpen(false)
                teamControl.current?.querySelector<HTMLButtonElement>(".workspace-team-trigger")?.focus()
              }
            }}
          >
            <button
              className="workspace-team-trigger"
              type="button"
              aria-label={`Team options for ${team.name}`}
              title={`${team.name} · Team settings`}
              aria-expanded={teamOpen}
              aria-controls="workspace-team-options"
              onClick={() => setTeamOpen(!teamOpen)}
            >
              <span className="team-initial" aria-hidden="true">
                {team.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="team-trigger-name">{team.name}</span>
              <span className="team-trigger-chevron" aria-hidden="true">
                ⌄
              </span>
            </button>
            {teamOpen && (
              <nav id="workspace-team-options" className="workspace-team-options" aria-label="Team options">
                <strong>{team.name}</strong>
                {teams.length > 1 && (
                  <label>
                    Switch team
                    <select
                      aria-label="Team"
                      value={team.id}
                      onChange={(event) => {
                        setProjectFilter("")
                        setTeamOpen(false)
                        onOpenTeam(event.target.value)
                      }}
                    >
                      {teams.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <Link
                  to="/teams/$teamSlug/settings/access"
                  params={{ teamSlug: team.slug }}
                  onClick={() => setTeamOpen(false)}
                >
                  Team settings
                </Link>
              </nav>
            )}
          </div>
        )}
        <div id="project-directory" className="project-directory">
          <label className="project-filter">
            <span>Projects</span>
            <input
              type="search"
              aria-label="Filter projects"
              placeholder="Find a project…"
              value={projectFilter}
              onChange={(event) => setProjectFilter(event.target.value)}
            />
          </label>
          <nav className="project-navigation" aria-label="Projects">
            {projects.map((project) => (
              <button
                type="button"
                key={project.id}
                title={project.name}
                aria-current={project.id === currentProjectId ? "page" : undefined}
                onClick={() => {
                  if (team) onOpenProject(team.id, project.id)
                }}
              >
                <span aria-hidden="true" className="project-nav-mark">
                  {project.name.slice(0, 1).toUpperCase()}
                </span>
                <span>{project.name}</span>
                {project.activeSessionCount > 0 && (
                  <span
                    className="project-active-dot"
                    aria-label={`${project.activeSessionCount} active conversations`}
                  />
                )}
              </button>
            ))}
            {workspace._tag === "Loading" && <p role="status">Loading projects…</p>}
            {workspace._tag === "Failed" && (
              <div role="alert">
                <p>{workspace.message}</p>
                <Button onClick={onRetryWorkspace}>Try again</Button>
              </div>
            )}
            {workspace._tag === "Ready" && projects.length === 0 && (
              <p>{projectFilter ? "No matching projects" : "No captured projects yet"}</p>
            )}
          </nav>
        </div>
        <nav className="workspace-account" aria-label="Settings">
          <Link
            className="workspace-profile"
            to="/settings/account"
            title={`Account security · ${currentUser.displayName}`}
            aria-label={`Open account security for ${currentUser.displayName}`}
          >
            <span className="workspace-profile-avatar">
              <Avatar name={currentUser.displayName} src={currentUser.avatarUrl} size="small" />
            </span>
            <span className="workspace-profile-copy">
              <strong>{currentUser.displayName}</strong>
              <small>Account &amp; security</small>
            </span>
            <span className="workspace-profile-chevron" aria-hidden="true">
              ›
            </span>
          </Link>
        </nav>
      </aside>
      <div className="workspace">
        <main id="main-content" className="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  )
}
