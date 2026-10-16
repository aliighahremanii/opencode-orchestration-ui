import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendAuthAudit,
  countActiveAuthSessions,
  createAuthSession,
  findAuthSessionByTokenHash,
  getOwner,
  listAuthAudit,
  purgeExpiredAuthSessions,
  revokeAllAuthSessions,
  revokeAuthSession,
  setOwner,
} from "../../lib/db/auth-store.ts";
import { hashPassword, verifyPassword } from "../../lib/auth/password.ts";
import { issueSession, lookupSession, endSession, verifyOwnerPassword } from "../../lib/auth/session.ts";
import { randomId, randomToken, sha256Hex } from "../../lib/util/ids.ts";
import { cleanupTempDirs, configureTestEnv, createTestDb, type TestDb } from "../helpers/harness.ts";

/**
 * Authentication persistence.
 *
 * The properties that matter: the raw session token is never stored, sessions
 * expire and can be revoked server-side, and the owner credential is stored only
 * as a hash.
 */

let test: TestDb;

beforeEach(() => {
  configureTestEnv({ ORCH_OWNER_PASSWORD: "correct horse", ORCH_SESSION_TTL_HOURS: "1" });
  test = createTestDb();
});

afterEach(() => {
  test.close();
  cleanupTempDirs();
  configureTestEnv();
});

describe("owner credential storage", () => {
  it("stores only a hash of the password", () => {
    setOwner(test.db, hashPassword("hunter2"), "scrypt", 1000);
    const owner = getOwner(test.db);
    expect(owner).not.toBeNull();
    expect(owner?.password_hash).not.toContain("hunter2");
    expect(verifyPassword("hunter2", owner!.password_hash)).toBe(true);
  });

  it("updates the credential in place rather than adding a second owner", () => {
    setOwner(test.db, hashPassword("one"), "scrypt", 1000);
    setOwner(test.db, hashPassword("two"), "scrypt", 2000);
    const rows = test.db.prepare("SELECT COUNT(*) AS n FROM app_owner").get() as { n: number };
    expect(rows.n).toBe(1);
    expect(verifyPassword("two", getOwner(test.db)!.password_hash)).toBe(true);
  });

  it("is empty before any credential is configured", () => {
    expect(getOwner(test.db)).toBeNull();
  });
});

