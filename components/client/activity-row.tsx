"use client";

import Link from "next/link";
import { useState } from "react";
import type { ActivityItem, ActivityKind } from "../../lib/contracts/api.ts";
import { formatRelative, formatTimestamp, upstreamOutcomeLabel } from "../../lib/format.ts";
import { Badge, type Tone } from "./ui.tsx";

const KIND_TONE: Record<ActivityKind, Tone> = {
  "message-user": "info",
  "message-assistant": "positive",
  "message-system": "neutral",
  "message-synthetic": "neutral",
  "message-skill": "neutral",
  "message-shell": "warning",
  "message-idle": "neutral",
  "message-compaction": "neutral",
  "agent-switched": "info",
  "model-switched": "neutral",
  "location-switched": "neutral",
  tool: "warning",
};

const KIND_LABEL: Record<ActivityKind, string> = {
  "message-user": "user",
  "message-assistant": "assistant",
  "message-system": "system",
  "message-synthetic": "synthetic",
  "message-skill": "skill",
  "message-shell": "shell",
  "message-idle": "idle",
  "message-compaction": "compaction",
  "agent-switched": "agent switch",
  "model-switched": "model switch",
  "location-switched": "location switch",
  tool: "tool",
};

export const ACTIVITY_KINDS = Object.keys(KIND_LABEL) as ActivityKind[];

export function activityKindLabel(kind: ActivityKind): string {
  return KIND_LABEL[kind];
}

/**
 * One activity event.
 *
 * Redaction and truncation are shown as badges rather than being silent, so a
 * reader knows the stored text is not the complete upstream text.
 */
export function ActivityRow({ item, clock }: { item: ActivityItem; clock: number }) {
  const [expanded, setExpanded] = useState(false);
  const hasBody = item.content !== null && item.content !== "";

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Badge tone={KIND_TONE[item.kind]}>{KIND_LABEL[item.kind]}</Badge>
        {item.toolName === null ? null : <span className="text-xs font-medium">{item.toolName}</span>}
        {item.toolStatus === null ? null : <Badge tone={item.toolStatus === "error" ? "negative" : "neutral"}>{item.toolStatus}</Badge>}
        {item.actorAgentId === null ? null : <span className="text-xs text-muted">agent {item.actorAgentId}</span>}
        {item.redacted ? (
          <Badge tone="warning" title="Credential-shaped content was replaced before storage.">
            redacted
          </Badge>
        ) : null}
        {item.truncated ? (
          <Badge tone="neutral" title="Stored text is capped by ORCH_CONTENT_MAX_CHARS.">
            truncated
          </Badge>
        ) : null}
        {item.upstreamOutcome === null ? null : <Badge tone="info">{upstreamOutcomeLabel(item.upstreamOutcome)}</Badge>}
        <span className="text-xs text-muted" title={formatTimestamp(item.occurredAt)}>
          {clock === 0 ? formatTimestamp(item.occurredAt) : formatRelative(item.occurredAt, clock)}
        </span>
        <Link className="text-xs underline" href={`/sessions/${item.sessionId}`}>
          session
        </Link>
      </div>

      <p className="untrusted-text mt-1 text-sm">{item.summary === "" ? "(no summary)" : item.summary}</p>

      {hasBody ? (
        <>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="mt-1 text-xs underline"
            aria-expanded={expanded}
          >
            {expanded ? "Hide stored content" : "Show stored content"}
          </button>
          {expanded ? (
            <pre className="untrusted-text mt-1 max-h-80 overflow-auto rounded border border-border bg-background p-2 text-xs">
              {item.content}
            </pre>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
