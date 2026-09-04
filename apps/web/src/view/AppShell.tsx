import type { Workspace, WorkspaceProject } from "@atape/domain"
import { Button, Eyebrow } from "@atape/ui"
import { useEffect, useState, type ReactNode } from "react"
import type { LoadableView } from "../presenters/memoryPresenter"

const TapeMark = () => (
  <svg aria-hidden="true" className="brand-mark" viewBox="0 0 48 38">
    <path d="M8 4h32l5 7v16l-5 7H8l-5-7V11z" fill="currentColor" />
    <circle cx="18" cy="19" r="6" fill="#fffaf1" />
    <circle cx="30" cy="19" r="6" fill="#fffaf1" />
    <circle cx="18" cy="19" r="2" fill="#705844" />
    <circle cx="30" cy="19" r="2" fill="#705844" />
  </svg>
)

const ProjectTypeMark = ({ project }: { readonly project: WorkspaceProject }) => (
  <span className={`project-type-mark project-type-${project.type}`} aria-hidden="true">
    {project.type === "git" ? "⑂" : "▰"}
  </span>
)

type Props = {
  readonly children: ReactNode
  readonly workspace: LoadableView<Workspace>
  readonly currentTeamId: string
  readonly currentProjectId: string
  readonly onOpenSearch: () => void
  readonly onOpenProject: (teamId: string, projectId: string) => void
  readonly onRetryWorkspace: () => void
}

export const AppShell = ({
  children,
  workspace,
  currentTeamId,
  currentProjectId,
  onOpenSearch,
  onOpenProject,
  onRetryWorkspace
}: Props) => {
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const directory = workspace._tag === "Ready" ? workspace.value : undefined
  const currentTeam = directory?.teams.find((team) => team.id === currentTeamId)
  const currentProject = currentTeam?.projects.find((project) => project.id === currentProjectId)
  const teamName = currentTeam?.name ?? currentTeamId
  const projectName = currentProject?.name ?? currentProjectId

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault()
        onOpenSearch()
      }
      if (event.key === "Escape" && switcherOpen) {
        setSwitcherOpen(false)
      }
    }
    window.addEventListener("keydown", handleShortcut)
    return () => window.removeEventListener("keydown", handleShortcut)
  }, [onOpenSearch, switcherOpen])

  const toggleSwitcher = () => setSwitcherOpen((open) => !open)
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to project memory</a>
    <aside className="sidebar" aria-label="Workspace">
      <div className="brand"><TapeMark /><span>ATape</span></div>
      <button
        className="team-card workspace-trigger"
        type="button"
        aria-expanded={switcherOpen}
        aria-controls="workspace-switcher"
        onClick={toggleSwitcher}
      >
        <span>
          <strong>{teamName}</strong>
          <small>Shared agent memory</small>
        </span>
        <span className="workspace-chevron" aria-hidden="true">⌄</span>
      </button>
      <Eyebrow className="sidebar-label">Project memory</Eyebrow>
      <button
        className="project-pill workspace-trigger"
        type="button"
        aria-expanded={switcherOpen}
        aria-controls="workspace-switcher"
        onClick={toggleSwitcher}
      >
        <span className="project-dot" />
        <span>
          <strong>{projectName}</strong>
          {currentProject && <small>{currentProject.type === "git" ? "Git repository" : "Folder"}</small>}
        </span>
      </button>

      {switcherOpen && (
        <>
          <button
            className="workspace-switcher-backdrop"
            type="button"
            aria-label="Close Workspace switcher"
            onClick={() => setSwitcherOpen(false)}
          />
          <nav id="workspace-switcher" className="workspace-switcher" aria-label="Teams and Projects">
            <header>
              <span>
                <Eyebrow>Workspace</Eyebrow>
                <strong>Move to another project</strong>
              </span>
              {workspace._tag === "Ready" && workspace.refreshing && <small>Syncing…</small>}
            </header>
            {workspace._tag === "Loading" && <p className="workspace-switcher-state">Loading Teams…</p>}
            {workspace._tag === "Failed" && (
              <div className="workspace-switcher-state" role="alert">
                <p>{workspace.message}</p>
                {workspace.retryable && <Button onClick={onRetryWorkspace}>Try again</Button>}
              </div>
            )}
            {directory?.teams.map((team) => (
              <section className="workspace-team" key={team.id} aria-labelledby={`team-${team.id}`}>
                <h2 id={`team-${team.id}`}>{team.name}</h2>
                {team.projects.length === 0 ? (
                  <p className="workspace-no-projects">No captured projects yet</p>
                ) : (
                  <div className="workspace-projects">
                    {team.projects.map((project) => {
                      const selected = team.id === currentTeamId && project.id === currentProjectId
                      return (
                        <button
                          key={project.id}
                          type="button"
                          className={selected ? "current" : ""}
                          aria-current={selected ? "page" : undefined}
                          onClick={() => {
                            setSwitcherOpen(false)
                            onOpenProject(team.id, project.id)
                          }}
                        >
                          <ProjectTypeMark project={project} />
                          <span>
                            <strong>{project.name}</strong>
                            <small>
                              {project.type === "git" ? "Git repository" : "Folder"}
                              {project.sessionCount > 0 ? ` · ${project.activeSessionCount} active / ${project.sessionCount} total` : " · No sessions"}
                            </small>
                          </span>
                          {selected && <span className="workspace-current">Current</span>}
                        </button>
                      )
                    })}
                  </div>
                )}
              </section>
            ))}
          </nav>
        </>
      )}

      <div className="collector-status">
        <span className="pulse" />
        Collector healthy
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <div className="topbar-path">
          <span>{teamName}</span>
          <span aria-hidden="true">/</span>
          <strong>{projectName}</strong>
        </div>
        <button className="search-launcher" type="button" onClick={onOpenSearch}>
          <span aria-hidden="true">⌕</span>
          <span>Search conversations</span>
          <kbd>⌘ K</kbd>
        </button>
      </header>
      <main id="main-content" className="main-content">{children}</main>
    </div>
  </div>
}
