import type { UpstreamConfig } from "../config.ts";
import { deterministicId } from "../util/ids.ts";
import {
  validateAgentList,
  validateLocationInfo,
  validateMessagesResponse,
  validateServerInfo,
  validateSessionsResponse,
  type UpstreamAgentInfo,
  type UpstreamLocationInfo,
  type UpstreamLocationRef,
  type UpstreamMessage,
  type UpstreamServerInfo,
  type UpstreamSessionInfo,
} from "./schema.ts";
import {
  UpstreamAuthError,
  UpstreamConfigError,
  UpstreamHttpError,
  UpstreamPayloadError,
  UpstreamUnavailableError,
  type AgentList,
  type MessagePage,
  type SessionPage,
  type UpstreamSource,
} from "./source.ts";

/**
 * Live upstream adapter.
 *
 * Hand-written rather than generated from the upstream SDK: the generated client
 * exposes service helpers that can start a server process, and this application
 * must only ever issue read requests. Every call here is a `GET` on a fixed
 * path, the response is validated against the documented shape, and the body
 * size is capped.
 *
 * Hardening:
 * - Only `GET` is permitted; `request()` throws on anything else.
 * - Redirects are not followed, so a compromised upstream cannot bounce the
 *   collector to another host.
 * - Credentials come from the process environment only. This application never
 *   reads credential files.
 */

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export class LiveUpstreamSource implements UpstreamSource {
  readonly connectionId: string;
  readonly kind = "live" as const;
  readonly description: string;
  private readonly config: UpstreamConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: UpstreamConfig, fetchImpl: typeof fetch = fetch) {
    if ((config.username === null) !== (config.password === null)) {
      throw new UpstreamConfigError(
        "/api",
        "ORCH_UPSTREAM_USERNAME and ORCH_UPSTREAM_PASSWORD must be set together or not at all.",
      );
    }
    this.config = config;
    this.connectionId = deterministicId("connection", [config.baseUrl]);
    this.fetchImpl = fetchImpl;
    this.description = `${config.baseUrl}${config.username === null ? " (no credentials configured)" : " (HTTP Basic configured)"}`;
  }

  async getServerInfo(): Promise<UpstreamServerInfo> {
    return this.getJson("/api/info", {}, validateServerInfo);
  }

  async listProjects(): Promise<{ id: string; root: string; name: string | null }[]> {
    const payload = await this.request("/api/project", {});
    if (!Array.isArray(payload)) throw new UpstreamPayloadError("/api/project", ["expected array"]);
    return payload.map((p: unknown) => {
      if (!p || typeof p !== "object" || !("id" in p) || typeof p.id !== "string" || !("canonical" in p) || typeof p.canonical !== "string")
        throw new UpstreamPayloadError("/api/project", ["invalid project identity"]);
      return {id:p.id,root:p.canonical,name:"name" in p && typeof p.name === "string" ? p.name : null};
    });
  }

  async workspaceMetadata(directory: string, projectId: string) {
    let branch: string | null = null;
    let vcsState: "verified" | "unavailable" = "unavailable";
    let worktreeState: "verified" | "unavailable" | "unknown" = "unavailable";
    try {
      const raw = await this.request("/api/vcs", {"location[directory]":directory}) as {location?: {directory?: unknown}; data?: {branch?: {current?: unknown}}};
      if (raw.location?.directory === directory && typeof raw.data?.branch?.current === "string") { branch=raw.data.branch.current; vcsState="verified"; }
    } catch { /* Optional metadata is explicitly unavailable, never inferred. */ }
    try {
      const raw = await this.request("/api/worktree", {projectID:projectId});
      if (Array.isArray(raw)) worktreeState=raw.some(w=>w && typeof w === "object" && w.directory === directory) ? "verified" : "unknown";
    } catch { /* Inventory absence is not evidence of a worktree. */ }
    return {branch,vcsState,worktreeState};
  }

  async listLocations(): Promise<readonly UpstreamLocationInfo[]> {
    const location = await this.getJson("/api/location", {}, validateLocationInfo);
    return [location];
  }

  async listAgents(locationDirectory: string): Promise<AgentList> {
    return this.getJson(
      "/api/agent",
      { "location[directory]": locationDirectory },
      validateAgentList,
    ) as Promise<AgentList>;
  }

  async listSessions(params: { cursor: string | null; limit: number }): Promise<SessionPage> {
    const query: Record<string, string> = { limit: String(params.limit) };
    if (params.cursor !== null) query.cursor = params.cursor;
    const validated = await this.getJson("/api/session", query, validateSessionsResponse);
    return { sessions: validated.sessions, nextCursor: validated.nextCursor };
  }

  async listMessages(params: { sessionId: string; cursor: string | null; limit: number }): Promise<MessagePage> {
    const query: Record<string, string> = { limit: String(params.limit) };
    if (params.cursor !== null) query.cursor = params.cursor;
    const validated = await this.getJson(
      `/api/session/${encodeURIComponent(params.sessionId)}/message`,
      query,
      validateMessagesResponse,
    );
    return { messages: validated.messages, nextCursor: validated.nextCursor, unknownTypes: validated.unknownTypes };
  }

  private async getJson<T>(
    path: string,
    query: Record<string, string>,
    validate: (payload: unknown) => { ok: true; value: T } | { ok: false; issues: readonly string[] },
  ): Promise<T> {
    const payload = await this.request(path, query);
    const result = validate(payload);
    if (!result.ok) {
      throw new UpstreamPayloadError(path, result.issues);
    }
    return result.value;
  }

  /** The single place a network request is made. GET only. */
  private async request(path: string, query: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.config.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = { accept: "application/json" };
    if (this.config.username !== null && this.config.password !== null) {
      const encoded = Buffer.from(`${this.config.username}:${this.config.password}`, "utf8").toString("base64");
      headers.authorization = `Basic ${encoded}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (cause) {
      throw new UpstreamUnavailableError(path, cause);
    }

    if (response.status === 401 || response.status === 403) {
      throw new UpstreamAuthError(path);
    }
    if (!response.ok) {
      throw new UpstreamHttpError(path, response.status);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      throw new UpstreamPayloadError(path, [`expected a JSON response, received content-type ${JSON.stringify(contentType)}`]);
    }

    const text = await readCappedText(response, path);
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new UpstreamPayloadError(path, [`body is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`]);
    }
  }
}

async function readCappedText(response: Response, path: string): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new UpstreamPayloadError(path, [`response body exceeded the ${MAX_BODY_BYTES} byte limit`]);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

export type { UpstreamAgentInfo, UpstreamLocationRef, UpstreamMessage, UpstreamSessionInfo };
