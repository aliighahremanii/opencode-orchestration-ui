import { dedupeKey, deterministicId } from "../util/ids.ts";
import type { ActivityEvent, ActivityKind, InvocationEvidence, ObservationSource, RootRun, RootRunStatus, UpstreamOutcome } from "../domain/types.ts";
import type { InvocationRecord } from "../db/repositories.ts";
import { redactPersistedField, redactStructuredLeaves, sanitiseForDisplay, summariseLine } from "../util/redact.ts";
import type {
  UpstreamAssistantMessage,
  UpstreamMessage,
  UpstreamSessionInfo,
} from "../upstream/schema.ts";

/**
 * Pure normalization.
 *
 * Everything in this module is a deterministic function of its inputs: no
 * clock, no database, no network. That is what makes the risky parts (identity,
 * deduplication, ordering, ancestry, redaction) directly testable, and it is why
 * the collector only has to decide *what* to hand in, not *how* it is turned
 * into records.
 */

/** Recent-activity window used by the run status heuristic. */
export const RECENT_ACTIVITY_WINDOW_MS = 5 * 60 * 1000;

export const SUMMARY_MAX_CHARS = 240;

// --- identity --------------------------------------------------------------

/**
 * Upstream session ids are documented as `^ses`, message ids as `^msg_`. Ids
 * that do not match are treated as unusable rather than stored: an id we cannot
 * key on would silently create duplicate records.
 */
export function isUsableSessionId(value: string): boolean {
  return /^ses[A-Za-z0-9_-]*$/.test(value);
}

