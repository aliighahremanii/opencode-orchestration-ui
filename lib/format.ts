import type { Confidence, RootRunStatus, UpstreamOutcome } from "./contracts/api.ts";

/**
 * Display helpers.
 *
 * These are pure and deterministic so they can be unit tested and so a
 * server-rendered and client-rendered copy of the same value cannot disagree.
 */

/** Deterministic UTC timestamp, used for exact values in tables and tooltips. */
export function formatTimestamp(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}Z`;
}

/**
 * Human-relative label. `now` is always passed in so the caller controls the
 * clock and tests are deterministic.
 */
export function formatRelative(ms: number | null | undefined, now: number): string {
  if (ms === null || ms === undefined) return "—";
  const delta = now - ms;
  const future = delta < 0;
  const abs = Math.abs(delta);

  const seconds = Math.round(abs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return future ? `in ${seconds}s` : `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return future ? `in ${hours}h` : `${hours}h ago`;

  const days = Math.round(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}

export function formatDuration(fromMs: number, toMs: number | null): string {
  if (toMs === null || toMs < fromMs) return "—";
  const seconds = Math.round((toMs - fromMs) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

/**
 * Label for a run status.
 *
 * `reported-*` values are labelled as upstream-reported, because they are what
 * the upstream instance recorded, not a verdict about the user's work.
 * `recently-active` is labelled as a local heuristic for the same reason.
 */
export function runStatusLabel(status: RootRunStatus): string {
  switch (status) {
    case "recently-active":
      return "Recently active (observed)";
    case "reported-idle":
      return "Upstream reported idle";
    case "reported-succeeded":
      return "Upstream reported succeeded";
    case "reported-failed":
      return "Upstream reported failed";
    case "reported-interrupted":
      return "Upstream reported interrupted";
    case "unknown":
      return "No upstream report";
  }
}

export function runStatusTone(status: RootRunStatus): "neutral" | "positive" | "negative" | "warning" {
  switch (status) {
    case "reported-succeeded":
      return "positive";
    case "reported-failed":
      return "negative";
    case "reported-interrupted":
      return "warning";
    case "reported-idle":
      return "neutral";
    case "recently-active":
      return "warning";
    case "unknown":
      return "neutral";
  }
}

export function upstreamOutcomeLabel(outcome: UpstreamOutcome | null): string {
  if (outcome === null) return "No upstream report";
  return `Upstream reported ${outcome}`;
}

export function confidenceLabel(confidence: Confidence): string {
  switch (confidence) {
    case "verified":
      return "Verified from observed fields";
    case "derived":
      return "Derived by joining observed records";
    case "unknown":
      return "Evidence missing";
  }
}

export function collectorStateLabel(state: string): string {
  switch (state) {
    case "running":
      return "Collector running";
    case "stale":
      return "Collector lease expired";
    case "stopped":
      return "Collector stopped";
    case "never-started":
      return "Collector has never run";
    default:
      return "Collector state unknown";
  }
}
