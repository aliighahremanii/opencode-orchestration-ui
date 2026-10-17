import fs from "node:fs";
import path from "node:path";
import {
  validateAgentList,
  validateLocationInfo,
  validateMessagesResponse,
  validateServerInfo,
  validateSessionsResponse,
  type UpstreamLocationInfo,
  type UpstreamLocationRef,
  type UpstreamMessage,
  type UpstreamServerInfo,
  type UpstreamSessionInfo,
} from "./schema.ts";
import { UpstreamHttpError, UpstreamPayloadError, UpstreamUnavailableError, type AgentList, type MessagePage, type SessionPage, type UpstreamSource } from "./source.ts";

/**
 * Fixture upstream source.
 *
 * The fixtures are stored in the same JSON shapes the live API documents, and
 * they are pushed through the *same* runtime validators as live responses. That
 * means the fixture path exercises payload validation, identity, deduplication,
 * ordering, and redaction for real rather than bypassing them.
 *
 * Fault injection is declared in `manifest.json` and is applied to the raw JSON
 * before validation, so injected duplicates, unordered pages, and unknown
 * message types are rejected or normalised by the production code paths.
 */

export interface FixtureFaults {
  readonly duplicateMessages: boolean;
  readonly outOfOrderMessages: boolean;
  readonly duplicateSessionPage: boolean;
  readonly unknownMessageType: boolean;
}

export interface FixtureManifest {
  readonly description: string;
  readonly referenceNow: number;
  readonly serverInfo: string;
  readonly location: string;
  readonly agentLists: Record<string, string>;
  readonly sessions: string;
  readonly messages: Record<string, string>;
  readonly sessionPageSize: number;
  readonly messagePageSize: number;
  readonly faults: FixtureFaults;
  readonly simulatedGap: { readonly startedAtOffsetMs: number; readonly endedAtOffsetMs: number; readonly reason: string } | null;
}

const DEFAULT_FAULTS: FixtureFaults = {
  duplicateMessages: false,
  outOfOrderMessages: false,
  duplicateSessionPage: false,
  unknownMessageType: false,
};

export class FixtureLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FixtureLoadError";
  }
}

function readJson(filePath: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new FixtureLoadError(`Unable to read fixture file ${filePath}`, { cause });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new FixtureLoadError(`Fixture file ${filePath} is not valid JSON`, { cause });
  }
}

export function loadManifest(fixtureDir: string): FixtureManifest {
  const manifestPath = path.join(fixtureDir, "manifest.json");
  const raw = readJson(manifestPath);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new FixtureLoadError(`Fixture manifest ${manifestPath} must be an object`);
  }
  const record = raw as Record<string, unknown>;
  const str = (key: string): string => {
    const value = record[key];
    if (typeof value !== "string") throw new FixtureLoadError(`Fixture manifest field ${key} must be a string`);
    return value;
  };
  const num = (key: string): number => {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new FixtureLoadError(`Fixture manifest field ${key} must be a finite number`);
    }
    return value;
  };
  const faultsRaw = (record.faults ?? {}) as Record<string, unknown>;
  const simulatedGapRaw = record.simulatedGap;

  return {
    description: str("description"),
    referenceNow: num("referenceNow"),
    serverInfo: str("serverInfo"),
    location: str("location"),
    agentLists: (record.agentLists ?? {}) as Record<string, string>,
    sessions: str("sessions"),
    messages: (record.messages ?? {}) as Record<string, string>,
    sessionPageSize: num("sessionPageSize"),
    messagePageSize: num("messagePageSize"),
    faults: {
      duplicateMessages: faultsRaw.duplicateMessages === true,
      outOfOrderMessages: faultsRaw.outOfOrderMessages === true,
      duplicateSessionPage: faultsRaw.duplicateSessionPage === true,
      unknownMessageType: faultsRaw.unknownMessageType === true,
    },
    simulatedGap:
      simulatedGapRaw === null || simulatedGapRaw === undefined
        ? null
        : {
            startedAtOffsetMs: Number((simulatedGapRaw as Record<string, unknown>).startedAtOffsetMs ?? 0),
            endedAtOffsetMs: Number((simulatedGapRaw as Record<string, unknown>).endedAtOffsetMs ?? 0),
            reason: String((simulatedGapRaw as Record<string, unknown>).reason ?? "fixture gap"),
          },
  };
}

