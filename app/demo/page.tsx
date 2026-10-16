import { OfficeView } from "../../components/office/office-view.tsx";
import { DEMO_OFFICE } from "../../lib/office/demo.ts";

export default function DemoPage() {
  return <Suspense fallback={<p className="text-sm text-muted">Checking your session…</p>}>
    <AuthGate><OfficeView data={DEMO_OFFICE} /></AuthGate>
  </Suspense>;
}
import { Suspense } from "react";
import { AuthGate } from "../../components/server/auth-gate.tsx";
