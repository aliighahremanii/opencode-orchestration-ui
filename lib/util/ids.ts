import { createHash, randomBytes, randomUUID } from "node:crypto";

/** Random identifier for locally-owned records (auth sessions, gaps, leases). */
export function randomId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Deterministic identifier derived from upstream identity.
 *
 * Collector writes must be idempotent across restarts and overlapping runs, so
 * every derived record's primary key is a hash of its upstream coordinates
 * rather than a random value. Re-ingesting the same upstream record therefore
 * targets the same row.
 */
export function deterministicId(prefix: string, parts: readonly (string | number | null)[]): string {
  const digest = createHash("sha256").update(parts.map((p) => (p === null ? "\u0000" : String(p))).join("\u0001")).digest("hex");
  return `${prefix}_${digest.slice(0, 32)}`;
}

/** Stable key used by the activity-event unique index. */
export function dedupeKey(parts: readonly (string | number | null)[]): string {
  return createHash("sha256").update(parts.map((p) => (p === null ? "\u0000" : String(p))).join("\u0001")).digest("hex");
}