const TIME_FIELDS = new Set(["created", "updated", "idle", "viewed", "archived", "completed", "ran", "streamed"]);

/**
 * Shift every timestamp in a raw fixture payload by `deltaMs`.
 *
 * Fixtures are stored with fixed timestamps so they are deterministic, but a
 * dashboard demo looks broken if every run is months old. The shift is applied
 * only to the documented `time.*` objects, so it cannot accidentally rewrite a
 * numeric field that is not a timestamp.
 */
export function shiftFixtureTimes(value: unknown, deltaMs: number, key?: string): unknown {
  if (deltaMs === 0) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => shiftFixtureTimes(entry, deltaMs));
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(record)) {
      if (key === "time" && TIME_FIELDS.has(entryKey) && typeof entryValue === "number") {
        next[entryKey] = entryValue + deltaMs;
      } else {
        next[entryKey] = shiftFixtureTimes(entryValue, deltaMs, entryKey);
      }
    }
    return next;
  }
  return value;
}

function encodeCursor(prefix: string, offset: number): string {
  return `${prefix}:${offset}`;
}

function decodeCursor(cursor: string | null, prefix: string, path: string): number {
  if (cursor === null) return 0;
  const match = /^([a-z]+):(\d+)$/.exec(cursor);
  if (match === null || match[1] !== prefix) {
    throw new UpstreamPayloadError(path, [`invalid cursor ${JSON.stringify(cursor)} for ${prefix} paging`]);
  }
  return Number.parseInt(match[2] as string, 10);
}

export interface FixtureOptions {
  readonly fixtureDir: string;
  /** When set, fixture timestamps are shifted so the newest data looks current. */
  readonly shiftToNow?: boolean;
  readonly now?: () => number;
}

export class FixtureUpstreamSource implements UpstreamSource {
  readonly kind = "fixture" as const;
  readonly description: string;
  private readonly manifest: FixtureManifest;
  private readonly fixtureDir: string;
  private readonly deltaMs: number;

  constructor(options: FixtureOptions) {
    this.fixtureDir = options.fixtureDir;
    this.manifest = loadManifest(options.fixtureDir);
    const now = (options.now ?? Date.now)();
    this.deltaMs = options.shiftToNow === true ? now - this.manifest.referenceNow : 0;
    this.description = `fixtures in ${this.fixtureDir} (${this.manifest.description})`;
  }

  get simulatedGap(): FixtureManifest["simulatedGap"] {
    return this.manifest.simulatedGap;
  }

  get faults(): FixtureFaults {
    return { ...DEFAULT_FAULTS, ...this.manifest.faults };
  }

  async getServerInfo(): Promise<UpstreamServerInfo> {
    const raw = shiftFixtureTimes(readJson(path.join(this.fixtureDir, this.manifest.serverInfo)), this.deltaMs);
    const result = validateServerInfo(raw);
    if (!result.ok) throw new UpstreamPayloadError(this.manifest.serverInfo, result.issues);
    return result.value;
  }

  async listLocations(): Promise<readonly UpstreamLocationInfo[]> {
    const raw = shiftFixtureTimes(readJson(path.join(this.fixtureDir, this.manifest.location)), this.deltaMs);
    const result = validateLocationInfo(raw);
    if (!result.ok) throw new UpstreamPayloadError(this.manifest.location, result.issues);
    return [result.value];
  }

