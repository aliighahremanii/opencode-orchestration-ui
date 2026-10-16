/**
 * Runtime validation for upstream payloads.
 *
 * The observer talks to an *experimental* HTTP surface whose documented shapes
 * may change between versions. Instead of trusting TypeScript types (which are
 * erased at runtime), every payload is validated field by field before it is
 * persisted. A payload that does not match a documented shape is rejected and
 * reported; it is never coerced into a plausible-looking record.
 *
 * Validators are intentionally forward compatible: unknown extra properties are
 * ignored, but required fields must be present with the documented type.
 */

import { redactStructuredLeaves } from "../util/redact.ts";

export type ValidationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly string[] };

export class IssueCollector {
  readonly issues: string[] = [];

  add(path: string, message: string): void {
    this.issues.push(`${path}: ${message}`);
  }

  result<T>(value: T): ValidationResult<T> {
    return this.issues.length === 0 ? { ok: true, value } : { ok: false, issues: this.issues };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown, path: string, issues: IssueCollector): Record<string, unknown> | null {
  if (!isRecord(value)) {
    issues.add(path, `expected an object, received ${describe(value)}`);
    return null;
  }
  return value;
}

export function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

export function reqString(record: Record<string, unknown>, key: string, path: string, issues: IssueCollector): string {
  const value = record[key];
  if (typeof value !== "string") {
    issues.add(`${path}.${key}`, `expected a string, received ${describe(value)}`);
    return "";
  }
  return value;
}

export function optString(record: Record<string, unknown>, key: string, path: string, issues: IssueCollector): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    issues.add(`${path}.${key}`, `expected a string or null, received ${describe(value)}`);
    return null;
  }
  return value;
}

export function reqNumber(record: Record<string, unknown>, key: string, path: string, issues: IssueCollector): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.add(`${path}.${key}`, `expected a finite number, received ${describe(value)}`);
    return 0;
  }
  return value;
}

export function optNumber(record: Record<string, unknown>, key: string, path: string, issues: IssueCollector): number | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.add(`${path}.${key}`, `expected a finite number or null, received ${describe(value)}`);
    return null;
  }
  return value;
}

export function reqBool(record: Record<string, unknown>, key: string, path: string, issues: IssueCollector): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    issues.add(`${path}.${key}`, `expected a boolean, received ${describe(value)}`);
    return false;
  }
  return value;
}

export function reqEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
  issues: IssueCollector,
): T {
  const value = record[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    issues.add(`${path}.${key}`, `expected one of ${allowed.join("|")}, received ${describe(value)}`);
    return allowed[0] as T;
  }
  return value as T;
}

export function optEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string,
  issues: IssueCollector,
): T | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    issues.add(`${path}.${key}`, `expected one of ${allowed.join("|")} or null, received ${describe(value)}`);
    return null;
  }
  return value as T;
}

export function reqArray(record: Record<string, unknown>, key: string, path: string, issues: IssueCollector): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    issues.add(`${path}.${key}`, `expected an array, received ${describe(value)}`);
    return [];
  }
  return value;
}

// --- shapes ----------------------------------------------------------------

export interface UpstreamServerInfo {
  readonly version: string;
  readonly pid: number;
  readonly urls: readonly string[];
  readonly tmpPath: string;
}

export function validateServerInfo(payload: unknown): ValidationResult<UpstreamServerInfo> {
  const issues = new IssueCollector();
  const record = asRecord(payload, "$", issues);
  if (record === null) return issues.result({ version: "", pid: 0, urls: [], tmpPath: "" });
  const version = reqString(record, "version", "$", issues);
  const pid = reqNumber(record, "pid", "$", issues);
  const urlsRaw = reqArray(record, "urls", "$", issues);
  const urls = urlsRaw.filter((u): u is string => typeof u === "string");
  if (urls.length !== urlsRaw.length) {
    issues.add("$.urls", "expected every entry to be a string");
  }
  const paths = asRecord(record.paths, "$.paths", issues);
  const tmpPath = paths === null ? "" : reqString(paths, "tmp", "$.paths", issues);
  return issues.result({ version, pid, urls, tmpPath });
}

export interface UpstreamLocationRef {
  readonly directory: string;
}

export interface UpstreamLocationInfo {
  readonly directory: string;
  readonly projectId: string;
  readonly projectDirectory: string;
  readonly canonical: string;
}

