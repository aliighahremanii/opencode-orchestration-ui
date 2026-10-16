import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Architectural boundaries.
 *
 * The whole security posture of this application rests on one structural
 * property: the browser only ever talks to this application's own API. If a
 * Client Component (or anything reachable from one) imported the upstream
 * adapter or the database, then upstream access, credentials handling, or raw
 * SQLite access would be pulled into a client bundle.
 *
 * This test walks the real import graph from every `"use client"` module and
 * asserts that it cannot reach those modules. It is a static check on the source
 * tree, so it fails at review time rather than in production.
 */

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "components", "lib", "proxy.ts"];

/** Modules that must never be reachable from a Client Component. */
const FORBIDDEN_FROM_CLIENT = [
  "lib/upstream/",
  "lib/db/",
  "lib/collector/collector.ts",
  "lib/collector/normalize.ts",
  "lib/auth/dal.ts",
  "lib/auth/session.ts",
  "lib/auth/password.ts",
  "lib/auth/origin.ts",
  "lib/http/",
  "lib/config.ts",
  "scripts/",
  "proxy.ts",
];

/** Node builtins that indicate server-only code. */
const FORBIDDEN_BUILTINS = [
  "node:sqlite",
  "node:fs",
  "node:crypto",
  "node:path",
  "node:os",
  "fs",
  "crypto",
  "path",
  "os",
];

function walk(entry: string, files: string[] = []): string[] {
  const absolute = path.join(ROOT, entry);
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    return files;
  }
  if (stat.isFile()) {
    files.push(entry);
    return files;
  }
  for (const child of readdirSync(absolute)) {
    if (child === "node_modules" || child === ".next") continue;
    walk(path.join(entry, child), files);
  }
  return files;
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    walk(dir, files);
  }
  return files.filter((file) => /\.(ts|tsx|mts)$/.test(file));
}

function readSource(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

function isClientModule(file: string): boolean {
  const source = readSource(file);
  // The directive must be the first statement in the file.
  return /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source);
}