describe("verifyOwnerPassword", () => {
  it("reports not-configured when there is no stored hash", () => {
    const result = verifyOwnerPassword("anything", null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-configured");
  });

  it("accepts the correct password", () => {
    expect(verifyOwnerPassword("hunter2", hashPassword("hunter2")).ok).toBe(true);
  });

  it("rejects a wrong password", () => {
    const result = verifyOwnerPassword("wrong", hashPassword("hunter2"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });
});

describe("session issue and lookup", () => {
  it("issues a token and stores only its digest", () => {
    const session = issueSession(test.db, 1000);
    expect(session.token.length).toBeGreaterThan(20);
    expect(session.expiresAt).toBe(1000 + 3_600_000);

    // The raw token must not appear anywhere in the row.
    const row = test.db.prepare("SELECT * FROM auth_sessions").get() as Record<string, unknown>;
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(session.token);
    expect(row.token_hash).toBe(sha256Hex(session.token));
  });

  it("resolves a valid token", () => {
    const session = issueSession(test.db, 1000);
    const lookup = lookupSession(test.db, session.token, 2000);
    expect(lookup.status).toBe("valid");
  });

  it("does not resolve an unknown token", () => {
    issueSession(test.db, 1000);
    expect(lookupSession(test.db, randomToken(32), 2000).status).toBe("missing");
  });

  it("does not resolve an empty token", () => {
    expect(lookupSession(test.db, "", 2000).status).toBe("missing");
    expect(lookupSession(test.db, "   ", 2000).status).toBe("missing");
  });

  it("reports an expired session as expired", () => {
    const session = issueSession(test.db, 1000);
    expect(lookupSession(test.db, session.token, session.expiresAt).status).toBe("expired");
  });

  it("treats the expiry instant itself as expired", () => {
    const session = issueSession(test.db, 1000);
    expect(lookupSession(test.db, session.token, session.expiresAt - 1).status).toBe("valid");
  });

  it("issues distinct tokens for distinct sessions", () => {
    const a = issueSession(test.db, 1000);
    const b = issueSession(test.db, 1000);
    expect(a.token).not.toBe(b.token);
    expect(lookupSession(test.db, a.token, 2000).status).toBe("valid");
    expect(lookupSession(test.db, b.token, 2000).status).toBe("valid");
  });

  it("is not fooled by a token that differs in one character", () => {
    const session = issueSession(test.db, 1000);
    const tampered = `${session.token.slice(0, -1)}${session.token.endsWith("A") ? "B" : "A"}`;
    expect(lookupSession(test.db, tampered, 2000).status).toBe("missing");
  });
});

describe("session revocation", () => {
  it("reports a revoked session as revoked", () => {
    const session = issueSession(test.db, 1000);
    expect(endSession(test.db, session.token, 2000)).toBe(true);
    expect(lookupSession(test.db, session.token, 3000).status).toBe("revoked");
  });

  it("returns false for an unknown token", () => {
    expect(endSession(test.db, randomToken(32), 1000)).toBe(false);
  });

  it("revokes every session at once", () => {
    const a = issueSession(test.db, 1000);
    const b = issueSession(test.db, 1000);
    expect(revokeAllAuthSessions(test.db, 2000)).toBe(2);
    expect(lookupSession(test.db, a.token, 3000).status).toBe("revoked");
    expect(lookupSession(test.db, b.token, 3000).status).toBe("revoked");
  });

  it("does not revoke the same session twice", () => {
    const session = issueSession(test.db, 1000);
    expect(revokeAuthSession(test.db, findAuthSessionByTokenHash(test.db, sha256Hex(session.token))!.id, 2000)).toBe(true);
    expect(revokeAuthSession(test.db, findAuthSessionByTokenHash(test.db, sha256Hex(session.token))!.id, 3000)).toBe(false);
  });
});

describe("session housekeeping", () => {
  it("purges expired sessions", () => {
    issueSession(test.db, 1000);
    const purged = purgeExpiredAuthSessions(test.db, 1000 + 3_600_000 + 1);
    expect(purged).toBe(1);
    expect(countActiveAuthSessions(test.db, 1000 + 3_600_000 + 1)).toBe(0);
  });

  it("keeps a live session", () => {
    issueSession(test.db, 1000);
    purgeExpiredAuthSessions(test.db, 2000);
    expect(countActiveAuthSessions(test.db, 2000)).toBe(1);
  });

  it("does not count a revoked session as active", () => {
    const session = issueSession(test.db, 1000);
    endSession(test.db, session.token, 1500);
    expect(countActiveAuthSessions(test.db, 2000)).toBe(0);
  });

  it("purges revoked sessions once their revocation is old", () => {
    const session = issueSession(test.db, 1000);
    endSession(test.db, session.token, 1500);
    purgeExpiredAuthSessions(test.db, 2000);
    expect(findAuthSessionByTokenHash(test.db, sha256Hex(session.token))).toBeNull();
  });
});

describe("auth audit", () => {
  it("records login outcomes without the password", () => {
    appendAuthAudit(test.db, "login-failed", null, 1000);
    appendAuthAudit(test.db, "login-succeeded", null, 2000);
    const rows = listAuthAudit(test.db, 10);
    expect(rows.map((row) => row.kind)).toEqual(["login-succeeded", "login-failed"]);
  });

  it("records the audit detail when one is supplied", () => {
    appendAuthAudit(test.db, "logout", "session revoked", 1000);
    expect(listAuthAudit(test.db, 1)[0]?.detail).toBe("session revoked");
  });

  it("never stores a password even if one were passed as detail", () => {
    // Guards against a future caller passing the credential into the detail field.
    appendAuthAudit(test.db, "login-failed", null, 1000);
    const rows = test.db.prepare("SELECT * FROM auth_audit").all() as Record<string, unknown>[];
    expect(JSON.stringify(rows)).not.toContain("correct horse");
  });
});

describe("session creation primitives", () => {
  it("rejects a duplicate token hash", () => {
    const hash = sha256Hex("fixed");
    createAuthSession(test.db, { id: randomId("sess"), tokenHash: hash, createdAt: 1, expiresAt: 2 });
    expect(() => createAuthSession(test.db, { id: randomId("sess"), tokenHash: hash, createdAt: 1, expiresAt: 2 })).toThrow();
  });
});
