import type { NextRequest } from "next/server";
import { authenticate, handleError, jsonOk } from "../../../lib/http/api.ts";
import {
  agentCountsByLocation,
  listAgents,
  listLocations,
  observedInvocationsByAgent,
  sessionCountsByLocation,
} from "../../../lib/db/repositories.ts";
import { toAgentItem, toLocationItem } from "../../../lib/http/dto.ts";
import type { AgentListResponse } from "../../../lib/contracts/api.ts";

/**
 * Effective agent registry, scoped by location.
 *
 * These are definitions read from the API for the configured location. They are
 * never evidence that an agent ran, so the response states that explicitly and
 * pairs each definition with the count of invocations actually observed.
 */


const NOTE =
  "These are agent definitions effective for each location, discovered from the upstream API. A definition is not " +
  "evidence of execution. The observed invocation count is the evidence-backed number of agent turns attributed to " +
  "that agent in observed assistant messages.";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const { db } = authenticate(request);

    const directories = new Map(listLocations(db).map((location) => [location.id, location.directory]));
    const observed = observedInvocationsByAgent(db);
    const agentCounts = agentCountsByLocation(db);
    const sessionCounts = sessionCountsByLocation(db);

    const body: AgentListResponse = {
      agents: listAgents(db).map((agent) =>
        toAgentItem(agent, directories.get(agent.locationId) ?? null, observed.get(`${agent.locationId}\u0000${agent.agentId}`) ?? 0),
      ),
      locations: listLocations(db).map((location) =>
        toLocationItem(location, agentCounts.get(location.id) ?? 0, sessionCounts.get(location.id) ?? 0),
      ),
      note: NOTE,
    };

    return jsonOk(body);
  } catch (cause) {
    return handleError(cause);
  }
}
