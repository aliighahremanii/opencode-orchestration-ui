import Link from "next/link";
import type { ReactNode } from "react";
import { getCookieAuthState } from "../../lib/auth/dal.ts";

/**
 * Server-side page gate.
 *
 * Renders its children only when a valid owner session is present. The check is
 * database-backed (it verifies the session row, not just the cookie's
 * existence), so a forged or revoked cookie does not pass.
 *
 * This component reads `cookies()`, so callers must place it inside a
 * `<Suspense>` boundary. It returns a state object rather than throwing so an
 * expired session produces a sign-in prompt instead of an error page.
 *
 * Note that the children are never rendered when the check fails: React only
 * evaluates the elements the component returns, so no protected content reaches
 * the RSC payload.
 */
export async function AuthGate({ children }: { children: ReactNode }) {
  const state = await getCookieAuthState();

  if (state.authenticated) {
    return <>{children}</>;
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm font-semibold">
        {state.configured ? "Sign-in required" : "Not configured"}
      </h2>
      <p className="mt-1 text-sm">
        {state.configured
          ? "This dashboard is available to the configured owner only."
          : "The observer has no owner credential, so it refuses to serve data."}
      </p>
      {state.reason === null ? null : <p className="mt-2 text-sm text-muted">{state.reason}</p>}
      {state.configured ? (
        <Link className="mt-3 inline-block text-sm underline" href="/login">
          Go to sign-in
        </Link>
      ) : (
        <p className="mt-3 text-xs text-muted">
          Set <code className="font-mono">ORCH_OWNER_PASSWORD</code> (first run) or{" "}
          <code className="font-mono">ORCH_OWNER_PASSWORD_HASH</code>, then restart the web process.
        </p>
      )}
    </div>
  );
}
