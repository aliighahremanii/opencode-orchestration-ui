import { Suspense } from "react";
import { RunsView } from "../../components/client/runs-view.tsx";
import { AuthGate } from "../../components/server/auth-gate.tsx";
import { PageHeader } from "../../components/server/page-header.tsx";

export default function Page() {
  return (
    <>
      <PageHeader
        title="Root runs"
        description="A root run is a root session plus every session observed to descend from it."
      />
      <Suspense fallback={<p className="text-sm text-muted">Checking your session…</p>}>
        <AuthGate>
          <RunsView />
        </AuthGate>
      </Suspense>
    </>
  );
}
