import type { ReactNode } from "react";
import Link from "next/link";

/** Static page heading. Contains no data, so it belongs in the static shell. */
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
      <div className="min-w-0">
        <Link href="/" prefetch={false} className="mb-3 inline-block text-sm text-muted">← Back to workspace</Link>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description === undefined ? null : <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions === undefined ? null : <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
