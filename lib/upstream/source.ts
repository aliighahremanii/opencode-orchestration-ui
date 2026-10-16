import type {
  UpstreamAgentInfo,
  UpstreamLocationInfo,
  UpstreamLocationRef,
  UpstreamMessage,
  UpstreamServerInfo,
  UpstreamSessionInfo,
} from "./schema.ts";

/**
 * The read-only upstream surface the observer depends on.
 *
 * Everything here is a GET. The interface has no method that could mutate the
 * upstream instance: the observer must never prompt, interrupt, cancel, answer
 * a permission request, or change configuration.
 */

export interface SessionPage {
  readonly sessions: readonly UpstreamSessionInfo[];
  readonly nextCursor: string | null;
}

export interface MessagePage {
  readonly messages: readonly UpstreamMessage[];
  readonly nextCursor: string | null;
  readonly unknownTypes: readonly string[];
}

export interface AgentList {
  readonly location: UpstreamLocationRef;
  readonly agents: readonly UpstreamAgentInfo[];
}

export interface UpstreamSource {
  readonly kind: "fixture" | "live";
  /** Human-readable description shown at /status. Never includes credentials. */
  readonly description: string;
  getServerInfo(): Promise<UpstreamServerInfo>;
  listLocations(): Promise<readonly UpstreamLocationInfo[]>;
  listAgents(locationDirectory: string): Promise<AgentList>;
  listSessions(params: { readonly cursor: string | null; readonly limit: number }): Promise<SessionPage>;
  listMessages(params: {
    readonly sessionId: string;
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<MessagePage>;
}

export class UpstreamError extends Error {
  readonly path: string;

  constructor(message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UpstreamError";
    this.path = path;
  }
}

export class UpstreamUnavailableError extends UpstreamError {
  constructor(path: string, cause: unknown) {
    super(`Upstream request to ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`, path, { cause });
    this.name = "UpstreamUnavailableError";
  }
}

export class UpstreamHttpError extends UpstreamError {
  readonly status: number;

  constructor(path: string, status: number) {
    super(`Upstream request to ${path} returned HTTP ${status}.`, path);
    this.name = "UpstreamHttpError";
    this.status = status;
  }
}

export class UpstreamAuthError extends UpstreamError {
  constructor(path: string) {
    super(
      `Upstream request to ${path} was rejected with an authentication error. ` +
        "Set ORCH_UPSTREAM_USERNAME and ORCH_UPSTREAM_PASSWORD in the collector's environment " +
        "(credentials are never read from files by this application).",
      path,
    );
    this.name = "UpstreamAuthError";
  }
}

export class UpstreamPayloadError extends UpstreamError {
  readonly issues: readonly string[];

  constructor(path: string, issues: readonly string[]) {
    super(`Upstream response from ${path} did not match the documented shape: ${issues.slice(0, 5).join("; ")}`, path);
    this.name = "UpstreamPayloadError";
    this.issues = issues;
  }
}

export class UpstreamConfigError extends UpstreamError {
  constructor(path: string, message: string) {
    super(message, path);
    this.name = "UpstreamConfigError";
  }
}
