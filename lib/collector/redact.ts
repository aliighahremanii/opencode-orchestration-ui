/**
 * Compatibility re-export of the redaction policy.
 *
 * The policy now lives in `lib/util/redact.ts`, a dependency-free module that
 * both the collector and the persistence layer import directly. That move exists
 * so redaction is enforced where a value is *written*, not only where it is
 * normalised: a database writer must be able to redact a field without depending
 * on the collector.
 *
 * This module is kept only so existing imports of the old path keep resolving.
 * It holds no logic of its own — importing it is equivalent to importing
 * `lib/util/redact.ts` — and new code should import the utility directly.
 */
export * from "../util/redact.ts";
