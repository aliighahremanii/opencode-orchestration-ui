"use client";

/**
 * Constrain a `?next=` destination to a same-origin path.
 *
 * The sign-in page honours a post-login destination so a deep link that bounced
 * through `/login` returns where the user was headed. That makes the parameter an
 * open-redirect surface, so the check is deliberately conservative and is done by
 * *parsing* the value rather than by pattern-matching the raw string.
 *
 * Why parsing, and not the obvious `startsWith("//")` test: a browser's URL parser
 * strips tab, newline, and carriage return characters and treats `\` as `/`, so
 * `"/\t/attacker.example"` (a literal tab, which is what `URLSearchParams` yields
 * for `?next=/%09/attacker.example`) becomes `//attacker.example` — a
 * protocol-relative navigation to another origin. `"\\attacker.example"` and
 * `"/..//attacker.example"` do the same by different routes. Resolving the value
 * against the dashboard origin and requiring the *resolved* origin to match, plus
 * rejecting a normalised `//` path, catches all of them at once.
 *
 * The returned value is always a same-origin relative path (`/`, or a
 * `pathname?query#fragment`), never an absolute URL.
 */

/** C0 controls, DEL, and the backslash the URL parser folds into `/`. */
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;

/**
 * Percent-encoded forms of the same characters (`%00`–`%1f`, `%7f`, `%5c`).
 *
 * A value that reaches this function already decoded is covered by the check
 * above; rejecting the encoded form too means a value that is still encoded —
 * which a browser could decode during navigation — cannot smuggle a control
 * character past the check.
 */
const ENCODED_CONTROL_OR_BACKSLASH = /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i;

/** The dashboard origin: the page's own origin in the browser, a safe default otherwise. */
function currentOrigin(): string {
  if (typeof window !== "undefined" && typeof window.location?.origin === "string" && window.location.origin !== "") {
    return window.location.origin;
  }
  return "http://localhost";
}

export function safeNext(nextPath: string | null, baseOrigin?: string): string {
  const fallback = "/";
  if (nextPath === null || nextPath === "") return fallback;

  // A destination must be an absolute path. Anything that is not a leading `/`
  // is either a relative path (ambiguous once resolved) or a full URL.
  if (!nextPath.startsWith("/")) return fallback;

  // Protocol-relative (`//host/path`): the browser reads `host` as the authority.
  if (nextPath.startsWith("//")) return fallback;

  // Control characters and backslashes, literal or encoded.
  if (CONTROL_OR_BACKSLASH.test(nextPath)) return fallback;
  if (ENCODED_CONTROL_OR_BACKSLASH.test(nextPath)) return fallback;

  const base = baseOrigin ?? currentOrigin();
  let resolved: URL;
  let baseResolved: URL;
  try {
    resolved = new URL(nextPath, base);
    baseResolved = new URL(base);
  } catch {
    return fallback;
  }

  // The resolved origin must be exactly the dashboard's. This is the check that
  // makes every parser-level trick (control characters, backslashes, `//`) fail
  // even if one of the guards above were loosened.
  if (resolved.origin !== baseResolved.origin) return fallback;

  // `..` segments can normalise a same-origin-looking path into a
  // protocol-relative one (`/..//attacker.example` -> `//attacker.example`).
  if (resolved.pathname.startsWith("//")) return fallback;

  // Never bounce straight back to the sign-in page.
  if (resolved.pathname === "/login" || resolved.pathname.startsWith("/login/")) return fallback;

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
