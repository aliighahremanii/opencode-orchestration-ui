/**
 * Collector entrypoint.
 *
 * This is a long-lived process, separate from the Next.js web server. Both open
 * the same SQLite database; the collector is the only writer of observations.
 *
 *   node scripts/collector.ts            # run forever
 *   node scripts/collector.ts --once     # run a single cycle and exit
 *
 * Run it with `npm run collector` (or `npm run collector:once`).
 */

import { closeDatabase, ensureDatabaseReady, getDatabaseState } from "../lib/db/index.ts";
import { COLLECTOR_SCOPE, collectorIdentity, consoleLogger, runCollectorLoop, runCycle } from "../lib/collector/collector.ts";
import { createUpstreamSource } from "../lib/upstream/index.ts";
import { getConfig } from "../lib/config.ts";

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  const config = getConfig();

  consoleLogger.info("starting", {
    mode: config.upstream.mode,
    dbPath: config.dbPath,
    pollIntervalMs: config.collector.pollIntervalMs,
    leaseTtlMs: config.collector.leaseTtlMs,
    once,
  });

  let db;
  try {
    db = ensureDatabaseReady();
  } catch (cause) {
    const state = getDatabaseState();
    consoleLogger.error("database is not usable; refusing to collect", {
      error: state.error ?? String(cause),
      dbPath: state.dbPath,
    });
    process.exitCode = 1;
    return;
  }

  const state = getDatabaseState();
  for (const warning of state.warnings) {
    consoleLogger.warn(warning);
  }

  const source = createUpstreamSource(config);
  consoleLogger.info("upstream source configured", { kind: source.kind, description: source.description });

  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => {
    consoleLogger.info(`received ${signal}, finishing the current cycle and shutting down`);
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const deps = {
    db,
    source,
    config: config.collector,
    now: () => Date.now(),
    log: consoleLogger,
  };

  try {
    if (once) {
      // A one-shot collection has no next cycle, so it must not hold the lease:
      // leaving it held would block the next collection for the whole TTL.
      const result = await runCycle(deps, collectorIdentity(Date.now()), { releaseWhenDone: true });
      if (result === null) {
        consoleLogger.warn("another collector owns the lease; this one-shot run did not collect anything");
      } else {
        consoleLogger.info("single cycle finished", { result: JSON.stringify(result) });
        if (!result.ok) {
          process.exitCode = 1;
        }
      }
    } else {
      await runCollectorLoop(deps, collectorIdentity(Date.now()), { signal: controller.signal });
    }
  } catch (cause) {
    consoleLogger.error("collector stopped with an unrecoverable error", {
      error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
    });
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    closeDatabase();
    consoleLogger.info("stopped", { scope: COLLECTOR_SCOPE });
  }
}

await main();
