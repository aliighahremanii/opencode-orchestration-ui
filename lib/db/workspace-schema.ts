/** Additive schema only. Legacy observations retain unknown connection identity. */
export const WORKSPACE_SCHEMA = [
  `CREATE TABLE observed_projects (
    id TEXT PRIMARY KEY, connection_id TEXT, source TEXT NOT NULL, upstream_id TEXT NOT NULL,
    root TEXT, display_name TEXT, alias TEXT, metadata_state TEXT NOT NULL,
    provenance TEXT NOT NULL, observed_at INTEGER NOT NULL
  )`,
  `CREATE TABLE workspace_identity (
    location_id TEXT PRIMARY KEY, project_key TEXT NOT NULL REFERENCES observed_projects(id),
    connection_id TEXT, source TEXT NOT NULL, directory TEXT NOT NULL,
    branch TEXT, vcs_state TEXT NOT NULL DEFAULT 'unknown', worktree_state TEXT NOT NULL DEFAULT 'unknown',
    provenance TEXT NOT NULL, observed_at INTEGER NOT NULL
  )`,
  `CREATE INDEX workspace_project_idx ON workspace_identity(project_key)`,
  `CREATE TABLE session_origins (session_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, source TEXT NOT NULL, upstream_id TEXT NOT NULL)`,
  `CREATE TABLE observed_assignments (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL,
    grouping TEXT NOT NULL CHECK(grouping = 'session-fallback'), boundary_evidence TEXT NOT NULL
  )`,
  `CREATE INDEX assignments_run_idx ON observed_assignments(run_id)`,
  `INSERT INTO observed_projects
    SELECT 'legacy-project:' || id, NULL, source, project_id, NULL, NULL, NULL, 'unknown', 'legacy-location', last_seen_at FROM locations`,
  `INSERT INTO workspace_identity(location_id,project_key,connection_id,source,directory,provenance,observed_at)
    SELECT id, 'legacy-project:' || id, NULL, source, canonical, 'legacy-location', last_seen_at FROM locations`,
  `INSERT INTO observed_assignments SELECT 'assignment:' || s.source || ':' || s.id, s.id, rs.run_id,
    'session-fallback', 'No verified assignment lifecycle; grouped by session, not by agent or trigger.'
    FROM sessions s JOIN run_sessions rs ON rs.session_id=s.id`,
  `CREATE TABLE question_jobs (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    assignment_id TEXT NOT NULL, question TEXT NOT NULL, state TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, reason TEXT,
    UNIQUE(owner_id, request_key)
  )`,
  `CREATE TABLE investigation_sessions (
    session_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES question_jobs(id),
    connection_id TEXT NOT NULL, source TEXT NOT NULL, assignment_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose='task-investigation'), created_at INTEGER NOT NULL
  )`,
];
