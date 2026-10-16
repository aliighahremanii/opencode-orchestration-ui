"use client";

import { Badge } from "./ui.tsx";
import type { LiveChangesState } from "./use-api.ts";

/**
 * Live-update indicator.
 *
 * Shows whether the local change stream is connected and how far it has
 * delivered. A disconnected indicator is important: it tells the operator the
 * view may be stale rather than silently showing old data.
 */
export function LiveIndicator({ live }: { live: LiveChangesState }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted">
      <Badge tone={live.connected ? "positive" : "warning"} title={`Delivered sequence ${live.lastSeq}; latest known ${live.latestSeq}`}>
        {live.connected ? "live" : "reconnecting"}
      </Badge>
      <span className="tabular-nums">seq {live.lastSeq}</span>
    </span>
  );
}
