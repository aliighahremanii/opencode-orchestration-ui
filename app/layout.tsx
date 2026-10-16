import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import "./globals.css";
import { SignOutButton } from "../components/client/sign-out-button.tsx";

export const metadata: Metadata = {
  title: "OpenCode — The office",
  description:
    "Read-only observation of an OpenCode instance: root runs, sessions, evidence-backed invocations, and collection health.",
};

const NAV = [
  { href: "/", label: "Office" },
  { href: "/overview", label: "Overview" },
  { href: "/runs", label: "Runs" },
  { href: "/activity", label: "Activity" },
  { href: "/agents", label: "Agents" },
  { href: "/status", label: "Status" },
  { href: "/demo", label: "Demo" },
];

/**
 * Root layout.
 *
 * Static on purpose: the navigation and chrome contain no data, so they render
 * into the static shell. Anything session-dependent lives inside a `<Suspense>`
 * boundary in the page that needs it.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <header className="border-b border-border bg-surface">
          <div className="office-shell-header mx-auto flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <Link href="/" prefetch={false} className="office-brand text-sm font-semibold tracking-tight">
              <span aria-hidden="true">▧</span> opencode <span className="office-brand-divider">/</span> studio
            </Link>
            <nav aria-label="Primary" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} prefetch={false} className="text-muted hover:text-foreground">
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="ms-auto">
              <Suspense fallback={null}><SignOutButton /></Suspense>
            </div>
          </div>
        </header>
        <main className="office-shell-main mx-auto w-full flex-1 px-4 py-6" id="main-content">{children}</main>
        <footer className="border-t border-border px-4 py-4 text-xs text-muted">
          <div className="mx-auto w-full max-w-6xl">
            OpenCode studio · Evidence before inference. Dispatch unavailable until the upstream write contract is verified.
          </div>
        </footer>
      </body>
    </html>
  );
}
