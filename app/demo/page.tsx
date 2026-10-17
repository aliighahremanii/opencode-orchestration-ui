import { Workspace } from "../../components/workspace/workspace.tsx";

export default function DemoPage() {
  return <Suspense fallback={<p className="text-sm text-muted">Checking your session…</p>}>
    <AuthGate><Workspace demo /></AuthGate>
  </Suspense>;
}
import { Suspense } from "react";
import { AuthGate } from "../../components/server/auth-gate.tsx";
