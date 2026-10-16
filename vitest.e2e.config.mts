import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * End-to-end tests.
 *
 * These build the application, start `next start` against a temporary SQLite
 * database and the fixture upstream, and drive the real HTTP surface. They are
 * deliberately separate from the unit suite so `npm test` stays fast.
 *
 * A single fork is used because the suite manages one server and one database.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: "forks",
    // One server and one database are shared across the suite, so the files run
    // sequentially rather than in parallel processes.
    fileParallelism: false,
  },
});