export function validateLocationInfo(payload: unknown): ValidationResult<UpstreamLocationInfo> {
  const issues = new IssueCollector();
  const record = asRecord(payload, "$", issues);
  if (record === null) return issues.result({ directory: "", projectId: "", projectDirectory: "", canonical: "" });
  const directory = reqString(record, "directory", "$", issues);
  const project = asRecord(record.project, "$.project", issues);
  const projectId = project === null ? "" : reqString(project, "id", "$.project", issues);
  const projectDirectory = project === null ? "" : reqString(project, "directory", "$.project", issues);
  const canonical = project === null ? "" : reqString(project, "canonical", "$.project", issues);
  return issues.result({ directory, projectId, projectDirectory, canonical });
}

export interface UpstreamAgentInfo {
  readonly id: string;
  readonly name: string;
  readonly mode: "subagent" | "primary" | "all";
  readonly hidden: boolean;
  readonly description: string | null;
  readonly modelProviderId: string | null;
  readonly modelId: string | null;
}

export function validateAgentList(payload: unknown): ValidationResult<{ location: UpstreamLocationRef; agents: UpstreamAgentInfo[] }> {
  const issues = new IssueCollector();
  const record = asRecord(payload, "$", issues);
  if (record === null) return issues.result({ location: { directory: "" }, agents: [] });

  const locationRecord = asRecord(record.location, "$.location", issues);
  const directory = locationRecord === null ? "" : reqString(locationRecord, "directory", "$.location", issues);

  const dataRaw = reqArray(record, "data", "$", issues);
  const agents: UpstreamAgentInfo[] = [];
  dataRaw.forEach((entry, index) => {
    const path = `$.data[${index}]`;
    const agent = asRecord(entry, path, issues);
    if (agent === null) return;
    const model = agent.model === undefined || agent.model === null ? null : asRecord(agent.model, `${path}.model`, issues);
    agents.push({
      id: reqString(agent, "id", path, issues),
      name: reqString(agent, "name", path, issues),
      mode: reqEnum(agent, "mode", ["subagent", "primary", "all"] as const, path, issues),
      hidden: reqBool(agent, "hidden", path, issues),
      description: optString(agent, "description", path, issues),
      modelProviderId: model === null ? null : optString(model, "providerID", `${path}.model`, issues),
      modelId: model === null ? null : optString(model, "id", `${path}.model`, issues),
    });
  });

  return issues.result({ location: { directory }, agents });
}

export type UpstreamOutcome = "succeeded" | "failed" | "interrupted";

export interface UpstreamSessionInfo {
  readonly id: string;
  readonly parentId: string | null;
  readonly projectId: string;
  readonly agentId: string | null;
  readonly modelProviderId: string | null;
  readonly modelId: string | null;
  readonly title: string | null;
  readonly subpath: string | null;
  readonly outcome: UpstreamOutcome | null;
  readonly timeCreated: number;
  readonly timeUpdated: number;
  readonly timeIdle: number | null;
  readonly timeArchived: number | null;
  readonly locationDirectory: string;
}

export function validateSessionsResponse(
  payload: unknown,
): ValidationResult<{ sessions: UpstreamSessionInfo[]; nextCursor: string | null }> {
  const issues = new IssueCollector();
  const record = asRecord(payload, "$", issues);
  if (record === null) return issues.result({ sessions: [], nextCursor: null });

  const dataRaw = reqArray(record, "data", "$", issues);
  const sessions: UpstreamSessionInfo[] = [];
  dataRaw.forEach((entry, index) => {
    const path = `$.data[${index}]`;
    const session = asRecord(entry, path, issues);
    if (session === null) return;
    const time = asRecord(session.time, `${path}.time`, issues);
    const model = session.model === undefined || session.model === null ? null : asRecord(session.model, `${path}.model`, issues);
    const location = asRecord(session.location, `${path}.location`, issues);
    sessions.push({
      id: reqString(session, "id", path, issues),
      parentId: optString(session, "parentID", path, issues),
      projectId: reqString(session, "projectID", path, issues),
      agentId: optString(session, "agent", path, issues),
      modelProviderId: model === null ? null : optString(model, "providerID", `${path}.model`, issues),
      modelId: model === null ? null : optString(model, "id", `${path}.model`, issues),
      title: optString(session, "title", path, issues),
      subpath: optString(session, "subpath", path, issues),
      outcome: optEnum(session, "outcome", ["succeeded", "failed", "interrupted"] as const, path, issues),
      timeCreated: time === null ? 0 : reqNumber(time, "created", `${path}.time`, issues),
      timeUpdated: time === null ? 0 : reqNumber(time, "updated", `${path}.time`, issues),
      timeIdle: time === null ? null : optNumber(time, "idle", `${path}.time`, issues),
      timeArchived: time === null ? null : optNumber(time, "archived", `${path}.time`, issues),
      locationDirectory: location === null ? "" : reqString(location, "directory", `${path}.location`, issues),
    });
  });

  const cursor = sessionCursor(record.cursor, "$.cursor", issues);
  return issues.result({ sessions, nextCursor: cursor.next });
}

