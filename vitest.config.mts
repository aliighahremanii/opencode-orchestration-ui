import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Unit and integration tests.
 *
 * These run in Node (not jsdom) because they exercise the database,
 * normalization, collector, and HTTP layers directly. Component tests that need
 * a DOM opt in per-file with `// @vitest-environment jsdom`.
 *
 * The `tests/e2e` directory is excluded here and run by the E2E config, because
 * those tests build and start a real Next.js server.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["tests/e2e/**", "node_modules/**", ".next/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The collector lease tests rely on a real SQLite file with a busy timeout;
    // running test files in parallel processes is fine because each file uses
    // its own database path.
    pool: "forks",
  },
});
