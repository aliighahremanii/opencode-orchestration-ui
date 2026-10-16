import { Suspense } from "react";
import { StatusView } from "../../components/client/status-view.tsx";
import { AuthGate } from "../../components/server/auth-gate.tsx";
import { PageHeader } from "../../components/server/page-header.tsx";

export default function Page() {
  return (
    <>
      <PageHeader
        title="Collection status"
        description="Database state, collector liveness, checkpoints, recorded gaps, and the limits of this build."
      />
      <Suspense fallback={<p className="text-sm text-muted">Checking your session…</p>}>
        <AuthGate>
          <StatusView />
        </AuthGate>
      </Suspense>
    </>
  );
}