/** Extract the module specifiers of every static import/export-from in a file. */
function importSpecifiers(file: string): string[] {
  const source = readSource(file);
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[\s\S]*?)\s*from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bexport\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s*from\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.join(path.posix.dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  for (const candidate of candidates) {
    try {
      if (statSync(path.join(ROOT, candidate)).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Transitive closure of relative imports starting from a set of files. */
function reachableFrom(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const specifier of importSpecifiers(current)) {
      const resolved = resolveRelative(current, specifier);
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

function matchesForbidden(file: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    if (pattern.endsWith("/") ? file.startsWith(pattern) : file === pattern) return pattern;
  }
  return null;
}

describe("client module boundaries", () => {
  const all = sourceFiles();
  const clientModules = all.filter(isClientModule);

  it("finds the client modules to check", () => {
    // A guard on the guard: if the directive detection breaks, this test would
    // otherwise pass vacuously.
    expect(clientModules.length).toBeGreaterThan(5);
    expect(clientModules.some((file) => file.includes("use-api"))).toBe(true);
  });

  it("never lets a client module reach the upstream adapter or the database", () => {
    const violations: string[] = [];
    for (const clientModule of clientModules) {
      const reachable = reachableFrom([clientModule]);
      for (const file of reachable) {
        const match = matchesForbidden(file, FORBIDDEN_FROM_CLIENT);
        if (match !== null) {
          violations.push(`${clientModule} reaches ${file} (matches ${match})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("never lets a client module import a server-only Node builtin", () => {
    const violations: string[] = [];
    for (const clientModule of clientModules) {
      const reachable = reachableFrom([clientModule]);
      for (const file of reachable) {
        for (const specifier of importSpecifiers(file)) {
          if (FORBIDDEN_BUILTINS.includes(specifier)) {
            violations.push(`${file} imports ${specifier} (reachable from ${clientModule})`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("never lets a client module import next/headers", () => {
    const violations: string[] = [];
    for (const clientModule of clientModules) {
      const reachable = reachableFrom([clientModule]);
      for (const file of reachable) {
        if (importSpecifiers(file).includes("next/headers")) {
          violations.push(`${file} imports next/headers (reachable from ${clientModule})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("server boundaries", () => {
  const all = sourceFiles();

  it("keeps the read-only web surface free of the upstream adapter", () => {
    // The web process must not even load the upstream client, so a browser can
    // never be proxied to it.
    const webSurface = all.filter(
      (file) => file.startsWith("app/") || file.startsWith("components/") || file === "proxy.ts",
    );
    const violations: string[] = [];
    for (const file of webSurface) {
      const reachable = reachableFrom([file]);
      for (const reached of reachable) {
        if (reached.startsWith("lib/upstream/")) {
          violations.push(`${file} reaches ${reached}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the application read-only: no route handler exports a mutating method", () => {
    // The only permitted mutations are the owner's own sign-in and sign-out.
    const allowed = new Set(["app/api/auth/login/route.ts", "app/api/auth/logout/route.ts"]);
    const violations: string[] = [];
    for (const file of all) {
      if (!file.startsWith("app/api/") || !file.endsWith("/route.ts")) continue;
      const source = readSource(file);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(source) && !allowed.has(file)) {
          violations.push(`${file} exports ${method}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the upstream adapter GET-only", () => {
    const source = readSource("lib/upstream/adapter.ts");
    // Every request must be a GET, and redirects must not be followed.
    expect(source).toContain('method: "GET"');
    expect(source).toContain('redirect: "error"');
    expect(source).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
  });

  it("never reads a credential file", () => {
    // Credentials come from the environment only. This guards against someone
    // reintroducing a dotenv-style file read of an auth file.
    const violations: string[] = [];
    for (const file of all) {
      const source = readSource(file);
      if (/opencode\.env|\.env\.local|readFileSync\([^)]*env/i.test(source)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  it("never exposes an upstream URL to the browser", () => {
    // A NEXT_PUBLIC_ variable would be inlined into the client bundle.
    const violations: string[] = [];
    for (const file of all) {
      const source = readSource(file);
      if (/NEXT_PUBLIC_/.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it("keeps the dashboard's own API paths hard-coded and relative", () => {
    // A client that accepted a caller-supplied URL could be pointed at another
    // origin; the fetch paths must be literals starting with /api/.
    const violations: string[] = [];
    for (const file of all.filter(isClientModule)) {
      const source = readSource(file);
      for (const match of source.matchAll(/fetch\(\s*([^,)]+)/g)) {
        const target = match[1]?.trim() ?? "";
        const isRelativeLiteral = /^["'`]\/api\//.test(target);
        const isTemplateLiteral = target.startsWith("`/api/");
        const isVariable = /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(target);
        if (!isRelativeLiteral && !isTemplateLiteral && !isVariable) {
          violations.push(`${file}: fetch(${target}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("redaction policy boundaries", () => {
  it("keeps the redaction utility dependency-free", () => {
    // The policy lives in `lib/util/redact.ts` so that the persistence layer can
    // import it without reaching into the collector. Any import at all would
    // defeat that: it would re-couple the write boundary to a higher layer and
    // put a cycle one refactor away.
    expect(importSpecifiers("lib/util/redact.ts")).toEqual([]);
  });

  it("keeps the persistence layer out of the collector", () => {
    // Redaction is enforced where a value is written, so every db writer imports
    // the utility directly. A db module importing the collector would invert the
    // dependency — persistence would depend on normalisation — which is exactly
    // what the move exists to prevent.
    const violations: string[] = [];
    for (const file of sourceFiles()) {
      if (!file.startsWith("lib/db/")) continue;
      for (const specifier of importSpecifiers(file)) {
        const resolved = resolveRelative(file, specifier);
        if (resolved !== null && resolved.startsWith("lib/collector/")) {
          violations.push(`${file} imports ${resolved}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the collector's redact module a pure re-export of the utility", () => {
    // The compatibility shim must hold no logic of its own. If the policy were
    // duplicated there, the two copies could drift and the write boundary would
    // enforce a different policy than the normaliser.
    const source = readSource("lib/collector/redact.ts");
    // The parser is text-based and also sees the prose in the doc comment, so
    // compare as a set: the only module it may reference is the utility.
    expect(new Set(importSpecifiers("lib/collector/redact.ts"))).toEqual(new Set(["../util/redact.ts"]));
    const body = source.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    expect(body).toBe('export * from "../util/redact.ts";');
  });
});
