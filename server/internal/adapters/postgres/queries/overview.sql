-- name: OverviewTeam :one
SELECT t.id,t.name,COALESCE(m.role,'')::text AS role,COALESCE(m.status,'')::text AS membership_status
FROM workspace_teams t LEFT JOIN team_memberships m ON m.team_id=t.id AND m.user_id=sqlc.arg(user_id)
WHERE t.id=sqlc.arg(team_id);

-- name: OverviewMembers :many
SELECT m.user_id::text AS id,u.display_name AS name,(m.status='active')::boolean AS current
FROM team_memberships m JOIN auth_users u ON u.id=m.user_id
WHERE m.team_id=$1 ORDER BY u.display_name,m.user_id LIMIT 100001;

-- name: OverviewProjects :many
SELECT id,team_id,name,project_type,state FROM canonical_projects WHERE team_id=$1 AND state<>'deleted' ORDER BY name,id LIMIT 100001;

-- name: OverviewSessions :many
SELECT s.* FROM canonical_sessions s JOIN canonical_projects p ON p.id=s.project_id
WHERE p.team_id=$1 AND p.state<>'deleted' AND s.record_state='active' ORDER BY s.id LIMIT 100001;

-- name: OverviewEvents :many
SELECT e.session_id,e.thread_id,e.author,
CASE WHEN e.author=s.actor_name THEN left(e.text,1500) ELSE right(e.text,1500) END::text AS text,
e.occurred_at,e.source_order,e.event_index,(t.parent_thread_id IS NULL)::boolean AS root
FROM visible_canonical_events e JOIN canonical_sessions s ON s.id=e.session_id
JOIN canonical_projects p ON p.id=s.project_id
JOIN visible_canonical_threads t ON t.session_id=e.session_id AND t.id=e.thread_id
WHERE p.team_id=sqlc.arg(team_id) AND p.state<>'deleted' AND s.record_state='active' AND e.kind='message'
AND e.occurred_at>=sqlc.arg(from_time)::timestamptz AND e.occurred_at<sqlc.arg(until_time)::timestamptz
ORDER BY e.session_id,e.source_order,e.event_index,e.id LIMIT 100001;

-- name: OverviewUsage :many
SELECT u.* FROM visible_canonical_usage u JOIN canonical_sessions s ON s.id=u.session_id
JOIN canonical_projects p ON p.id=s.project_id
WHERE p.team_id=sqlc.arg(team_id) AND p.state<>'deleted' AND s.record_state='active'
AND u.occurred_at>=sqlc.arg(from_time)::timestamptz AND u.occurred_at<sqlc.arg(until_time)::timestamptz
ORDER BY u.session_id,u.occurred_at,u.source_key LIMIT 100001;

-- name: OverviewUnknownTimes :one
SELECT count(DISTINCT e.session_id)::bigint FROM visible_canonical_events e
JOIN canonical_sessions s ON s.id=e.session_id JOIN canonical_projects p ON p.id=s.project_id
WHERE p.team_id=$1 AND p.state<>'deleted' AND s.record_state='active' AND e.kind='message' AND e.occurred_at<'2000-01-01'::timestamptz;