function sessionCursor(value: unknown, path: string, issues: IssueCollector): { previous: string | null; next: string | null } {
  if (value === undefined || value === null) return { previous: null, next: null };
  const record = asRecord(value, path, issues);
  if (record === null) return { previous: null, next: null };
  return {
    previous: optString(record, "previous", path, issues),
    next: optString(record, "next", path, issues),
  };
}

// --- messages --------------------------------------------------------------

export interface UpstreamAssistantTool {
  readonly kind: "tool";
  readonly id: string;
  readonly name: string;
  readonly status: "streaming" | "running" | "completed" | "error";
  readonly inputSummary: string;
  readonly outputSummary: string | null;
  readonly errorMessage: string | null;
  readonly created: number;
  readonly completed: number | null;
  /**
   * Whether preprocessing removed credential-shaped content from this call's
   * input or output before the summaries above were built.
   *
   * The tool input and output are redacted *here*, before they are serialised
   * into `inputSummary`/`outputSummary`, so nothing credential-shaped is ever
   * carried forward. That is the safe order, but it is invisible downstream: the
   * collector's redactor sees already-clean text and cannot tell that anything
   * was removed, so it would report `redacted: false` and the timeline would
   * present a sanitised call as if it were the verbatim upstream record. This
   * flag is that missing provenance, and normalisation folds it into the
   * activity event's `redacted` badge.
   */
  readonly redacted: boolean;
}

export interface UpstreamAssistantText {
  readonly kind: "text";
  readonly text: string;
}

export interface UpstreamAssistantReasoning {
  readonly kind: "reasoning";
  readonly text: string;
}

export type UpstreamAssistantPart = UpstreamAssistantText | UpstreamAssistantReasoning | UpstreamAssistantTool;

export interface UpstreamUserMessage {
  readonly type: "user";
  readonly id: string;
  readonly created: number;
  readonly text: string;
}

export interface UpstreamSystemMessage {
  readonly type: "system";
  readonly id: string;
  readonly created: number;
  readonly text: string;
  readonly description: string | null;
}

export interface UpstreamSyntheticMessage {
  readonly type: "synthetic";
  readonly id: string;
  readonly created: number;
  readonly text: string;
  readonly description: string | null;
}

export interface UpstreamSkillMessage {
  readonly type: "skill";
  readonly id: string;
  readonly created: number;
  readonly name: string | null;
  readonly text: string | null;
}

export interface UpstreamShellMessage {
  readonly type: "shell";
  readonly id: string;
  readonly created: number;
  readonly completed: number | null;
  readonly command: string;
  readonly status: "running" | "exited" | "timeout" | "killed";
  readonly exit: number | null;
  readonly output: string | null;
}

export interface UpstreamCompactionMessage {
  readonly type: "compaction";
  readonly id: string;
  readonly created: number;
  readonly status: "running" | "completed" | "failed";
  readonly summary: string | null;
  readonly reason: string | null;
}

export interface UpstreamAssistantMessage {
  readonly type: "assistant";
  readonly id: string;
  readonly created: number;
  readonly completed: number | null;
  readonly agentId: string | null;
  readonly modelProviderId: string | null;
  readonly modelId: string | null;
  readonly parts: readonly UpstreamAssistantPart[];
  readonly finish: string | null;
  readonly errorMessage: string | null;
}

export interface UpstreamIdleMessage {
  readonly type: "idle";
  readonly id: string;
  readonly created: number;
  readonly outcome: UpstreamOutcome;
}

export interface UpstreamAgentSwitchedMessage {
  readonly type: "agent-switched";
  readonly id: string;
  readonly created: number;
  readonly agentId: string;
  readonly previousAgentId: string | null;
}

