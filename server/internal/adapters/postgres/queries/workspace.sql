-- name: ListWorkspaceTeams :many
SELECT teams.id, teams.name
FROM workspace_teams teams
JOIN team_memberships membership ON membership.team_id = teams.id
WHERE membership.user_id = sqlc.arg(user_id)
  AND membership.status = 'active'
ORDER BY lower(teams.name), teams.id;

-- name: ListWorkspaceProjects :many
SELECT projects.id, projects.team_id, projects.name, projects.project_type, projects.state,
       projects.captured_through,
       COUNT(sessions.id)::bigint AS session_count,
       COUNT(sessions.id) FILTER (
           WHERE sessions.status = 'active'
             AND sessions.updated_at >= sqlc.arg(active_since)::timestamptz
       )::bigint AS active_session_count
FROM canonical_projects projects
JOIN team_memberships membership ON membership.team_id = projects.team_id
LEFT JOIN canonical_sessions sessions ON sessions.project_id = projects.id
WHERE membership.user_id = sqlc.arg(user_id)
  AND membership.status = 'active'
  AND projects.state <> 'deleted'
GROUP BY projects.id
ORDER BY projects.team_id, lower(projects.name), projects.id;
