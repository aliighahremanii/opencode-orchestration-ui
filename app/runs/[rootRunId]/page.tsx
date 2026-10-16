import Link from "next/link";
import { Suspense } from "react";
import { RunDetailView } from "../../../components/client/run-detail-view.tsx";
import { AuthGate } from "../../../components/server/auth-gate.tsx";
import { PageHeader } from "../../../components/server/page-header.tsx";

type Params = Promise<{ rootRunId: string }>;

/**
 * The page itself awaits nothing, so the heading stays in the prerendered shell.
 * The route parameter is awaited inside the `<Suspense>` boundary, which is the
 * documented way to keep a dynamic parameter from blocking the whole route.
 */
export default function Page({ params }: { params: Params }) {
  return (
    <>
      <PageHeader
        title="Run detail"
        description="Observed session hierarchy, evidence-backed invocations, and the activity timeline."
        actions={
          <Link className="text-xs underline" href="/runs">
            All runs
          </Link>
        }
      />
      <Suspense fallback={<p className="text-sm text-muted">Checking your session…</p>}>
        <GatedRun params={params} />
      </Suspense>
    </>
  );
}

async function GatedRun({ params }: { params: Params }) {
  const { rootRunId } = await params;
  return (
    <AuthGate>
      <RunDetailView runId={rootRunId} />
    </AuthGate>
  );
}
