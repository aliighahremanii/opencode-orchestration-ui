"use client";

import { useEffect, useState } from "react";
import { postJson } from "./use-api.ts";
import { safeNext } from "./safe-next.ts";
import type { AuthSessionState, LoginSuccess } from "../../lib/contracts/api.ts";

/**
 * Owner sign-in form.
 *
 * The page is static, so nothing here reads request data during render. The
 * destination is read from the URL at the moment it is used (inside the session
 * probe and inside submit), which keeps the effect body free of synchronous
 * state updates and keeps `?next=` constrained to a same-site path.
 */
export function LoginForm() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configReason, setConfigReason] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const target = safeNext(readNextParam());
      try {
        const response = await fetch("/api/auth/session", {
          credentials: "same-origin",
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        if (!response.ok) return;
        const state = (await response.json()) as AuthSessionState;
        if (cancelled) return;
        setConfigured(state.configured);
        setConfigReason(state.reason);
        if (state.authenticated) {
          // Already signed in: go straight to the requested page.
          window.location.replace(target);
        }
      } catch {
        // The form still renders; submitting will surface the failure.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await postJson<LoginSuccess>("/api/auth/login", { password });
    if (result.ok) {
      // A full navigation is deliberate: it discards any cached page data and
      // picks up the new session cookie.
      window.location.replace(safeNext(readNextParam()));
      return;
    }
    setError(result.error.message);
    setBusy(false);
  };

  return (
    <form
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="w-full max-w-sm rounded-lg border border-border bg-surface p-4"
    >
      <h1 className="text-lg font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-muted">This dashboard has a single owner.</p>

      {configured === false ? (
        <p className="mt-3 rounded border border-amber-600/40 bg-amber-500/10 p-2 text-xs">
          {configReason ?? "No owner credential is configured."}
        </p>
      ) : null}

      <label className="mt-4 block text-sm" htmlFor="password">
        Owner password
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
      />

      {error === null ? null : (
        <p role="alert" className="mt-3 rounded border border-red-600/40 bg-red-500/10 p-2 text-xs">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || password === ""}
        className="mt-4 w-full rounded border border-border bg-background px-3 py-1.5 text-sm font-medium disabled:opacity-50"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function readNextParam(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("next");
}
