import { Suspense } from "react";
import { SessionDetailView } from "../../../components/client/session-detail-view.tsx";
import { AuthGate } from "../../../components/server/auth-gate.tsx";
import { PageHeader } from "../../../components/server/page-header.tsx";

type Params = Promise<{ sessionId: string }>;

/**
 * The route parameter is awaited inside the `<Suspense>` boundary so the heading
 * and shell remain prerenderable.
 */
export default function Page({ params }: { params: Params }) {
  return (
    <>
      <PageHeader
        title="Session detail"
        description="Observed metadata, evidence-backed invocations, and the full activity timeline for one session."
      />
      <Suspense fallback={<p className="text-sm text-muted">Checking your session…</p>}>
        <GatedSession params={params} />
      </Suspense>
    </>
  );
}

async function GatedSession({ params }: { params: Params }) {
  const { sessionId } = await params;
  return (
    <AuthGate>
      <SessionDetailView sessionId={sessionId} />
    </AuthGate>
  );
}
