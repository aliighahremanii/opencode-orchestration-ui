/**
 * Apply pending migrations and report the resulting schema version.
 *
 * The web server and the collector both migrate on startup (the migration is
 * lock-guarded), so this script exists for operators who want to migrate
 * explicitly — for example before starting a new image, or in an init container.
 */

import { getConfig } from "../lib/config.ts";
import { closeDatabase, ensureDatabaseReady, getDatabaseState } from "../lib/db/index.ts";

const config = getConfig();
try {
  ensureDatabaseReady();
  const state = getDatabaseState();
  console.log(
    JSON.stringify(
      {
        dbPath: config.dbPath,
        schemaVersion: state.schemaVersion,
        expectedSchemaVersion: state.expectedSchemaVersion,
        ownerConfigured: state.ownerConfigured,
        warnings: state.warnings,
      },
      null,
      2,
    ),
  );
} catch (cause) {
  console.error(`Migration failed: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`);
  process.exitCode = 1;
} finally {
  closeDatabase();
}
