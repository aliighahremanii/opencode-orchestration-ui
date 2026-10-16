import { Suspense } from "react";
import { LiveOffice } from "../components/office/office-view.tsx";
import { AuthGate } from "../components/server/auth-gate.tsx";

/**
 * Overview page.
 *
 * The heading is static and belongs in the prerendered shell. Everything
 * session-dependent sits behind `<Suspense>` because `AuthGate` reads cookies,
 * and the view itself loads data from the authenticated API on the client.
 */
export default function Page() {
  return (
    <>
      <Suspense fallback={<p className="text-sm text-muted">Checking your session…</p>}>
        <AuthGate>
          <LiveOffice />
        </AuthGate>
      </Suspense>
    </>
  );
}
