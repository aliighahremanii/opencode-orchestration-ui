import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, configureTestEnv, cleanupTempDirs, fixtureDir, type TestDb } from "../helpers/harness.ts";
import { readOffice } from "../../lib/http/office.ts";
import { runCycle } from "../../lib/collector/collector.ts";
import { FixtureUpstreamSource } from "../../lib/upstream/fixture-source.ts";
import { getConfig } from "../../lib/config.ts";
import { listInvocations, upsertInvocation } from "../../lib/db/repositories.ts";

let test: TestDb;
beforeEach(async () => {
  configureTestEnv({ ORCH_UPSTREAM_MODE: "fixture", ORCH_FIXTURE_STATIC_TIME: "1" });
  test = createTestDb();
  await runCycle({ db: test.db, source: new FixtureUpstreamSource({ fixtureDir: fixtureDir(), shiftToNow: false }),
    config: getConfig().collector, now: () => Date.now(), log: { info() {}, warn() {}, error() {} } }, "office-test");
});
afterEach(() => { test.close(); cleanupTempDirs(); configureTestEnv(); });

describe("authenticated office read model", () => {
  it("returns stored evidence, source, coverage and both blocked operations", () => {
    const result = readOffice(test.db);
    expect(result.source).toBe("fixture");
    expect(result.invocations.length).toBeGreaterThan(0);
    expect(result.dispatch.create).toBe(false);
    expect(result.dispatch.continue).toBe(false);
    for (const invocation of result.invocations) {
      expect(invocation.assistantMessageId).toMatch(/^msg_/);
      if (invocation.action) {
        expect(invocation.action.messageId).toBe(invocation.assistantMessageId);
        expect(invocation.action.source).toBe(invocation.source);
        expect(invocation.action.sessionId).toBe(invocation.sessionId);
      }
    }
    expect(readOffice(test.db).invocations).toEqual(result.invocations);
  });

  it("never guesses activity from the session or matches another provenance", () => {
    test.db.exec("UPDATE activity_events SET source = 'upstream'");
    const result = readOffice(test.db);
    expect(result.invocations.every((invocation) => invocation.task === null && invocation.action === null)).toBe(true);
  });

  it("includes observed runs without inventing invocations when assistant evidence is absent", () => {
    test.db.exec("DELETE FROM invocations");
    const result = readOffice(test.db);
    expect(result.invocations).toEqual([]);
    expect(result.runs.length).toBeGreaterThan(0);
    expect(result.agents.length).toBeGreaterThan(0);
    expect(result.agents.every((agent) => agent.observedInvocationCount === 0)).toBe(true);
  });

  it("discloses the bounded invocation window without destroying history", () => {
    const original = listInvocations(test.db, { limit: 1 })[0];
    for (let index = 0; index < 105; index++) upsertInvocation(test.db, {
      ...original, id: `office-copy-${index}`, assistantMessageId: `msg_copy_${index}`,
      evidenceJson: JSON.stringify(original.evidence), seenAt: Date.now(),
    });
    const result = readOffice(test.db);
    expect(result.invocations).toHaveLength(100);
    expect(result.coverage.totalInvocations).toBeGreaterThan(100);
    expect(result.coverage.limited).toBe(true);
    expect(listInvocations(test.db, { limit: 500 })).toHaveLength(result.coverage.totalInvocations);
  });

  it("rolls back its read transaction after failure so later requests can recover", () => {
    test.db.exec("ALTER TABLE activity_events RENAME TO unavailable_events");
    expect(() => readOffice(test.db)).toThrow();
    test.db.exec("ALTER TABLE unavailable_events RENAME TO activity_events");
    expect(readOffice(test.db).invocations.length).toBeGreaterThan(0);
  });
});
