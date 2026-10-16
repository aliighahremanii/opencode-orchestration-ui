"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "./use-api.ts";

/**
 * Sign out.
 *
 * Revokes the session server-side, then replaces the route and refreshes so the
 * server components re-render without the session instead of leaving cached
 * authenticated output on screen.
 */
export function SignOutButton() {
  const router = useRouter();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);

  const onClick = async (): Promise<void> => {
    setBusy(true);
    try {
      await postJson("/api/auth/logout", {});
    } finally {
      router.replace("/login");
      router.refresh();
      setBusy(false);
    }
  };

  if (pathname === "/demo") return <span className="text-xs text-muted">Isolated demo</span>;
  return (
    <button
      type="button"
      onClick={() => {
        void onClick();
      }}
      disabled={busy}
      className="rounded border border-border px-2 py-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