  async listAgents(locationDirectory: string): Promise<AgentList> {
    const file = this.manifest.agentLists[locationDirectory];
    if (file === undefined) {
      // A missing location is unavailable, not a successful empty registry.
      throw new UpstreamHttpError("/api/agent", 404);
    }
    const raw = shiftFixtureTimes(readJson(path.join(this.fixtureDir, file)), this.deltaMs);
    const result = validateAgentList(raw);
    if (!result.ok) throw new UpstreamPayloadError(file, result.issues);
    return { location: result.value.location as UpstreamLocationRef, agents: result.value.agents };
  }

  async listSessions(params: { cursor: string | null; limit: number }): Promise<SessionPage> {
    const filePath = path.join(this.fixtureDir, this.manifest.sessions);
    const payload = readJson(filePath);
    const result = validateSessionsResponse(payload);
    if (!result.ok) throw new UpstreamPayloadError(this.manifest.sessions, result.issues);
    const all = result.value.sessions;

    const offset = decodeCursor(params.cursor, "sessions", this.manifest.sessions);
    const pageSize = Math.max(1, Math.min(params.limit, this.manifest.sessionPageSize));
    const page = all.slice(offset, offset + pageSize);
    const withDuplicates =
      this.faults.duplicateSessionPage && offset > 0 ? [page[0] as UpstreamSessionInfo, ...page] : page;
    const nextOffset = offset + pageSize;
    const nextCursor = nextOffset < all.length ? encodeCursor("sessions", nextOffset) : null;

    const shifted = shiftFixtureTimes(withDuplicates, this.deltaMs) as UpstreamSessionInfo[];
    return { sessions: shifted, nextCursor };
  }

  async listMessages(params: { sessionId: string; cursor: string | null; limit: number }): Promise<MessagePage> {
    const file = this.manifest.messages[params.sessionId];
    if (file === undefined) {
      return { messages: [], nextCursor: null, unknownTypes: [] };
    }
    const payload = readJson(path.join(this.fixtureDir, file));
    const result = validateMessagesResponse(payload);
    if (!result.ok) throw new UpstreamPayloadError(file, result.issues);

    // Raw entries are re-read so injected faults survive validation and are
    // rejected or normalised by the production code paths.
    const rawRecord = payload as Record<string, unknown>;
    const rawEntries = Array.isArray(rawRecord.data) ? (rawRecord.data as unknown[]) : [];

    const offset = decodeCursor(params.cursor, "messages", file);
    const pageSize = Math.max(1, Math.min(params.limit, this.manifest.messagePageSize));
    let slice = rawEntries.slice(offset, offset + pageSize);

    if (this.faults.duplicateMessages && offset > 0 && rawEntries[offset - 1] !== undefined) {
      slice = [rawEntries[offset - 1] as unknown, ...slice];
    }
    if (this.faults.outOfOrderMessages) {
      slice = [...slice].reverse();
    }
    if (this.faults.unknownMessageType && offset === 0) {
      slice = [
        ...slice,
        {
          id: "msg_fixture_future_0001",
          type: "future-event-type",
          time: { created: this.manifest.referenceNow },
          payload: { note: "injected by fixture faults to exercise forward compatibility" },
        },
      ];
    }

    const unknownTypes: string[] = [];
    const messages: UpstreamMessage[] = [];
    slice.forEach((entry, index) => {
      const validated = validateMessagesResponse({ data: [entry], cursor: {} });
      if (validated.ok) {
        messages.push(...validated.value.messages);
        unknownTypes.push(...validated.value.unknownTypes);
      } else {
        throw new UpstreamPayloadError(`${file}#data[${offset + index}]`, validated.issues);
      }
    });

    const nextOffset = offset + pageSize;
    const nextCursor = nextOffset < rawEntries.length ? encodeCursor("messages", nextOffset) : null;
    void result;

    return {
      messages: shiftFixtureTimes(messages, this.deltaMs) as UpstreamMessage[],
      nextCursor,
      unknownTypes,
    };
  }
}

export function assertFixtureDirExists(fixtureDir: string): void {
  if (!fs.existsSync(fixtureDir)) {
    throw new UpstreamUnavailableError("fixtures", new FixtureLoadError(`Fixture directory ${fixtureDir} does not exist`));
  }
}