export interface UpstreamModelSwitchedMessage {
  readonly type: "model-switched";
  readonly id: string;
  readonly created: number;
  readonly modelProviderId: string;
  readonly modelId: string;
}

export interface UpstreamLocationSwitchedMessage {
  readonly type: "location-switched";
  readonly id: string;
  readonly created: number;
  readonly directory: string;
}

export type UpstreamMessage =
  | UpstreamUserMessage
  | UpstreamSystemMessage
  | UpstreamSyntheticMessage
  | UpstreamSkillMessage
  | UpstreamShellMessage
  | UpstreamCompactionMessage
  | UpstreamAssistantMessage
  | UpstreamIdleMessage
  | UpstreamAgentSwitchedMessage
  | UpstreamModelSwitchedMessage
  | UpstreamLocationSwitchedMessage;

/** Message types this build knows how to normalize. */
export const KNOWN_MESSAGE_TYPES = [
  "agent-switched",
  "model-switched",
  "location-switched",
  "user",
  "synthetic",
  "system",
  "skill",
  "shell",
  "assistant",
  "compaction",
  "idle",
] as const;

export function validateMessagesResponse(
  payload: unknown,
): ValidationResult<{ messages: UpstreamMessage[]; nextCursor: string | null; unknownTypes: string[] }> {
  const issues = new IssueCollector();
  const record = asRecord(payload, "$", issues);
  if (record === null) return issues.result({ messages: [], nextCursor: null, unknownTypes: [] });

  const dataRaw = reqArray(record, "data", "$", issues);
  const messages: UpstreamMessage[] = [];
  const unknownTypes: string[] = [];

  dataRaw.forEach((entry, index) => {
    const path = `$.data[${index}]`;
    const message = asRecord(entry, path, issues);
    if (message === null) return;
    const type = reqString(message, "type", path, issues);
    if (!KNOWN_MESSAGE_TYPES.includes(type as (typeof KNOWN_MESSAGE_TYPES)[number])) {
      // Forward compatibility: a newer upstream may add message types. Record
      // the unknown type instead of guessing at its meaning.
      unknownTypes.push(type);
      return;
    }
    const parsed = parseMessage(type, message, path, issues);
    if (parsed !== null) messages.push(parsed);
  });

  const cursor = sessionCursor(record.cursor, "$.cursor", issues);
  return issues.result({ messages, nextCursor: cursor.next, unknownTypes });
}