export function isUsableMessageId(value: string): boolean {
  return /^msg_[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Stable key identifying one activity event.
 *
 * Message id + part index + kind: an assistant message and its individual tool
 * parts are distinct events, and re-ingesting the same message produces the same
 * key so the unique index collapses it.
 */
export function activityDedupeKey(input: {
  locationId: string;
  sessionId: string;
  messageId: string;
  partIndex: number;
  kind: ActivityKind;
}): string {
  return dedupeKey([input.locationId, input.sessionId, input.messageId, input.partIndex, input.kind]);
}

export function activityEventId(key: string): string {
  return `act_${key.slice(0, 32)}`;
}

// --- ordering and deduplication -------------------------------------------

export function messageSortKey(message: UpstreamMessage): [number, string] {
  return [message.created, message.id];
}

/**
 * Sort by upstream creation time, breaking ties by id.
 *
 * Upstream returns messages newest-first by default and the collector pages
 * through them, so arrival order is not chronological. Sorting here is what
 * makes `sequence` a stable, replayable position instead of an artifact of the
 * fetch order.
 */
export function sortMessages(messages: readonly UpstreamMessage[]): UpstreamMessage[] {
  return [...messages].sort((a, b) => {
    const [aTime, aId] = messageSortKey(a);
    const [bTime, bId] = messageSortKey(b);
    if (aTime !== bTime) return aTime - bTime;
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });
}

export interface DedupeResult {
  readonly unique: UpstreamMessage[];
  readonly duplicateCount: number;
}

/**
 * Collapse repeated message ids.
 *
 * A message can appear on more than one page (upstream pages by cursor while
 * messages are appended), and an assistant message is re-observed as it
 * streams. The last occurrence wins: for a given id, upstream returns its
 * current state, so the later copy is the fresher snapshot.
 */
export function dedupeMessages(messages: readonly UpstreamMessage[]): DedupeResult {
  const byId = new Map<string, { message: UpstreamMessage; index: number }>();
  let duplicateCount = 0;
  messages.forEach((message, index) => {
    const existing = byId.get(message.id);
    if (existing !== undefined) duplicateCount += 1;
    byId.set(message.id, { message, index });
  });
  const unique = [...byId.values()].sort((a, b) => a.index - b.index).map((entry) => entry.message);
  return { unique, duplicateCount };
}

export interface OrderedMessages extends DedupeResult {
  readonly outOfOrderCount: number;
  readonly sorted: UpstreamMessage[];
}

/**
 * Deduplicate, then sort.
 *
 * `outOfOrderCount` is the number of arrivals that were older than the message
 * immediately before them in the arrival sequence — a linear, bounded measure of
 * how scrambled the upstream paging was. It is a diagnostic, not a correctness
 * signal: the sort below is what makes `sequence` stable regardless.
 */
export function normaliseMessageOrder(messages: readonly UpstreamMessage[]): OrderedMessages {
  const deduped = dedupeMessages(messages);
  const sorted = sortMessages(deduped.unique);
  let outOfOrderCount = 0;
  for (let i = 1; i < deduped.unique.length; i += 1) {
    const previous = deduped.unique[i - 1];
    const current = deduped.unique[i];
    if (previous !== undefined && current !== undefined) {
      const [previousTime, previousId] = messageSortKey(previous);
      const [currentTime, currentId] = messageSortKey(current);
      if (currentTime < previousTime || (currentTime === previousTime && currentId < previousId)) {
        outOfOrderCount += 1;
      }
    }
  }
  return { ...deduped, sorted, outOfOrderCount };
}

// --- message summaries -----------------------------------------------------

function messageKind(message: UpstreamMessage): ActivityKind {
  switch (message.type) {
    case "user":
      return "message-user";
    case "system":
      return "message-system";
    case "synthetic":
      return "message-synthetic";
    case "skill":
      return "message-skill";
    case "shell":
      return "message-shell";
    case "compaction":
      return "message-compaction";
    case "idle":
      return "message-idle";
    case "assistant":
      return "message-assistant";
    case "agent-switched":
      return "agent-switched";
    case "model-switched":
      return "model-switched";
    case "location-switched":
      return "location-switched";
  }
}

function labelForKind(kind: ActivityKind): string {
  switch (kind) {
    case "message-user":
      return "User";
    case "message-system":
      return "System";
    case "message-synthetic":
      return "Synthetic";
    case "message-skill":
      return "Skill";
    case "message-shell":
      return "Shell";
    case "message-compaction":
      return "Compaction";
    case "message-idle":
      return "Idle";
    case "message-assistant":
      return "Assistant";
    case "agent-switched":
      return "Agent switched";
    case "model-switched":
      return "Model switched";
    case "location-switched":
      return "Location switched";
    case "tool":
      return "Tool";
  }
}

export interface MessageContent {
  readonly body: string | null;
  readonly actorAgentId: string | null;
  readonly upstreamOutcome: UpstreamOutcome | null;
}

/** Extract the text an activity event should carry for a non-assistant message. */
export function messageContent(message: UpstreamMessage): MessageContent {
  switch (message.type) {
    case "user":
    case "system":
    case "synthetic":
      return { body: message.text, actorAgentId: null, upstreamOutcome: null };
    case "skill":
      return {
        body: [message.name === null ? null : `skill: ${message.name}`, message.text].filter((v): v is string => v !== null).join("\n"),
        actorAgentId: null,
        upstreamOutcome: null,
      };
    case "shell":
      return {
        body: [
          `$ ${message.command}`,
          `status: ${message.status}${message.exit === null ? "" : ` (exit ${message.exit})`}`,
          message.output ?? "",
        ]
          .filter((part) => part !== "")
          .join("\n"),
        actorAgentId: null,
        upstreamOutcome: null,
      };
    case "compaction":
      return {
        body: [`status: ${message.status}`, message.reason === null ? "" : `reason: ${message.reason}`, message.summary ?? ""]
          .filter((part) => part !== "")
          .join("\n"),
        actorAgentId: null,
        upstreamOutcome: null,
      };
    case "idle":
      return { body: `upstream reported outcome: ${message.outcome}`, actorAgentId: null, upstreamOutcome: message.outcome };
    case "agent-switched":
      return {
        body: message.previousAgentId === null ? `now: ${message.agentId}` : `${message.previousAgentId} → ${message.agentId}`,
        actorAgentId: message.agentId,
        upstreamOutcome: null,
      };
    case "model-switched":
      return {
        body: `${message.modelProviderId}/${message.modelId}`,
        actorAgentId: null,
        upstreamOutcome: null,
      };
    case "location-switched":
      return { body: message.directory, actorAgentId: null, upstreamOutcome: null };
    case "assistant":
      return {
        body: assistantText(message),
        actorAgentId: message.agentId,
        upstreamOutcome: null,
      };
  }
}

export function assistantText(message: UpstreamAssistantMessage): string {
  return message.parts
    .map((part) => {
      if (part.kind === "text") return part.text;
      if (part.kind === "reasoning") return `[reasoning] ${part.text}`;
      return "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

// --- activity + invocation normalization -----------------------------------

export interface NormalizeActivityInput {
  readonly locationId: string;
  readonly sessionId: string;
  readonly runId: string | null;
  readonly source: ObservationSource;
  readonly messages: readonly UpstreamMessage[];
  readonly contentMaxChars: number;
  readonly ingestedAt: number;
}

export interface NormalizedActivity {
  readonly events: ActivityEvent[];
  readonly invocations: InvocationRecord[];
  readonly duplicateMessageCount: number;
  readonly outOfOrderCount: number;
}

/**
 * Turn one session's messages into activity events and evidence-backed
 * invocations.
 *
 * Invocation rule (the central evidence rule of this application): an
 * `Invocation` is created only from an assistant message that carries an
 * explicit `agent` field. Agent definitions, child sessions, and session-level
 * attribution never produce an invocation.
 */
export function normalizeSessionActivity(input: NormalizeActivityInput): NormalizedActivity {
  const ordered = normaliseMessageOrder(input.messages);
  const events: ActivityEvent[] = [];
  const invocations: InvocationRecord[] = [];

  let lastTrigger: { id: string; type: string } | null = null;
  const orderedForOutcome = ordered.sorted;

  // Pre-compute the next idle outcome after each position, so an assistant turn
  // can be annotated with the upstream-reported outcome that *followed* it.
  //
  // Only a following report counts. A session that was resumed inherits nothing
  // from an earlier idle: an outcome observed before an invocation is not
  // evidence about that invocation, so an invocation with no associated report
  // stays `unknown` rather than borrowing a stale success.
  const outcomeAfter = new Map<number, UpstreamOutcome>();
  {
    let pending: UpstreamOutcome | null = null;
    for (let i = orderedForOutcome.length - 1; i >= 0; i -= 1) {
      const message = orderedForOutcome[i];
      if (message === undefined) continue;
      if (message.type === "idle") {
        pending = message.outcome;
      } else if (pending !== null) {
        outcomeAfter.set(i, pending);
      }
    }
  }

  ordered.sorted.forEach((message, sequence) => {
    const kind = messageKind(message);
    const content = messageContent(message);
    const key = activityDedupeKey({
      locationId: input.locationId,
      sessionId: input.sessionId,
      messageId: message.id,
      partIndex: 0,
      kind,
    });
    const body = content.body;
    const display = sanitiseForDisplay(body, input.contentMaxChars);
    const summarySource =
      message.type === "assistant"
        ? assistantSummary(message)
        : message.type === "shell"
          ? `$ ${message.command}`
          : message.type === "idle"
            ? `upstream reported outcome: ${message.outcome}`
            : (body ?? "");
    const summary = summariseLine(summarySource, SUMMARY_MAX_CHARS);

    events.push({
      id: activityEventId(key),
      dedupeKey: key,
      locationId: input.locationId,
      sessionId: input.sessionId,
      runId: input.runId,
      kind,
      messageId: message.id,
      partIndex: 0,
      sequence,
      occurredAt: message.created,
      actorAgentId: redactPersistedField(content.actorAgentId),
      toolName: null,
      toolStatus: null,
      summary: summary.text,
      content: display.text === "" ? null : display.text,
      truncated: display.truncated,
      redacted: display.redacted || summary.redacted,
      upstreamOutcome: content.upstreamOutcome,
      source: input.source,
    });

    if (message.type === "assistant") {
      // Tool parts become their own events so the timeline shows each call.
      message.parts.forEach((part, partIndex) => {
        if (part.kind !== "tool") return;
        const toolKey = activityDedupeKey({
          locationId: input.locationId,
          sessionId: input.sessionId,
          messageId: message.id,
          partIndex: partIndex + 1,
          kind: "tool",
        });
        const toolBody = [
          `${part.name} (${part.status})`,
          part.inputSummary === "" ? "" : `input: ${part.inputSummary}`,
          part.outputSummary === null ? "" : `output: ${part.outputSummary}`,
          part.errorMessage === null ? "" : `error: ${part.errorMessage}`,
        ]
          .filter((line) => line !== "")
          .join("\n");
        const toolDisplay = sanitiseForDisplay(toolBody, input.contentMaxChars);
        const toolSummary = summariseLine(`${labelForKind("tool")}: ${part.name} (${part.status})`, SUMMARY_MAX_CHARS);
        events.push({
          id: activityEventId(toolKey),
          dedupeKey: toolKey,
          locationId: input.locationId,
          sessionId: input.sessionId,
          runId: input.runId,
          kind: "tool",
          messageId: message.id,
          partIndex: partIndex + 1,
          sequence,
          occurredAt: part.created,
          actorAgentId: redactPersistedField(message.agentId),
          toolName: redactPersistedField(part.name),
          toolStatus: part.status,
          summary: toolSummary.text,
          content: toolDisplay.text === "" ? null : toolDisplay.text,
          truncated: toolDisplay.truncated,
          // The tool input and output were redacted *before* they were summarised
          // (see `UpstreamAssistantTool.redacted`), so the redactor applied here
          // sees already-clean text and cannot report the removal itself. The
          // provenance carried on the part is what keeps the badge honest.
          redacted: toolDisplay.redacted || part.redacted,
          upstreamOutcome: null,
          source: input.source,
        });
      });

      if (message.agentId !== null && input.runId !== null) {
        const evidence: InvocationEvidence = {
          rule: "assistant-message-agent-field",
          assistantMessageId: message.id,
          assistantMessageType: "assistant",
          agentField: message.agentId,
          triggerMessageId: lastTrigger?.id ?? null,
          triggerMessageType: lastTrigger?.type ?? null,
          toolCallIds: message.parts.filter((part) => part.kind === "tool").map((part) => part.id),
          observedAt: input.ingestedAt,
        };
        invocations.push({
          id: deterministicId("inv", [input.locationId, input.sessionId, message.id]),
          runId: input.runId,
          sessionId: input.sessionId,
          locationId: input.locationId,
          agentId: message.agentId,
          modelProviderId: message.modelProviderId,
          modelId: message.modelId,
          startedAt: message.created,
          endedAt: message.completed,
          triggerMessageId: lastTrigger?.id ?? null,
          assistantMessageId: message.id,
          toolCallCount: evidence.toolCallIds.length,
          upstreamOutcome: outcomeAfter.get(sequence) ?? null,
          confidence: "verified",
          evidenceJson: JSON.stringify(redactStructuredLeaves(evidence)),
          source: input.source,
          seenAt: input.ingestedAt,
        });
      }
    }

    if (message.type === "user" || message.type === "system" || message.type === "synthetic") {
      lastTrigger = { id: message.id, type: message.type };
    }
  });

  return {
    events,
    invocations,
    duplicateMessageCount: ordered.duplicateCount,
    outOfOrderCount: ordered.outOfOrderCount,
  };
}

function assistantSummary(message: UpstreamAssistantMessage): string {
  const text = assistantText(message);
  if (text !== "") return text;
  const tools = message.parts.filter((part) => part.kind === "tool");
  if (tools.length > 0) return `tool calls: ${tools.map((tool) => tool.name).join(", ")}`;
  return "assistant message with no textual content";
}

// --- ancestry --------------------------------------------------------------

export interface RunTreeSessionInput {
  readonly projectId?: string;
  readonly projectKey?: string;
  readonly connectionId?: string | null;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly locationId: string;
  readonly title: string | null;
  readonly agentId: string | null;
  readonly upstreamOutcome: UpstreamOutcome | null;
  readonly timeCreated: number;
  readonly timeUpdated: number;
  readonly timeIdle: number | null;
  /**
   * The provenance of this observation. Carried per session, not taken from the
   * collector's current mode, so a run rebuilt while the collector is in live
   * mode cannot relabel a session that was observed from fixtures.
   */
  readonly source: ObservationSource;
}

export interface OrphanSession {
  readonly sessionId: string;
  readonly parentId: string;
  readonly reason: "parent-not-observed";
}

export interface RunTreeResult {
  readonly runs: RootRun[];
  readonly memberships: { runId: string; sessionId: string; depth: number }[];
  readonly orphans: OrphanSession[];
  readonly cycles: string[][];
  readonly crossLocation: { sessionId: string; parentId: string }[];
  /**
   * Parent links that cross a provenance boundary. A session observed from
   * fixtures is never attached to a parent observed upstream (or vice versa), so
   * a rebuilt run can never blend the two and relabel one as the other.
   */
  readonly crossSource: { sessionId: string; parentId: string }[];
}

export function runIdFor(locationId: string, rootSessionId: string): string {
  return deterministicId("run", [locationId, rootSessionId]);
}

export function deriveRunStatus(root: RunTreeSessionInput, lastActivityAt: number, now: number): RootRunStatus {
  if (root.upstreamOutcome !== null) {
    switch (root.upstreamOutcome) {
      case "succeeded":
        return "reported-succeeded";
      case "failed":
        return "reported-failed";
      case "interrupted":
        return "reported-interrupted";
    }
  }
  if (root.timeIdle !== null) return "reported-idle";
  if (now - lastActivityAt <= RECENT_ACTIVITY_WINDOW_MS) return "recently-active";
  return "unknown";
}

/**
 * Build the observed run forest.
 *
 * Rules that matter for correctness:
 *
 * - A session whose parent was never observed becomes its own root and is
 *   reported as an orphan. It is never silently dropped, and it is never
 *   attached to a guessed parent.
 * - A parent link that crosses locations is not followed: a descendant in
 *   another project is not part of this run.
 * - A parent link that crosses a provenance boundary is not followed either, so
 *   a fixture observation is never attached to an upstream parent (or the
 *   reverse). A run's `source` is its root's observed provenance, never the
 *   collector's current mode, so switching from fixtures to live cannot relabel
 *   already-observed data.
 * - Parent chains are walked with a visited set, so a malformed cycle terminates
 *   and is reported instead of hanging the collector.
 */
export function buildRunTree(
  sessions: readonly RunTreeSessionInput[],
  options: { readonly now: number },
): RunTreeResult {
  // Deduplicate by session id first. A paging bug or an overlapping fetch can
  // repeat a session; without this, a repeated session would be counted twice in
  // its run and could double-report an orphan or a cross-location link.
  const deduped = [...new Map(sessions.map((session) => [session.sessionId, session])).values()];

  const byId = new Map(deduped.map((session) => [session.sessionId, session]));
  const orphans: OrphanSession[] = [];
  const cycles: string[][] = [];
  const crossLocation: { sessionId: string; parentId: string }[] = [];
  const crossSource: { sessionId: string; parentId: string }[] = [];
  const rootOf = new Map<string, { root: RunTreeSessionInput; depth: number }>();

  for (const session of deduped) {
    const visited: string[] = [];
    const seen = new Set<string>();
    let current = session;
    let depth = 0;
    let root = session;

    for (;;) {
      if (seen.has(current.sessionId)) {
        cycles.push([...visited, current.sessionId]);
        root = session;
        depth = 0;
        break;
      }
      seen.add(current.sessionId);
      visited.push(current.sessionId);

      if (current.parentId === null) {
        root = current;
        break;
      }
      const parent = byId.get(current.parentId);
      if (parent === undefined) {
        orphans.push({ sessionId: current.sessionId, parentId: current.parentId, reason: "parent-not-observed" });
        root = current;
        break;
      }
      if (parent.source !== current.source) {
        crossSource.push({ sessionId: current.sessionId, parentId: parent.sessionId });
        root = current;
        break;
      }
      if ((current.projectId && parent.projectId && current.projectId !== parent.projectId) || (parent.locationId !== current.locationId && !(current.connectionId && current.connectionId === parent.connectionId && current.projectKey && current.projectKey === parent.projectKey))) {
        crossLocation.push({ sessionId: current.sessionId, parentId: parent.sessionId });
        root = current;
        break;
      }
      current = parent;
      depth += 1;
    }

    rootOf.set(session.sessionId, { root, depth });
  }

  const grouped = new Map<string, { root: RunTreeSessionInput; members: { sessionId: string; depth: number }[] }>();
  for (const session of deduped) {
    const entry = rootOf.get(session.sessionId);
    if (entry === undefined) continue;
    const existing = grouped.get(entry.root.sessionId);
    if (existing === undefined) {
      grouped.set(entry.root.sessionId, { root: entry.root, members: [{ sessionId: session.sessionId, depth: entry.depth }] });
    } else {
      existing.members.push({ sessionId: session.sessionId, depth: entry.depth });
    }
  }

  const runs: RootRun[] = [];
  const memberships: { runId: string; sessionId: string; depth: number }[] = [];

  for (const { root, members } of grouped.values()) {
    const runId = runIdFor(root.locationId, root.sessionId);
    const lastActivityAt = Math.max(...members.map((member) => byId.get(member.sessionId)?.timeUpdated ?? root.timeUpdated));
    runs.push({
      id: runId,
      locationId: root.locationId,
      rootSessionId: root.sessionId,
      title: root.title,
      startedAt: root.timeCreated,
      lastActivityAt,
      status: deriveRunStatus(root, lastActivityAt, options.now),
      agentId: root.agentId,
      sessionCount: members.length,
      // Provenance comes from the root observation, not from the collector's
      // current mode: a run rebuilt while the collector is live must still be
      // labelled `fixture` if its sessions were observed from fixtures.
      source: root.source,
    });
    for (const member of members) {
      memberships.push({ runId, sessionId: member.sessionId, depth: member.depth });
    }
  }

  runs.sort((a, b) => b.lastActivityAt - a.lastActivityAt || (a.id < b.id ? -1 : 1));
  return { runs, memberships, orphans, cycles, crossLocation, crossSource };
}

/** Convert a validated upstream session into the tree input shape. */
export function toRunTreeSession(session: UpstreamSessionInfo, locationId: string, source: ObservationSource): RunTreeSessionInput {
  return {
    projectId:session.projectId,
    sessionId: session.id,
    parentId: session.parentId,
    locationId,
    title: session.title,
    agentId: session.agentId,
    upstreamOutcome: session.outcome,
    timeCreated: session.timeCreated,
    timeUpdated: session.timeUpdated,
    timeIdle: session.timeIdle,
    source,
  };
}

/**
 * Convert a *stored* session into the tree input shape.
 *
 * The run forest is rebuilt from everything already persisted, not only from the
 * sessions returned by the current bounded fetch. Rebuilding from the fetch
 * window alone would delete the run identity of every older root that the window
 * no longer covers, even though those sessions are still stored and still
 * browsable.
 *
 * The stored `source` is carried through. It is the provenance the session was
 * *observed* with, not the collector's current mode, so rebuilding the forest
 * while the collector has switched to live mode cannot relabel a fixture
 * observation as upstream.
 */
export function fromStoredSession(session: {
  readonly projectId?: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly locationId: string;
  readonly title: string | null;
  readonly agentId: string | null;
  readonly upstreamOutcome: UpstreamOutcome | null;
  readonly timeCreated: number;
  readonly timeUpdated: number;
  readonly timeIdle: number | null;
  readonly source: ObservationSource;
}): RunTreeSessionInput {
  return {
    projectId:session.projectId,
    sessionId: session.id,
    parentId: session.parentId,
    locationId: session.locationId,
    title: session.title,
    agentId: session.agentId,
    upstreamOutcome: session.upstreamOutcome,
    timeCreated: session.timeCreated,
    timeUpdated: session.timeUpdated,
    timeIdle: session.timeIdle,
    source: session.source,
  };
}
