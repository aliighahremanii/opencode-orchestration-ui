import { Suspense } from "react";
import { ActivityView } from "../../components/client/activity-view.tsx";
import { AuthGate } from "../../components/server/auth-gate.tsx";
import { PageHeader } from "../../components/server/page-header.tsx";

export default function Page() {
  return (
    <>
      <PageHeader
        title="Activity"
        description="Normalized, deduplicated, redacted observations across every observed session."
      />
      <Suspense fallback={<p className="text-sm text-muted">Checking your session…</p>}>
        <AuthGate>
          <ActivityView />
        </AuthGate>
      </Suspense>
    </>
  );
}