function parseMessage(
  type: string,
  message: Record<string, unknown>,
  path: string,
  issues: IssueCollector,
): UpstreamMessage | null {
  const time = asRecord(message.time, `${path}.time`, issues);
  const created = time === null ? 0 : reqNumber(time, "created", `${path}.time`, issues);
  const id = reqString(message, "id", path, issues);

  switch (type) {
    case "user":
      return { type: "user", id, created, text: reqString(message, "text", path, issues) };

    case "system":
      return {
        type: "system",
        id,
        created,
        text: reqString(message, "text", path, issues),
        description: optString(message, "description", path, issues),
      };

    case "synthetic":
      return {
        type: "synthetic",
        id,
        created,
        text: reqString(message, "text", path, issues),
        description: optString(message, "description", path, issues),
      };

    case "skill":
      return {
        type: "skill",
        id,
        created,
        name: optString(message, "name", path, issues),
        text: optString(message, "text", path, issues),
      };

    case "shell": {
      const outputRecord =
        message.output === undefined || message.output === null ? null : asRecord(message.output, `${path}.output`, issues);
      const exitRaw = message.exit;
      return {
        type: "shell",
        id,
        created,
        completed: time === null ? null : optNumber(time, "completed", `${path}.time`, issues),
        command: reqString(message, "command", path, issues),
        status: reqEnum(message, "status", ["running", "exited", "timeout", "killed"] as const, path, issues),
        exit: typeof exitRaw === "number" && Number.isFinite(exitRaw) ? exitRaw : null,
        output: outputRecord === null ? null : optString(outputRecord, "output", `${path}.output`, issues),
      };
    }

    case "compaction": {
      const status = reqEnum(message, "status", ["running", "completed", "failed"] as const, path, issues);
      return {
        type: "compaction",
        id,
        created,
        status,
        summary: optString(message, "summary", path, issues),
        reason: optString(message, "reason", path, issues),
      };
    }

    case "idle":
      return {
        type: "idle",
        id,
        created,
        outcome: reqEnum(message, "outcome", ["succeeded", "failed", "interrupted"] as const, path, issues),
      };

    case "agent-switched":
      return {
        type: "agent-switched",
        id,
        created,
        agentId: reqString(message, "agent", path, issues),
        previousAgentId: optString(message, "previous", path, issues),
      };

    case "model-switched": {
      const model = asRecord(message.model, `${path}.model`, issues);
      return {
        type: "model-switched",
        id,
        created,
        modelProviderId: model === null ? "" : reqString(model, "providerID", `${path}.model`, issues),
        modelId: model === null ? "" : reqString(model, "id", `${path}.model`, issues),
      };
    }

    case "location-switched": {
      const location = asRecord(message.location, `${path}.location`, issues);
      return {
        type: "location-switched",
        id,
        created,
        directory: location === null ? "" : reqString(location, "directory", `${path}.location`, issues),
      };
    }

    case "assistant": {
      const model =
        message.model === undefined || message.model === null ? null : asRecord(message.model, `${path}.model`, issues);
      const partsRaw = reqArray(message, "content", path, issues);
      const parts: UpstreamAssistantPart[] = [];
      partsRaw.forEach((partRaw, partIndex) => {
        const partPath = `${path}.content[${partIndex}]`;
        const part = asRecord(partRaw, partPath, issues);
        if (part === null) return;
        const partType = reqString(part, "type", partPath, issues);
        if (partType === "text") {
          parts.push({ kind: "text", text: reqString(part, "text", partPath, issues) });
        } else if (partType === "reasoning") {
          parts.push({ kind: "reasoning", text: reqString(part, "text", partPath, issues) });
        } else if (partType === "tool") {
          const state = asRecord(part.state, `${partPath}.state`, issues);
          const toolTime = asRecord(part.time, `${partPath}.time`, issues);
          const status =
            state === null
              ? "streaming"
              : reqEnum(state, "status", ["streaming", "running", "completed", "error"] as const, `${partPath}.state`, issues);
          const errorRecord =
            state === null || state.error === undefined || state.error === null
              ? null
              : asRecord(state.error, `${partPath}.state.error`, issues);
          // Redact the input and output *before* summarising them, so a
          // credential never reaches the stored summary. Comparing the raw
          // summary with the redacted one is how the provenance below is derived:
          // the two differ exactly when redaction removed something.
          const inputRaw = state === null ? "" : summariseJson(state.input);
          const inputSafe = state === null ? "" : summariseJson(redactStructuredLeaves(state.input));
          const outputRaw = state === null ? null : summariseToolContent(state.content);
          const outputSafe = state === null ? null : summariseToolContent(redactStructuredLeaves(state.content));
          parts.push({
            kind: "tool",
            id: reqString(part, "id", partPath, issues),
            name: reqString(part, "name", partPath, issues),
            status,
            inputSummary: inputSafe,
            outputSummary: outputSafe,
            errorMessage: errorRecord === null ? null : optString(errorRecord, "message", `${partPath}.state.error`, issues),
            created: toolTime === null ? created : reqNumber(toolTime, "created", `${partPath}.time`, issues),
            completed: toolTime === null ? null : optNumber(toolTime, "completed", `${partPath}.time`, issues),
            redacted: inputSafe !== inputRaw || outputSafe !== outputRaw,
          });
        } else {
          issues.add(`${partPath}.type`, `unknown assistant part type ${JSON.stringify(partType)}`);
        }
      });

      return {
        type: "assistant",
        id,
        created,
        completed: time === null ? null : optNumber(time, "completed", `${path}.time`, issues),
        agentId: optString(message, "agent", path, issues),
        modelProviderId: model === null ? null : optString(model, "providerID", `${path}.model`, issues),
        modelId: model === null ? null : optString(model, "id", `${path}.model`, issues),
        parts,
        finish: optString(message, "finish", path, issues),
        errorMessage: message.error === undefined || message.error === null
          ? null
          : (() => {
              const errorRecord = asRecord(message.error, `${path}.error`, issues);
              return errorRecord === null ? null : optString(errorRecord, "message", `${path}.error`, issues);
            })(),
      };
    }

    default:
      return null;
  }
}

function summariseJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserialisable]";
  }
}

function summariseToolContent(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const chunks: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const text = entry.text;
    if (typeof text === "string") {
      chunks.push(text);
    } else if (typeof entry.path === "string") {
      chunks.push(entry.path);
    }
  }
  return chunks.length === 0 ? null : chunks.join("\n");
}
