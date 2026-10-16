import { Suspense } from "react";
import { OverviewView } from "../../components/client/overview-view.tsx";
import { AuthGate } from "../../components/server/auth-gate.tsx";
import { PageHeader } from "../../components/server/page-header.tsx";

export default function OverviewPage() {
  return <><PageHeader title="Observation overview" description="Retained telemetry, root runs, activity and collection health." /><Suspense fallback={<p>Checking your session…</p>}><AuthGate><OverviewView /></AuthGate></Suspense></>;
}
