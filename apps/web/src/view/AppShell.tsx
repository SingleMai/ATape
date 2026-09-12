import type { User, Workspace } from "@atape/domain"
import { Avatar, BrandMark, Button } from "@atape/ui"
import { Link } from "@tanstack/react-router"
import { useEffect, useRef, useState, type ReactNode } from "react"
import type { LoadableView } from "../presenters/memoryPresenter"
import { useSettingsOverlay } from "../presenters/settingsOverlayContext"
import { SearchIcon, PanelIcon } from "./WorkspaceIcons"
import { t } from "../i18n"

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
  const { openSettings } = useSettingsOverlay()
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
  const teams = workspace._tag === "Ready" ? workspace.value.teams : []
  const team = teams.find((item) => item.id === currentTeamId) ?? teams[0]
  const teamIdentity = team && <>
    <span className="team-initial" aria-hidden="true">
      {team.name.slice(0, 1).toUpperCase()}
    </span>
    <span className="team-trigger-name">{team.name}</span>
  </>
  const projects = [...(team?.projects ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name))
  return (
    <div className={`app-shell workspace-shell${collapsed ? " sidebar-collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">
        {t("appShell.skipToConversations", "Skip to conversations")}
      </a>
      <aside className="sidebar project-sidebar" aria-label={t("appShell.workspace", "Workspace")}>
        <div className="sidebar-brand-row">
          <Link className="brand" to={team ? "/teams/$teamId" : "/"} params={team ? { teamId: team.id } : {}} aria-label={t("common.home", "ATape home")}>
            <BrandMark className="brand-mark" />
            <span>ATape</span>
          </Link>
          <button
            type="button"
            className="quiet-icon"
            aria-label={collapsed ? t("appShell.expandSidebar", "Expand sidebar") : t("appShell.collapseSidebar", "Collapse sidebar")}
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
          aria-label={t("appShell.searchAllConversations", "Search all conversations")}
          title={t("appShell.searchAllConversationsHint", "Search all conversations ({shortcut})", { shortcut: "⌘K" })}
        >
          <SearchIcon />
          <span>{t("appShell.searchEverything", "Search everything")}</span>
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
            {teams.length > 1 ? <button
              className="workspace-team-trigger"
              type="button"
              aria-label={t("appShell.teamOptionsFor", "Team options for {name}", { name: team.name })}
              title={t("appShell.teamOptionsFor", "Team options for {name}", { name: team.name })}
              aria-expanded={teamOpen}
              aria-controls="workspace-team-options"
              onClick={() => setTeamOpen(!teamOpen)}
            >
              {teamIdentity}
              <span className="team-trigger-chevron" aria-hidden="true">
                ⌄
              </span>
            </button> : <div className="workspace-team-trigger" title={team.name}>{teamIdentity}</div>}
            {teamOpen && teams.length > 1 && (
              <nav id="workspace-team-options" className="workspace-team-options" aria-label={t("appShell.teamOptions", "Team options")}>
                <strong>{team.name}</strong>
                <label>
                  {t("appShell.switchTeam", "Switch team")}
                  <select
                    aria-label={t("appShell.team", "Team")}
                    value={team.id}
                    onChange={(event) => {
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
              </nav>
            )}
          </div>
        )}
        <div id="project-directory" className="project-directory">
          {team && <button type="button" className="workspace-overview-link" aria-current={!currentProjectId ? "page" : undefined} onClick={() => onOpenTeam(team.id)}><PanelIcon />{t("appShell.overview", "Overview")}</button>}
          <p className="project-directory-label">{t("appShell.projects", "Projects")}</p>
          <nav className="project-navigation" aria-label={t("appShell.projects", "Projects")}>
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
                    aria-label={t("appShell.activeConversations", "{count} active conversations", { count: project.activeSessionCount })}
                  />
                )}
              </button>
            ))}
            {workspace._tag === "Loading" && <p role="status">{t("appShell.loadingProjects", "Loading projects…")}</p>}
            {workspace._tag === "Failed" && (
              <div role="alert">
                <p>{t(workspace.messageKey)}</p>
                <Button onClick={onRetryWorkspace}>{t("common.tryAgain", "Try again")}</Button>
              </div>
            )}
            {workspace._tag === "Ready" && projects.length === 0 && (
              <p>{t("appShell.noCapturedProjects", "No captured projects yet")}</p>
            )}
          </nav>
        </div>
        <nav className="workspace-account" aria-label={t("appShell.settings", "Settings")}>
          <button
            type="button"
            className="workspace-profile"
            onClick={() => openSettings()}
            title={t("appShell.accountSecurityFor", "Account security · {name}", { name: currentUser.displayName })}
            aria-label={t("appShell.openAccountSecurityFor", "Open account security for {name}", { name: currentUser.displayName })}
          >
            <span className="workspace-profile-avatar">
              <Avatar name={currentUser.displayName} src={currentUser.avatarUrl} size="small" />
            </span>
            <span className="workspace-profile-copy">
              <strong>{currentUser.displayName}</strong>
              <small>{t("appShell.accountAndSecurity", "Account & security")}</small>
            </span>
            <span className="workspace-profile-chevron" aria-hidden="true">
              ›
            </span>
          </button>
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
