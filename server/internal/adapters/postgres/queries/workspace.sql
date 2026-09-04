-- name: ListWorkspaceTeams :many
SELECT id, name
FROM workspace_teams
ORDER BY lower(name), id;

-- name: ListWorkspaceProjects :many
SELECT projects.id, projects.team_id, projects.name, projects.project_type,
       projects.captured_through,
       COUNT(sessions.id)::bigint AS session_count,
       COUNT(sessions.id) FILTER (WHERE sessions.status = 'active')::bigint AS active_session_count
FROM canonical_projects projects
LEFT JOIN canonical_sessions sessions ON sessions.project_id = projects.id
GROUP BY projects.id
ORDER BY projects.team_id, lower(projects.name), projects.id;
