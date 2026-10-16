import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLookup } from "../../lib/auth/session.ts";
import { getCookieAuthState } from "../../lib/auth/dal.ts";

const mock = vi.hoisted(() => ({
  cookies: vi.fn(), io: vi.fn(), openDb: vi.fn(), dbState: vi.fn(), owner: vi.fn(),
  lookup: vi.fn<(...args: unknown[]) => SessionLookup>(), touch: vi.fn(),
}));
vi.mock("next/headers", () => ({ cookies: mock.cookies }));
vi.mock("next/cache", () => ({ io: mock.io }));
vi.mock("../../lib/config.ts", () => ({ getConfig: () => ({ auth: { cookieName: "orch_session" } }) }));
vi.mock("../../lib/db/index.ts", () => ({ ensureDatabaseReady: mock.openDb, getDatabaseState: mock.dbState }));
vi.mock("../../lib/db/auth-store.ts", () => ({ getOwner: mock.owner }));
vi.mock("../../lib/auth/session.ts", () => ({ lookupSession: mock.lookup, touchSessionIfStale: mock.touch }));

beforeEach(() => {
  vi.resetAllMocks();
  mock.cookies.mockResolvedValue({ get: () => ({ value: "synthetic-session" }) });
  mock.io.mockResolvedValue(undefined);
  mock.openDb.mockReturnValue({ testDatabase: true });
  mock.dbState.mockReturnValue({ ready: true });
  mock.owner.mockReturnValue({ id: 1 });
  mock.lookup.mockReturnValue({ status: "missing" });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("Server Component auth I/O ordering", () => {
  it("reads the cookie first and waits for io before opening SQLite or reading time", async () => {
    let releaseIo!: () => void;
    let enteredIo!: () => void;
    const entered = new Promise<void>((resolve) => { enteredIo = resolve; });
    const order: string[] = [];
    mock.cookies.mockResolvedValue({ get: () => { order.push("cookie"); return { value: "synthetic-session" }; } });
    mock.io.mockImplementation(() => { order.push("io"); enteredIo(); return new Promise<void>((resolve) => { releaseIo = resolve; }); });
    mock.openDb.mockImplementation(() => { order.push("database"); return { testDatabase: true }; });
    vi.spyOn(Date, "now").mockImplementation(() => { order.push("clock"); return 1234; });
    const result = getCookieAuthState();
    await entered;
    expect(order).toEqual(["cookie", "io"]);
    expect(mock.openDb).not.toHaveBeenCalled();
    expect(mock.lookup).not.toHaveBeenCalled();
    releaseIo();
    await result;
    expect(order).toEqual(["cookie", "io", "database", "clock"]);
    expect(mock.lookup).toHaveBeenCalledWith({ testDatabase: true }, "synthetic-session", 1234);
    expect(mock.touch).not.toHaveBeenCalled();
  });

  it("does not open the database when the cookie boundary suspends/aborts", async () => {
    const suspension = new Error("synthetic prerender suspension");
    mock.cookies.mockRejectedValue(suspension);
    await expect(getCookieAuthState()).rejects.toBe(suspension);
    expect(mock.io).not.toHaveBeenCalled();
    expect(mock.openDb).not.toHaveBeenCalled();
  });

  it("does not swallow io control flow as a database/auth error", async () => {
    const suspension = new Error("synthetic io suspension");
    mock.io.mockRejectedValue(suspension);
    await expect(getCookieAuthState()).rejects.toBe(suspension);
    expect(mock.openDb).not.toHaveBeenCalled();
    expect(mock.lookup).not.toHaveBeenCalled();
  });

  it.each(["missing", "expired", "revoked"] as const)("preserves fail-closed %s session behavior", async (status) => {
    mock.lookup.mockReturnValue({ status });
    expect(await getCookieAuthState()).toEqual({ authenticated: false, configured: true, expiresAt: null,
      reason: status === "expired" ? "Your session expired." : status === "revoked" ? "Your session was revoked." : null });
  });

  it("preserves successful session lookup without caching or extending its expiry", async () => {
    mock.lookup.mockReturnValue({ status: "valid", session: { id: "synthetic-id", token_hash: "synthetic-hash", created_at: 1, expires_at: 2000, last_seen_at: 1, revoked_at: null } });
    expect(await getCookieAuthState()).toEqual({ authenticated: true, configured: true, reason: null, expiresAt: 2000 });
    expect(mock.io).toHaveBeenCalledTimes(1);
    expect(mock.touch).not.toHaveBeenCalled();
  });

  it("still fails closed on database failure", async () => {
    mock.openDb.mockImplementation(() => { throw new Error("synthetic unavailable database"); });
    expect(await getCookieAuthState()).toMatchObject({ authenticated: false, configured: false, expiresAt: null });
    expect(mock.lookup).not.toHaveBeenCalled();
  });

  it("still reports unconfigured owner instead of permitting anonymous access", async () => {
    mock.owner.mockReturnValue(null);
    expect(await getCookieAuthState()).toMatchObject({ authenticated: false, configured: false, expiresAt: null });
  });
});
