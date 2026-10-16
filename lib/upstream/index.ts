import { getConfig, type AppConfig } from "../config.ts";
import { LiveUpstreamSource } from "./adapter.ts";
import { FixtureUpstreamSource } from "./fixture-source.ts";
import type { UpstreamSource } from "./source.ts";

/**
 * Build the upstream source for the configured mode.
 *
 * Only the collector calls this. The web process never constructs an upstream
 * source, which is what guarantees that a browser cannot reach the upstream
 * instance through this application.
 */
export function createUpstreamSource(config: AppConfig = getConfig()): UpstreamSource {
  if (config.upstream.mode === "fixture") {
    return new FixtureUpstreamSource({
      fixtureDir: config.fixtureDir,
      shiftToNow: process.env.ORCH_FIXTURE_STATIC_TIME !== "1",
    });
  }
  return new LiveUpstreamSource(config.upstream);
}

export { LiveUpstreamSource, FixtureUpstreamSource };
export type { UpstreamSource };
