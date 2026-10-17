/** No environment switch can bypass this gate. Installed API schema is not enforcement proof. */
export const QUESTION_CAPABILITY = {
  enabled: false as const,
  reason: "Unavailable: read-only permission enforcement and collection isolation have not been verified for the installed OpenCode API. No question is sent to the source session.",
};
