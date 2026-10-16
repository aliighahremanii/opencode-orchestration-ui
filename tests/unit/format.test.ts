import { describe, expect, it } from "vitest";
import {
  collectorStateLabel,
  confidenceLabel,
  formatCount,
  formatDuration,
  formatRelative,
  formatTimestamp,
  runStatusLabel,
  runStatusTone,
  upstreamOutcomeLabel,
} from "../../lib/format.ts";

const NOW = 1_800_000_000_000;

describe("formatTimestamp", () => {
  it("renders a deterministic UTC timestamp", () => {
    expect(formatTimestamp(0)).toBe("1970-01-01 00:00:00Z");
  });

  it("renders an em dash for missing values", () => {
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp(undefined)).toBe("—");
  });

  it("renders an em dash for an invalid value", () => {
    expect(formatTimestamp(Number.NaN)).toBe("—");
  });
});

describe("formatRelative", () => {
  it("describes the immediate past", () => {
    expect(formatRelative(NOW - 1000, NOW)).toBe("just now");
  });

  it("describes seconds, minutes, hours and days", () => {
    expect(formatRelative(NOW - 30_000, NOW)).toBe("30s ago");
    expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(formatRelative(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatRelative(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
  });

  it("describes the future", () => {
    expect(formatRelative(NOW + 5 * 60_000, NOW)).toBe("in 5m");
  });

  it("renders an em dash for missing values", () => {
    expect(formatRelative(null, NOW)).toBe("—");
  });

  it("is a pure function of the supplied clock", () => {
    // The caller supplies `now`, so the same input always renders the same label.
    expect(formatRelative(1000, 61_000)).toBe(formatRelative(1000, 61_000));
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(0, 30_000)).toBe("30s");
    expect(formatDuration(0, 90_000)).toBe("1m 30s");
    expect(formatDuration(0, 3_600_000)).toBe("1h 0m");
  });

  it("renders an em dash for an unfinished or invalid range", () => {
    expect(formatDuration(1000, null)).toBe("—");
    expect(formatDuration(2000, 1000)).toBe("—");
  });
});

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
  });
});

describe("runStatusLabel", () => {
  it("labels every upstream-reported status as reported", () => {
    expect(runStatusLabel("reported-succeeded")).toContain("Upstream reported");
    expect(runStatusLabel("reported-failed")).toContain("Upstream reported");
    expect(runStatusLabel("reported-interrupted")).toContain("Upstream reported");
    expect(runStatusLabel("reported-idle")).toContain("Upstream reported");
  });

  it("labels recent activity as an observation, not a verdict", () => {
    const label = runStatusLabel("recently-active");
    expect(label).toContain("observed");
    expect(label.toLowerCase()).not.toContain("succeeded");
    expect(label.toLowerCase()).not.toContain("complete");
  });

  it("labels the absence of a report as such", () => {
    expect(runStatusLabel("unknown")).toBe("No upstream report");
  });

  it("never claims success for a non-success status", () => {
    for (const status of ["recently-active", "reported-idle", "reported-interrupted", "unknown"] as const) {
      expect(runStatusLabel(status).toLowerCase()).not.toContain("succeeded");
    }
  });
});

describe("runStatusTone", () => {
  it("maps each status to a distinct tone", () => {
    expect(runStatusTone("reported-succeeded")).toBe("positive");
    expect(runStatusTone("reported-failed")).toBe("negative");
    expect(runStatusTone("reported-interrupted")).toBe("warning");
    expect(runStatusTone("recently-active")).toBe("warning");
    expect(runStatusTone("unknown")).toBe("neutral");
  });
});

describe("upstreamOutcomeLabel", () => {
  it("attributes the outcome to the upstream instance", () => {
    expect(upstreamOutcomeLabel("succeeded")).toBe("Upstream reported succeeded");
    expect(upstreamOutcomeLabel(null)).toBe("No upstream report");
  });
});

describe("confidenceLabel", () => {
  it("explains each confidence level", () => {
    expect(confidenceLabel("verified")).toContain("Verified");
    expect(confidenceLabel("derived")).toContain("Derived");
    expect(confidenceLabel("unknown")).toContain("missing");
  });
});

describe("collectorStateLabel", () => {
  it("describes each collector state", () => {
    expect(collectorStateLabel("running")).toBe("Collector running");
    expect(collectorStateLabel("stale")).toBe("Collector lease expired");
    expect(collectorStateLabel("never-started")).toBe("Collector has never run");
    expect(collectorStateLabel("something-else")).toBe("Collector state unknown");
  });
});
