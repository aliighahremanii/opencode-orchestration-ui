import type { ActivityItem, OfficeResponse } from "../contracts/api.ts";

// No clocks, random numbers, network or production identifiers. This module is
// imported only by /demo. Its observations are synthetic, including timestamps.
const AT = Date.UTC(2026, 9, 16, 10, 30);
const names = ["Architect", "Implementer", "Reviewer", "Researcher", "Tester", "Designer", "Domain expert", "Operator"];
const tasks = ["Plan the workspace boundaries", "Build the project directory", "Review authentication boundaries", "Verify the upstream contract", "Exercise recovery scenarios", "Refine the office navigation", "Clarify invocation identity", "Inspect collection coverage"];

function activity(index: number, task: boolean): ActivityItem {
  return {
    id: `demo-event-${index}-${task}`, kind: task ? "message-user" : "tool", sessionId: `ses_demo_${index}`,
    runId: `demo-run-${Math.floor(index / 4)}`, messageId: `msg_demo_${index}_${task ? "user" : "assistant"}`,
    partIndex: 0, sequence: task ? 1 : 2, occurredAt: AT - 60_000 * (index + 1),
    actorAgentId: task ? null : `demo-agent-${index === 6 ? 1 : index % 8}`, toolName: task ? null : ["read", "patch", "shell", "search"][index % 4],
    toolStatus: task ? null : index === 4 ? "error" : index === 1 ? "running" : "completed",
    summary: task ? tasks[index % 8] : ["Read the interface contract", "Updated the directory component", "Ran boundary checks", "Searched reference documentation"][index % 4],
    content: null, truncated: false, redacted: false, upstreamOutcome: null, source: "fixture",
  };
}

export const DEMO_OFFICE: OfficeResponse = {
  generatedAt: AT, source: "demo",
  collector: { state: "stopped", scope: "demo", holderId: null, epoch: null, lastCycleAt: AT,
    lastCycleOk: true, lastSuccessAt: AT, lastError: null, leaseExpiresAt: null },
  locations: [
    { id: "demo-studio", projectId: "OpenCode Studio", directory: "/demo/studio", canonical: "/demo/studio", agentCount: 8, sessionCount: 8, source: "fixture" },
    { id: "demo-lab", projectId: "Interface Lab", directory: "/demo/lab", canonical: "/demo/lab", agentCount: 2, sessionCount: 2, source: "fixture" },
  ],
  agents: names.map((name, index) => ({
    locationId: "demo-studio", locationDirectory: "/demo/studio", agentId: `demo-agent-${index}`, name,
    mode: index === 0 ? "primary" : "subagent", hidden: false, active: index !== 7,
    description: ["Shapes a coherent technical plan and makes boundaries explicit.", "Implements approved changes with careful attention to correctness.", "Independently checks evidence, behavior and failure modes.", "Investigates interfaces and distinguishes documented from verified.", "Exercises the system, including failure and recovery.", "Makes complex systems calm, legible and accessible.", "Protects shared vocabulary and domain invariants.", "Observes deployment and collection health."][index],
    modelProviderId: "demo", modelId: "synthetic-model", firstSeenAt: AT - 86_400_000, lastSeenAt: AT,
    observedInvocationCount: index === 1 ? 2 : index === 6 ? 0 : 1, source: "fixture",
  })),
  runs: [0, 1, 2].map((index) => ({
    id: `demo-run-${index}`, locationId: index === 2 ? "demo-lab" : "demo-studio",
    locationDirectory: index === 2 ? "/demo/lab" : "/demo/studio", rootSessionId: `ses_demo_${index * 4}`,
    title: ["A clearer workspace", "Reliable observation", "Interface explorations"][index],
    status: "unknown", startedAt: AT - 3_600_000, lastActivityAt: AT - 60_000,
    agentId: null, sessionCount: 4, invocationCount: index === 2 ? 2 : 4, source: "fixture",
  })),
  invocations: Array.from({ length: 10 }, (_, index) => ({
    id: `demo-invocation-${index}`, runId: `demo-run-${Math.floor(index / 4)}`, sessionId: `ses_demo_${index}`,
    agentId: `demo-agent-${index === 6 ? 1 : index % 8}`, locationId: index < 8 ? "demo-studio" : "demo-lab",
    projectId: index < 8 ? "OpenCode Studio" : "Interface Lab", modelProviderId: "demo", modelId: "synthetic-model",
    startedAt: AT - (index + 1) * 120_000, endedAt: index === 1 ? null : AT - 60_000,
    toolCallCount: 1, upstreamOutcome: index === 4 ? "failed" : index === 2 ? "succeeded" : null,
    confidence: "verified", evidence: { rule: "assistant-message-agent-field", synthetic: true }, source: "fixture",
    assistantMessageId: `msg_demo_${index}_assistant`, task: activity(index, true), action: activity(index, false),
  })),
  coverage: { openGaps: 1, partialStreams: 0, totalInvocations: 10, totalAgents: 8, totalLocations: 2, limited: false },
  dispatch: { create: false, continue: false, reason: "Demo is isolated. Synthetic observations only; commands are never sent." },
};
