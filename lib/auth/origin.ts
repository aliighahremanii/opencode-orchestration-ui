import type { NextRequest } from "next/server";
import { getConfig } from "../config.ts";

/**
 * CSRF / cross-origin protection for state-changing requests.
 *
 * This application has exactly one owner and no public write API, but it does
 * expose `POST /api/auth/login` and `POST /api/auth/logout`. Those endpoints
 * change server state, so they must not be reachable from another origin.
 *
 * The check fails closed: a state-changing request with no `Origin` header is
 * rejected rather than allowed. Browsers always send `Origin` for `fetch` POSTs,
 * so this only affects non-browser clients, which must opt in explicitly.
 */

export type OriginCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The set of origins a state-changing request may come from.
 *
 * The primary source is the request's own `Host` header combined with the
 * effective protocol, because that is the origin the browser believes it is
 * talking to. `request.url` is added as well, but it is not relied on: a
 * framework or proxy may normalise the host in the URL differently from the
 * `Host` header, and that mismatch would reject legitimate same-origin requests.
 *
 * The configured public origin is added so a deployment reachable through a
 * canonical hostname accepts requests that arrive on that hostname.
 */
export function allowedOriginsFor(request: NextRequest): string[] {
  const allowed = new Set<string>();

  const host = request.headers.get("host");
  if (host !== null && host.trim() !== "") {
    allowed.add(`${effectiveProtocol(request)}://${host.trim()}`);
  }

  try {
    allowed.add(new URL(request.url).origin);
  } catch {
    // A malformed request URL simply contributes no origin.
  }

  const publicOrigin = getConfig().auth.publicOrigin;
  if (publicOrigin !== null) {
    allowed.add(publicOrigin);
  }
  return [...allowed];
}

/** The protocol the client actually used, honouring a reverse proxy. */
function effectiveProtocol(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwarded === "http" || forwarded === "https") return forwarded;
  try {
    const protocol = new URL(request.url).protocol;
    if (protocol === "https:") return "https";
  } catch {
    // Fall through to http.
  }
  return "http";
}

function normaliseOrigin(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export function checkRequestOrigin(request: NextRequest): OriginCheck {
  if (SAFE_METHODS.has(request.method.toUpperCase())) {
    return { ok: true };
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") {
    return { ok: false, reason: `cross-site request rejected (sec-fetch-site=${fetchSite})` };
  }

  const originHeader = request.headers.get("origin");
  if (originHeader === null || originHeader.trim() === "") {
    return { ok: false, reason: "missing Origin header on a state-changing request" };
  }
  const origin = normaliseOrigin(originHeader);
  if (origin === null) {
    return { ok: false, reason: "malformed Origin header" };
  }
  if (!allowedOriginsFor(request).includes(origin)) {
    return { ok: false, reason: `origin ${origin} is not allowed` };
  }
  return { ok: true };
}
