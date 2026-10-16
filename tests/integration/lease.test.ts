import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COLLECTOR_SCOPE,
  LeaseLostError,
  acquireLease,
  getLease,
  releaseLease,
  renewLease,
  withFence,
} from "../../lib/db/collection-state.ts";
import { openDatabase, type Db } from "../../lib/db/driver.ts";
import { runMigrations } from "../../lib/db/migrations.ts";
import { cleanupTempDirs, createTestDb, type TestDb } from "../helpers/harness.ts";

/**
 * Collector ownership and write fencing.
 *
 * This is the concurrency-critical part of the system. The property under test
 * is: a collector that has lost its lease can never commit a write, even if it
 * prepared that write before losing it.
 *
 * Two independent SQLite handles on the same file model two processes.
 */

const TTL = 30_000;

let primary: TestDb;
let rival: Db;

beforeEach(() => {
  primary = createTestDb();
  // A second connection to the same file, standing in for a second process.
  rival = openDatabase(primary.dbPath);
  runMigrations(rival, "rival");
});

afterEach(() => {
  try {
    rival.close();
  } catch {
    // Ignore.
  }
  primary.close();
  cleanupTempDirs();
});

describe("acquireLease", () => {
  it("grants the lease to a first claimant with epoch 1", () => {
    const handle = acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    expect(handle).not.toBeNull();
    expect(handle?.epoch).toBe(1);
    expect(getLease(primary.db, COLLECTOR_SCOPE)?.holderId).toBe("a");
  });

  it("refuses a second claimant while the first lease is live", () => {
    acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    expect(acquireLease(primary.db, COLLECTOR_SCOPE, "b", TTL, 2000)).toBeNull();
    expect(getLease(primary.db, COLLECTOR_SCOPE)?.holderId).toBe("a");
  });

  it("renews in place for the current holder without changing the epoch", () => {
    const first = acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    const again = acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 5000);
    expect(again?.epoch).toBe(first?.epoch);
    expect(getLease(primary.db, COLLECTOR_SCOPE)?.expiresAt).toBe(5000 + TTL);
  });

  it("takes over an expired lease and increments the epoch", () => {
    acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    const takeover = acquireLease(primary.db, COLLECTOR_SCOPE, "b", TTL, 1000 + TTL + 1);
    expect(takeover?.epoch).toBe(2);
    expect(getLease(primary.db, COLLECTOR_SCOPE)?.holderId).toBe("b");
  });

  it("does not hand over exactly at the deadline boundary without expiry", () => {
    acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    // At exactly `expiresAt` the lease is considered expired (`<=`).
    expect(acquireLease(primary.db, COLLECTOR_SCOPE, "b", TTL, 1000 + TTL)?.epoch).toBe(2);
  });

  it("lets exactly one of two simultaneous claimants win", () => {
    // Both observe an expired lease and race to take it.
    acquireLease(primary.db, COLLECTOR_SCOPE, "old", TTL, 1000);
    const at = 1000 + TTL + 1;
    const first = acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, at);
    const second = acquireLease(rival, COLLECTOR_SCOPE, "b", TTL, at);
    const winners = [first, second].filter((handle) => handle !== null);
    expect(winners).toHaveLength(1);
    expect(getLease(rival, COLLECTOR_SCOPE)?.epoch).toBe(2);
  });

  it("is visible across connections", () => {
    acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    expect(getLease(rival, COLLECTOR_SCOPE)?.holderId).toBe("a");
  });
});

describe("withFence", () => {
  it("runs the callback while the lease is held", () => {
    const handle = acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    expect(handle).not.toBeNull();
    const result = withFence(primary.db, handle!, 2000, () => "wrote");
    expect(result).toBe("wrote");
  });

  it("refuses to write after another process took over the lease", () => {
    // This is the central invariant: a stale collector cannot commit.
    const stale = acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    expect(stale).not.toBeNull();

    // Another process takes over once the lease expires.
    const takeover = acquireLease(rival, COLLECTOR_SCOPE, "b", TTL, 1000 + TTL + 1);
    expect(takeover?.epoch).toBe(2);

    expect(() => withFence(primary.db, stale!, 1000 + TTL + 2, () => "should not commit")).toThrow(LeaseLostError);
  });

  it("refuses to write after the lease simply expired", () => {
    const handle = acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    expect(() => withFence(primary.db, handle!, 1000 + TTL + 1, () => "nope")).toThrow(LeaseLostError);
  });

  it("refuses to write when the lease was released", () => {
    const handle = acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    releaseLease(primary.db, handle!);
    expect(() => withFence(primary.db, handle!, 2000, () => "nope")).toThrow(LeaseLostError);
  });

  it("propagates a callback error and rolls the transaction back", () => {
    const handle = acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    expect(() =>
      withFence(primary.db, handle!, 2000, () => {
        primary.db.exec("CREATE TABLE fence_probe (x INTEGER)");
        throw new Error("callback failed");
      }),
    ).toThrow("callback failed");

    // The table creation must have been rolled back with the transaction.
    const row = primary.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fence_probe'")
      .get() as { name?: string } | undefined;
    expect(row).toBeUndefined();
  });

  it("does not release the lease when the callback fails", () => {
    const handle = acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    try {
      withFence(primary.db, handle!, 2000, () => {
        throw new Error("boom");
      });
    } catch {
      // Expected.
    }
    expect(getLease(primary.db, COLLECTOR_SCOPE)?.holderId).toBe("a");
  });

  it("is re-entrant inside an outer transaction", () => {
    const handle = acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    const result = withFence(primary.db, handle!, 2000, () => withFence(primary.db, handle!, 2000, () => "nested"));
    expect(result).toBe("nested");
  });
});

describe("renewLease", () => {
  it("extends the deadline for the current holder", () => {
    const handle = acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    expect(renewLease(primary.db, handle!, 10_000)).toBe(true);
    expect(getLease(primary.db, COLLECTOR_SCOPE)?.expiresAt).toBe(10_000 + TTL);
  });

  it("fails once the epoch has advanced", () => {
    const stale = acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    acquireLease(rival, COLLECTOR_SCOPE, "b", TTL, 1000 + TTL + 1);
    expect(renewLease(primary.db, stale!, 1000 + TTL + 2)).toBe(false);
  });
});

describe("releaseLease", () => {
  it("removes the lease for the current holder", () => {
    const handle = acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    expect(releaseLease(primary.db, handle!)).toBe(true);
    expect(getLease(primary.db, COLLECTOR_SCOPE)).toBeNull();
  });

  it("refuses to release a lease held by someone else", () => {
    acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    const forged = { scope: COLLECTOR_SCOPE, holderId: "b", epoch: 1, ttlMs: TTL };
    expect(releaseLease(primary.db, forged)).toBe(false);
    expect(getLease(primary.db, COLLECTOR_SCOPE)?.holderId).toBe("a");
  });

  it("allows a fresh claimant after a clean release", () => {
    const handle = acquireLease(primary.db, COLLECTOR_SCOPE, "a", TTL, 1000);
    releaseLease(primary.db, handle!);
    const next = acquireLease(primary.db, COLLECTOR_SCOPE, "b", TTL, 1001);
    // A clean release resets ownership; the epoch restarts because the row is gone.
    expect(next?.epoch).toBe(1);
  });
});
