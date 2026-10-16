import type { Db } from "../db/driver.ts";
import { queryAll } from "../db/driver.ts";
import type { ActivityRow } from "../db/repositories.ts";
import {
  agentCountsByLocation, sessionCountsByLocation, countAgents, countInvocations, countOpenGaps, getRootRun, getSession,
  listAgents, listInvocations, listLocations, listRootRuns, toActivityEvent,
} from "../db/repositories.ts";
import { listCheckpoints } from "../db/collection-state.ts";
import { collectorHealth, sourceSummary, toActivityItem, toAgentItem, toInvocationItem, toLocationItem, toRunSummary } from "./dto.ts";
import type { OfficeResponse } from "../contracts/api.ts";

/** A bounded, coherent WAL read snapshot. No write lock and no upstream I/O. */
export function readOffice(db: Db, now = Date.now()): OfficeResponse {
  db.exec("BEGIN");
  try {
    const locations = listLocations(db);
    const directories = new Map(locations.map((location) => [location.id, location.directory]));
    const records = listInvocations(db, { limit: 100 });
    const runs = new Map(listRootRuns(db, { limit: 100 }).map((run) => [run.id, run]));
    const invocations = records.map((record) => {
      const session = getSession(db, record.sessionId);
      const run = getRootRun(db, record.runId);
      if (run !== null) runs.set(run.id, run);
      // Source, location and message identity are all required. Time proximity,
      // ancestry and session attribution cannot establish invocation activity.
      const messageEvent = (messageId: string | null) => messageId === null ? null : queryAll<ActivityRow>(db,
        `SELECT * FROM activity_events WHERE session_id = ? AND location_id = ? AND source = ?
         AND message_id = ? ORDER BY occurred_at DESC, sequence DESC, id ASC LIMIT 1`,
        [record.sessionId, record.locationId, record.source, messageId],
      ).map(toActivityEvent).map(toActivityItem)[0] ?? null;
      return {
        ...toInvocationItem(record), locationId: record.locationId,
        projectId: session?.source === record.source ? session.projectId : null,
        assistantMessageId: record.assistantMessageId,
        task: messageEvent(record.triggerMessageId),
        action: messageEvent(record.assistantMessageId),
      };
    });
    const agents = listAgents(db).slice(0, 500).map((agent) => toAgentItem(agent,
      directories.get(agent.locationId) ?? null,
      // Count only matching provenance, not an identically named fixture agent.
      Number(db.prepare("SELECT COUNT(*) AS n FROM invocations WHERE location_id = ? AND agent_id = ? AND source = ?")
        .get(agent.locationId, agent.agentId, agent.source)?.n ?? 0),
    ));
    const totalInvocations = countInvocations(db);
    const totalAgents = countAgents(db);
    const agentCounts = agentCountsByLocation(db);
    const sessionCounts = sessionCountsByLocation(db);
    const result: OfficeResponse = {
      generatedAt: now, source: sourceSummary().mode, collector: collectorHealth(db, now), agents,
      locations: locations.slice(0, 100).map((location) => toLocationItem(location, agentCounts.get(location.id) ?? 0, sessionCounts.get(location.id) ?? 0)),
      runs: [...runs.values()].map((run) => toRunSummary(run, directories.get(run.locationId) ?? null,
        Number(db.prepare("SELECT COUNT(*) AS n FROM invocations WHERE run_id = ?").get(run.id)?.n ?? 0))),
      invocations,
      coverage: {
        openGaps: countOpenGaps(db), partialStreams: listCheckpoints(db).filter((item) => item.partial).length,
        totalInvocations, totalAgents, totalLocations: locations.length,
        limited: totalInvocations > invocations.length || totalAgents > agents.length || locations.length > 100,
      },
      dispatch: { create: false, continue: false,
        reason: "Unavailable: the configured upstream write contract has not been authenticated and verified. No prompt will be sent." },
    };
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
