import { Suspense } from "react";
import { AgentsView } from "../../components/client/agents-view.tsx";
import { AuthGate } from "../../components/server/auth-gate.tsx";
import { PageHeader } from "../../components/server/page-header.tsx";

export default function Page() {
  return (
    <>
      <PageHeader
        title="Effective agents"
        description="Agent definitions reported by the upstream API for each location. A definition is not evidence of execution."
      />
      <Suspense fallback={<p className="text-sm text-muted">Checking your session…</p>}>
        <AuthGate>
          <AgentsView />
        </AuthGate>
      </Suspense>
    </>
  );
}
