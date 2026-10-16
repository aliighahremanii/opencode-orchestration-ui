import { execute, queryAll, queryOne, type Db } from "./driver.ts";

/**
 * Authentication persistence: the single owner credential and opaque browser
 * sessions.
 *
 * Only a hash of the owner password and hashes of session tokens are stored.
 * A leaked database therefore does not yield a usable credential, and the raw
 * session token never leaves the HttpOnly cookie.
 */

export interface OwnerRow {
  id: number;
  password_hash: string;
  algo: string;
  created_at: number;
  updated_at: number;
}

export function getOwner(db: Db): OwnerRow | null {
  return queryOne<OwnerRow>(db, "SELECT * FROM app_owner WHERE id = 1") ?? null;
}

export function setOwner(db: Db, passwordHash: string, algo: string, now: number): void {
  execute(
    db,
    `INSERT INTO app_owner (id, password_hash, algo, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, algo = excluded.algo, updated_at = excluded.updated_at`,
    [passwordHash, algo, now, now],
  );
}

export interface AuthSessionRow {
  id: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

export function createAuthSession(
  db: Db,
  input: { id: string; tokenHash: string; createdAt: number; expiresAt: number },
): void {
  execute(
    db,
    "INSERT INTO auth_sessions (id, token_hash, created_at, expires_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)",
    [input.id, input.tokenHash, input.createdAt, input.expiresAt, input.createdAt],
  );
}

export function findAuthSessionByTokenHash(db: Db, tokenHash: string): AuthSessionRow | null {
  return queryOne<AuthSessionRow>(db, "SELECT * FROM auth_sessions WHERE token_hash = ?", [tokenHash]) ?? null;
}

export function touchAuthSession(db: Db, id: string, now: number): void {
  execute(db, "UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?", [now, id]);
}

export function revokeAuthSession(db: Db, id: string, now: number): boolean {
  return execute(db, "UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now, id]).changes === 1;
}

export function revokeAllAuthSessions(db: Db, now: number): number {
  return execute(db, "UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL", [now]).changes;
}

export function purgeExpiredAuthSessions(db: Db, now: number): number {
  return execute(db, "DELETE FROM auth_sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)", [
    now,
    now,
  ]).changes;
}

export function countActiveAuthSessions(db: Db, now: number): number {
  return (
    queryOne<{ n: number }>(
      db,
      "SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ?",
      [now],
    )?.n ?? 0
  );
}

export function appendAuthAudit(db: Db, kind: string, detail: string | null, now: number): void {
  execute(db, "INSERT INTO auth_audit (at, kind, detail) VALUES (?, ?, ?)", [now, kind, detail]);
}

export interface AuthAuditRow {
  id: number;
  at: number;
  kind: string;
  detail: string | null;
}

export function listAuthAudit(db: Db, limit: number): AuthAuditRow[] {
  return queryAll<AuthAuditRow>(db, "SELECT * FROM auth_audit ORDER BY at DESC, id DESC LIMIT ?", [limit]);
}
