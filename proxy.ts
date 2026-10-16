import { NextResponse, type NextRequest } from "next/server";
import { getConfig } from "./lib/config.ts";

/**
 * Optimistic page gate.
 *
 * This is *not* the authorization boundary. It only decides whether a browser
 * that has no session cookie at all should be sent to the sign-in page instead
 * of receiving a page shell. The real check is server-side and
 * database-backed, in two places:
 *
 * - every Route Handler calls `authenticate()`, which verifies the session
 *   against the `auth_sessions` table;
 * - every protected page renders an auth gate that performs the same check
 *   before it renders any content.
 *
 * Proxy deliberately performs no database access: the Next.js guide is explicit
 * that proxy runs on every request (including prefetches) and should only read
 * the cookie. It also never redirects away from `/login`, so an invalid cookie
 * cannot cause a redirect loop.
 */

const PUBLIC_PATHS = new Set(["/login"]);

function isProtectedPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return false;
  if (pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/_next/")) return false;
  return true;
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (!isProtectedPath(pathname)) {
    return NextResponse.next();
  }

  let cookieName = "orch_session";
  try {
    cookieName = getConfig().auth.cookieName;
  } catch {
    // Invalid configuration: send the operator to the sign-in page, which
    // reports the configuration problem. Never fall through to serving a page.
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  const token = request.cookies.get(cookieName)?.value;
  if (token === undefined || token === "") {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Preserve the destination so a successful sign-in can return the operator
    // to where they were. Only the path is kept, never the full URL.
    if (pathname !== "/") {
      url.searchParams.set("next", pathname);
    }
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Run on every page request, excluding:
     * - /api        (Route Handlers enforce auth themselves and answer with JSON)
     * - /_next/*    (build output and image optimization)
     * - /favicon.ico and other static assets
     */
    "/((?!api|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
