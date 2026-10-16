import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  containsRedactionPlaceholder,
  isCamelSecretLabel,
  isEnvSecretLabel,
  isSecretKey,
  isSeparatorSecretLabel,
  isSensitiveLabel,
  redactPersistedField,
  redactPrivateKeyBlocksWithWork,
  redactSerializedValue,
  redactStructuredLeaves,
  redactText,
  redactTextWithWork,
  sanitiseForDisplay,
  summariseLine,
  truncateText,
} from "../../lib/util/redact.ts";

/**
 * Redaction is the highest-consequence transformation in the system: a miss
 * persists a live credential into a database the dashboard renders.
 */
/**
 * A guard that must run before anything else.
 *
 * The classifier is reached once per position by several rules, so a pathological
 * pattern does not merely slow one assertion — it hangs whichever test happens to
 * feed it a long mixed-case run. Checking the pattern's shape first makes such a
 * regression fail immediately and name itself, rather than time out elsewhere.
 */
describe("redaction pattern shape", () => {
  it("classifies the camelCase key with a linear parser, not a regex", () => {
    // The deterministic guard. The camelCase key shape was a regular expression
    // whose repetitions overlapped — the leading `[A-Za-z0-9]*[a-z0-9]` could divide
    // a run in many ways and the trailing run had to reach the end — so a near-miss
    // label cost seconds and grew quadratically. No pattern can be bounded from
    // outside, so the shape is now decided by `isCamelSecretLabel`. This asserts the
    // source, because a timing check on the broken pattern cannot finish: the
    // classifier is reached once per position by several rules. It is declared first
    // so a regression fails here immediately rather than hanging a later test.
    const source = readFileSync(path.join(process.cwd(), "lib/util/redact.ts"), "utf8");
    // No camelCase key pattern is built any more.
    expect(source).not.toContain("CAMEL_SECRET_KEY");
    // The classifier is the linear parser, and it is what the shared label test uses.
    expect(source).toContain("function isCamelSecretLabel(");
    expect(source).toMatch(/isSeparatorSecretLabel\(key\) \|\| isCamelSecretLabel\(key\)/);
    // The three camelCase rules are linear passes, not patterns.
    for (const name of [
      "camel-escaped-quoted-key-secret",
      "camel-quoted-key-secret",
      "camel-key-value-secret",
    ]) {
      const at = source.indexOf(`name: "${name}"`);
      expect(at, name).toBeGreaterThan(0);
      expect(source.slice(at, at + 220), name).toContain("apply:");
    }
  });
});

describe("redactText", () => {
  it("redacts a secret whose key is quoted, as JSON.stringify produces", () => {
    // Regression: the unquoted-key rule cannot match a quote between key and
    // separator, so a structured payload used to bypass redaction entirely.
    for (const input of [
      '{"api_key":"super-secret-value-1234"}',
      '{"access_token":"abcdefghijklmnop"}',
      '{"password":"hunter2hunter2"}',
      '{"db_password":"p@ssw0rd-value"}',
      '{"client_secret":"c0ffee-c0ffee-c0ffee"}',
      "{'refresh_token':'abcdefghijklmnop'}",
    ]) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).toContain("[redacted]");
      expect(result.text, input).not.toMatch(/super-secret-value-1234|abcdefghijklmnop|hunter2hunter2|p@ssw0rd-value|c0ffee-c0ffee-c0ffee/);
    }
  });

  it("redacts a quoted secret nested in an array or object", () => {
    const input = '{"args":["--token","{\\"api_key\\":\\"nested-secret-9911\\"}"]}';
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("nested-secret-9911");
  });

  it("redacts an env-style assignment whose value is quoted", () => {
    // Regression: the previous value pattern excluded quotes, so
    // `API_KEY="secret"` was not matched at all.
    for (const input of ['API_KEY="secret-value-here"', "GITHUB_TOKEN='abcdefghijklmnop'", 'MY_PASSWORD="hunter2"']) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).not.toMatch(/secret-value-here|abcdefghijklmnop|hunter2/);
    }
  });

  it("redacts a key whose sensitive word is a later segment", () => {
    const result = redactText('{"db_password":"value-here-1234"}');
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("value-here-1234");
  });

  it("does not redact ordinary words that merely contain a sensitive fragment", () => {
    // `author` contains `auth` and `secretary` contains `secret`; neither names a
    // credential, so over-redacting them would destroy legitimate content.
    for (const input of ['{"author":"Ada Lovelace"}', '{"secretary":"Jane Roe"}', "author: Ada Lovelace", "secretary = Jane"]) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(false);
      expect(result.text, input).toBe(input);
    }
  });

  it("replaces an Authorization bearer header while keeping the label", () => {
    const input = "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdEFGH1234'";
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).toContain("Authorization:");
    expect(result.text).toContain("[redacted]");
    expect(result.text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("redacts a bearer token without a header label", () => {
    const result = redactText("token abcdefghijklmnopqrstuvwxyz012345");
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
  });

  it("redacts credentials embedded in a URL", () => {
    const result = redactText("https://alice:hunter2@example.com/repo.git");
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("hunter2");
    expect(result.text).toContain("example.com");
  });

  it("redacts a labelled key/value secret and preserves the key", () => {
    const result = redactText('api_key: "sk-live-abcdef0123456789"');
    expect(result.redacted).toBe(true);
    expect(result.text).toContain("api_key");
    expect(result.text).not.toContain("sk-live-abcdef0123456789");
  });

  it("redacts an env-style assignment whose name implies a secret", () => {
    const result = redactText("export OPENCODE_API_KEY=sk-live-abcdef0123456789abcdef");
    expect(result.redacted).toBe(true);
    expect(result.text).toContain("OPENCODE_API_KEY=");
    expect(result.text).not.toContain("sk-live-abcdef0123456789abcdef");
  });

  it("redacts a private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    const result = redactText(pem);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("MIIEowIBAAKCAQEA");
    expect(result.text).toContain("[redacted]");
    expect(result.text).toContain("BEGIN PRIVATE KEY");
  });

  it("redacts known provider token prefixes", () => {
    for (const secret of [
      "sk-ant-api03-abcdefghijklmnopqrst",
      "ghp_abcdefghijklmnopqrstuvwx",
      "xoxb-1234567890-abcdefghijkl",
      "AKIAIOSFODNN7EXAMPLE",
    ]) {
      const result = redactText(`value=${secret}`);
      expect(result.redacted, secret).toBe(true);
      expect(result.text, secret).not.toContain(secret);
    }
  });

  it("redacts a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const result = redactText(`Authorization: Bearer ${jwt}`);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk");
  });

  it("redacts a long hex blob", () => {
    const hex = "a".repeat(40) + "b".repeat(20);
    const result = redactText(`secret=${hex}`);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(hex);
  });

  it("redacts a mixed-case base64 blob", () => {
    const blob = "AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789AbCd";
    const result = redactText(`data: ${blob}`);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(blob);
  });

  it("leaves ordinary prose untouched and reports no redaction", () => {
    const text = "The lease is acquired in acquireLease and re-checked inside withFence.";
    const result = redactText(text);
    expect(result.redacted).toBe(false);
    expect(result.text).toBe(text);
  });

  it("does not redact a normal file path or identifier", () => {
    const text = "lib/db/collection-state.ts:88 uses BEGIN IMMEDIATE";
    const result = redactText(text);
    expect(result.redacted).toBe(false);
    expect(result.text).toBe(text);
  });

  it("is idempotent", () => {
    const input = "Authorization: Bearer abcdefghijklmnopqrstuvwx and api_key=zzzzzzzzzzzzzzzzzzzz";
    const once = redactText(input);
    const twice = redactText(once.text);
    expect(twice.text).toBe(once.text);
  });

  it("is idempotent across structured, quoted and labelled secrets together", () => {
    // Regression: a later rule used to match inside an earlier rule's
    // `[redacted]` output, so a second pass kept extending the placeholder.
    const input =
      '{"api_key":"sk-live-aaaaaaaaaaaaaaaa"} API_KEY="bbbbbbbbbbbbbbbb" Authorization: Bearer cccccccccccccccc';
    const once = redactText(input);
    const twice = redactText(once.text);
    const thrice = redactText(twice.text);
    expect(twice.text).toBe(once.text);
    expect(thrice.text).toBe(once.text);
    expect(once.text).not.toContain("sk-live-aaaaaaaaaaaaaaaa");
    expect(once.text).not.toContain("bbbbbbbbbbbbbbbb");
    expect(once.text).not.toContain("cccccccccccccccc");
    // Exactly one placeholder per secret, with no doubled brackets.
    expect(once.text.match(/\[redacted\]/g)?.length).toBe(3);
  });

  it("does not mangle text that already contains the placeholder", () => {
    const input = "already safe: [redacted] and api_key=[redacted]";
    const result = redactText(input);
    expect(result.text).toBe(input);
    expect(result.text).not.toContain("]]");
  });

  it("redacts multiple distinct secrets in one payload", () => {
    const input = "OPENCODE_API_KEY=sk-live-aaaaaaaaaaaaaaaa\nGITHUB_TOKEN=ghp_bbbbbbbbbbbbbbbbbbbb";
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("sk-live-aaaaaaaaaaaaaaaa");
    expect(result.text).not.toContain("ghp_bbbbbbbbbbbbbbbbbbbb");
  });

  // --- camelCase keys (HIGH: previously missed) ------------------------------

  it("redacts a quoted camelCase secret key", () => {
    // Regression: the key pattern only treated `_`, `-`, and `.` as segment
    // separators, so `accessToken` was not recognised as a credential key and an
    // opaque value was persisted verbatim.
    const secrets: Array<[string, string]> = [
      ['{"accessToken":"opaque-access-value-1234"}', "opaque-access-value-1234"],
      ['{"refreshToken":"opaque-refresh-value-1234"}', "opaque-refresh-value-1234"],
      ['{"clientSecret":"opaque-client-value-1234"}', "opaque-client-value-1234"],
      ['{"idToken":"opaque-id-value-1234"}', "opaque-id-value-1234"],
      ['{"userPassword":"opaque-pass-value-1234"}', "opaque-pass-value-1234"],
      ['{"myApiKey":"opaque-apikey-value-1234"}', "opaque-apikey-value-1234"],
      ['{"clientSecretKey":"opaque-csk-value-1234"}', "opaque-csk-value-1234"],
      ["{'accessToken':'opaque-single-quote-1234'}", "opaque-single-quote-1234"],
    ];
    for (const [input, secret] of secrets) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).toContain("[redacted]");
      expect(result.text, input).not.toContain(secret);
    }
  });

  it("redacts an unquoted camelCase key/value secret and preserves the key", () => {
    for (const [input, secret] of [
      ["accessToken: opaque-unquoted-value-1234", "opaque-unquoted-value-1234"],
      ["clientSecret=opaque-unquoted-value-5678", "opaque-unquoted-value-5678"],
    ] as const) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).not.toContain(secret);
    }
    const labelled = redactText("accessToken: opaque-unquoted-value-1234");
    expect(labelled.text).toContain("accessToken");
  });

  it("redacts a camelCase secret nested inside escaped/double-encoded JSON", () => {
    // A tool input is JSON-stringified, so its keys appear escaped once more.
    const input = '{"args":["--config","{\\"accessToken\\":\\"nested-camel-secret-9911\\"}"]}';
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("nested-camel-secret-9911");
  });

  it("redacts a camelCase secret nested in a structured payload", () => {
    const input = '{"tool":{"clientSecret":"deeply-nested-camel-4242"},"ok":true}';
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("deeply-nested-camel-4242");
    // The structure around the secret is preserved.
    expect(result.text).toContain('"ok":true');
  });

  it("does not redact ordinary camelCase words that merely contain a sensitive fragment", () => {
    // `secretary`/`Secretary` contain `secret`, `monkey` contains `key`, and
    // `tokenCount`/`passwordReset` are ordinary keys. Over-redacting them would
    // destroy legitimate content.
    for (const input of [
      '{"author":"Ada Lovelace"}',
      '{"secretary":"Jane Roe"}',
      '{"mySecretary":"Jane Roe"}',
      '{"Secretary":"Jane Roe"}',
      '{"monkey":"banana"}',
      '{"turnstile":"x"}',
      '{"tokenCount":5}',
      '{"passwordReset":true}',
      '{"credentialType":"x"}',
      '{"secretSanta":"x"}',
      '{"passwordHash":"x"}',
    ]) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(false);
      expect(result.text, input).toBe(input);
    }
  });

  it("is idempotent across camelCase, quoted and labelled secrets together", () => {
    const input =
      '{"accessToken":"opaque-access-value-1234"} clientSecret=opaque-client-value-5678 accessToken: opaque-unquoted-value-9012';
    const once = redactText(input);
    const twice = redactText(once.text);
    const thrice = redactText(twice.text);
    expect(twice.text).toBe(once.text);
    expect(thrice.text).toBe(once.text);
    expect(once.text).not.toContain("opaque-access-value-1234");
    expect(once.text).not.toContain("opaque-client-value-5678");
    expect(once.text).not.toContain("opaque-unquoted-value-9012");
    expect(once.text.match(/\[redacted\]/g)?.length).toBe(3);
  });
});

describe("truncateText", () => {
  it("returns short text unchanged", () => {
    expect(truncateText("hello", 10)).toEqual({ text: "hello", truncated: false });
  });

  it("truncates and reports how much was omitted", () => {
    const result = truncateText("abcdefghij", 4);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("abcd")).toBe(true);
    expect(result.text).toContain("6 characters omitted");
  });

  it("treats a zero cap as full truncation", () => {
    const result = truncateText("abc", 0);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("");
  });
});

describe("sanitiseForDisplay", () => {
  it("redacts then truncates, reporting both", () => {
    // The redacted form of this payload is longer than the cap, so both
    // transformations apply to the same value.
    const input = `Authorization: Bearer ${"x".repeat(80)}`;
    const result = sanitiseForDisplay(input, 12);
    expect(result.redacted).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(input.length);
    expect(result.text).not.toContain("x".repeat(80));
  });

  it("reports truncation alone when nothing needed redaction", () => {
    const result = sanitiseForDisplay("plain prose that is longer than the cap", 10);
    expect(result.redacted).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it("maps empty and nullish input to an empty result", () => {
    expect(sanitiseForDisplay(null, 10)).toEqual({ text: "", truncated: false, redacted: false });
    expect(sanitiseForDisplay("", 10)).toEqual({ text: "", truncated: false, redacted: false });
    expect(sanitiseForDisplay(undefined, 10)).toEqual({ text: "", truncated: false, redacted: false });
  });
});

describe("summariseLine", () => {
  it("collapses whitespace into a single line", () => {
    const result = summariseLine("first\n\nsecond   third", 200);
    expect(result.text).toBe("first second third");
  });

  it("still redacts a secret in a summary", () => {
    const result = summariseLine("export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuv", 200);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("ghp_abcdefghijklmnopqrstuv");
  });
});

describe("redactPersistedField", () => {
  it("preserves the absent distinction", () => {
    expect(redactPersistedField(null)).toBeNull();
    expect(redactPersistedField(undefined)).toBeNull();
    expect(redactPersistedField("")).toBe("");
  });

  it("redacts a credential pasted into a title or description", () => {
    // A title is display text and is just as capable of carrying a pasted
    // credential as a shell command is.
    expect(redactPersistedField("Fix the lease (token ghp_abcdefghijklmnopqrstuv)")).not.toContain("ghp_abcdefghijklmnopqrstuv");
    expect(redactPersistedField('{"api_key":"desc-secret-value-xyz"}')).not.toContain("desc-secret-value-xyz");
  });

  it("leaves ordinary display text untouched", () => {
    expect(redactPersistedField("Implement lease fencing")).toBe("Implement lease fencing");
  });

  it("is idempotent", () => {
    const once = redactPersistedField("api_key=abcdefghijklmnop");
    expect(redactPersistedField(once)).toBe(once);
  });
});

describe("redactStructuredLeaves", () => {
  it("redacts string leaves and keeps the structure parseable", () => {
    const input = { rule: "assistant-message-agent-field", toolCallIds: ["ghp_abcdefghijklmnopqrstuv"], count: 1, nested: { note: null } };
    const output = redactStructuredLeaves(input);
    expect(JSON.parse(JSON.stringify(output))).toEqual(output);
    expect(JSON.stringify(output)).not.toContain("ghp_abcdefghijklmnopqrstuv");
    expect(output.rule).toBe("assistant-message-agent-field");
    expect(output.count).toBe(1);
    expect(output.nested.note).toBeNull();
  });

  it("handles arrays and primitives", () => {
    expect(redactStructuredLeaves(["plain", "sk-live-aaaaaaaaaaaaaaaa"])).toEqual(["plain", "[redacted]"]);
    expect(redactStructuredLeaves(7)).toBe(7);
    expect(redactStructuredLeaves(null)).toBeNull();
  });

  it("redacts an opaque value whose key names a credential", () => {
    // Regression: value-only redaction missed this entirely. An opaque token has
    // nothing credential-shaped for the text rules to find, so the *key* is the
    // only evidence that it is a secret.
    const input = {
      rule: "assistant-message-agent-field",
      assistantMessageId: "msg_1",
      accessToken: "opaque-access-token-1234567890",
      refreshToken: "opaque-refresh-token-0987654321",
      clientSecret: "opaque-client-secret-abcdefgh",
      clientSecretKey: "opaque-csk-abcdefgh",
    };
    const output = redactStructuredLeaves(input) as Record<string, unknown>;
    const serialised = JSON.stringify(output);
    expect(serialised).not.toContain("opaque-access-token-1234567890");
    expect(serialised).not.toContain("opaque-refresh-token-0987654321");
    expect(serialised).not.toContain("opaque-client-secret-abcdefgh");
    expect(serialised).not.toContain("opaque-csk-abcdefgh");
    // The non-secret fields survive, so the evidence is still readable.
    expect(output.rule).toBe("assistant-message-agent-field");
    expect(output.assistantMessageId).toBe("msg_1");
  });

  it("redacts a nested secret key and preserves an absent value's absence", () => {
    const input = { outer: { clientSecret: "opaque-abcdefghijklmnop" }, token: null };
    const output = redactStructuredLeaves(input) as { outer: { clientSecret: string }; token: null };
    expect(output.outer.clientSecret).toBe("[redacted]");
    expect(output.token).toBeNull();
  });

  it("replaces a whole object or array value under a compound credential key", () => {
    const input = {
      rule: "assistant-message-agent-field",
      aws: { secretAccessKey: { value: "opaque-aws-secret-000111222333", nested: { deep: true } } },
      SecretKey: [1, 2, 3],
    };
    const output = redactStructuredLeaves(input) as Record<string, unknown>;
    expect(output.aws).toEqual({ secretAccessKey: "[redacted]" });
    expect(output.SecretKey).toBe("[redacted]");
    expect(JSON.stringify(output)).not.toContain("opaque-aws-secret-000111222333");
  });

  it("leaves an ordinary key whose value is not credential-shaped untouched", () => {
    const input = { author: "Ada Lovelace", toolCallIds: ["tool_1"], turnstile: "x" };
    const output = redactStructuredLeaves(input) as Record<string, unknown>;
    expect(output.author).toBe("Ada Lovelace");
    expect(output.turnstile).toBe("x");
  });

  it("is idempotent over a key-named secret", () => {
    const once = redactStructuredLeaves({ accessToken: "opaque-access-token-1234567890" });
    const twice = redactStructuredLeaves(once);
    expect(twice).toEqual(once);
    expect(JSON.stringify(once)).toContain("[redacted]");
  });
});

describe("isSecretKey", () => {
  it("recognises separator-delimited and camelCase credential keys", () => {
    for (const key of [
      "api_key",
      "apiKey",
      "access_token",
      "accessToken",
      "refreshToken",
      "client_secret",
      "clientSecret",
      "db_password",
      "userPassword",
      "privateKey",
      "authorization",
      "idToken",
      "myApiKey",
      "secretAccessKey",
      "SecretKey",
      "SecretAccessKey",
      "awsSecretAccessKey",
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it("does not treat an ordinary property name as a credential key", () => {
    for (const key of ["author", "secretary", "Secretary", "mySecretary", "monkey", "turnstile", "tokenCount", "passwordReset", "credentialType", "secretSanta", "passwordHash", "rule", "agentField", "assistantMessageId", "toolCallIds"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

/**
 * Follow-up security review: a compound credential key (`secretAccessKey`,
 * `SecretKey`) and a whole object/array value under a credential key both used
 * to escape redaction, the latter because the value rules only understood
 * scalars.
 */
describe("redactText — compound keys and structured values", () => {
  const AWS_SECRET = "opaque-aws-secret-000111222333";

  it("redacts a compound credential key in raw, quoted and labelled forms", () => {
    const secrets: Array<[string, string]> = [
      [`{"secretAccessKey":"${AWS_SECRET}"}`, AWS_SECRET],
      [`{"SecretAccessKey":"${AWS_SECRET}"}`, AWS_SECRET],
      [`{"SecretKey":"opaque-secret-key-000111222333"}`, "opaque-secret-key-000111222333"],
      [`{"awsSecretAccessKey":"${AWS_SECRET}"}`, AWS_SECRET],
      [`secretAccessKey: ${AWS_SECRET}`, AWS_SECRET],
      [`SecretKey=opaque-secret-key-000111222333`, "opaque-secret-key-000111222333"],
    ];
    for (const [input, secret] of secrets) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).toContain("[redacted]");
      expect(result.text, input).not.toContain(secret);
    }
  });

  it("redacts a compound key nested inside escaped/double-encoded JSON", () => {
    // A tool input is JSON-stringified, so its keys appear escaped once more.
    const input = `{"args":["--profile","{\\"SecretAccessKey\\":\\"${AWS_SECRET}\\"}"]}`;
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(AWS_SECRET);
  });

  it("replaces a whole object or array value under a credential key, keeping the JSON parseable", () => {
    const cases: Array<[string, string | null]> = [
      [`{"api_key":{"a":"plain-value"}}`, "plain-value"],
      [`{"accessToken":{"nested":{"deep":"plain-value"}}}`, "plain-value"],
      [`{"secretAccessKey":{"value":"${AWS_SECRET}"}}`, AWS_SECRET],
      ['{"SecretKey":[1,2,3]}', null],
    ];
    for (const [input, secret] of cases) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      // The whole value was replaced, and the result still parses as JSON —
      // replacing only the opening brace used to corrupt the payload.
      const parsed = JSON.parse(result.text) as Record<string, unknown>;
      expect(Object.values(parsed), input).toContain("[redacted]");
      if (secret !== null) expect(result.text, input).not.toContain(secret);
    }
  });

  it("redacts an object value embedded in surrounding text and leaves an ordinary one alone", () => {
    const input = 'input: {"accessToken":{"a":1}} output: {"author":{"a":1}}';
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).toContain('"accessToken":"[redacted]"');
    expect(result.text).toContain('"author":{"a":1}');
  });

  it("replaces a whole object value after an unquoted credential key", () => {
    const result = redactText('api_key: {"a":1}');
    expect(result.redacted).toBe(true);
    expect(result.text).toBe("api_key: [redacted]");
  });

  it("is idempotent over a structured value", () => {
    const input = '{"accessToken":{"nested":{"deep":"plain-value"}}}';
    const once = redactText(input);
    const twice = redactText(once.text);
    const thrice = redactText(twice.text);
    expect(twice.text).toBe(once.text);
    expect(thrice.text).toBe(once.text);
    expect(once.text.match(/\[redacted\]/g)?.length).toBe(1);
  });

  it("does not corrupt or redact a malformed brace sequence", () => {
    const input = "the set { a, b is not JSON";
    const result = redactText(input);
    expect(result.redacted).toBe(false);
    expect(result.text).toBe(input);
  });

  it("redacts a structured value longer than a small scan window", () => {
    // The whole (large) value is parsed and replaced, not just its opening brace.
    const big = { accessToken: { a: "plain-value", padding: "y".repeat(9000) } };
    const input = `config: ${JSON.stringify(big)}`;
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("plain-value");
    expect(result.text).toContain('{"accessToken":"[redacted]"}');
  });

  it("fails closed on a pathological brace sequence instead of scanning quadratically", () => {
    // No balanced value exists, so the scanner drains its work budget and stops.
    // It then fails closed: the uninspected remainder is replaced rather than
    // kept, because a structure it never reached could hold a credential. The
    // work stays bounded either way — the point of the cap is that a pathological
    // input cannot make the pass quadratic.
    const input = "{".repeat(20_000);
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("{" + "{");
    expect(result.text).toBe("[redacted:uninspected]");
  });
});

describe("redactSerializedValue", () => {
  it("redacts a whole JSON value key-aware", () => {
    const output = redactSerializedValue('{"aws":{"SecretAccessKey":{"value":"plain-value"}}}');
    expect(output).not.toContain("plain-value");
    expect(JSON.parse(output)).toEqual({ aws: { SecretAccessKey: "[redacted]" } });
  });

  it("redacts a nested encoded JSON payload", () => {
    const output = redactSerializedValue('{"args":["--config","{\\"accessToken\\":{\\"a\\":1}}"]}');
    expect(output).not.toContain('{"a":1}');
    expect(JSON.parse(output)).toEqual({ args: ["--config", '{"accessToken":"[redacted]"}'] });
  });

  it("falls back to text redaction when the value is not JSON", () => {
    expect(redactSerializedValue("token ghp_abcdefghijklmnopqrstuv")).not.toContain("ghp_abcdefghijklmnopqrstuv");
    expect(redactSerializedValue('{"api_key": ')).toBe('{"api_key": ');
  });

  it("leaves an ordinary JSON value unchanged", () => {
    expect(redactSerializedValue('{"ok":true,"n":3}')).toBe('{"ok":true,"n":3}');
  });
});

describe("mixed structured and scalar content", () => {
  /** The balanced JSON value starting at the first `{`, parsed. */
  function parseFragment(text: string): unknown {
    const start = text.indexOf("{");
    expect(start, `no JSON fragment in ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return JSON.parse(text.slice(start, i + 1));
      }
    }
    throw new Error(`unbalanced JSON fragment in ${JSON.stringify(text)}`);
  }

  it("redacts a whole object under a credential key without corrupting the JSON", () => {
    // Regression: the scalar rules ran first and rewrote `"password":"pw"` into
    // `"password":[redacted]` — a bare placeholder where a JSON string belonged.
    // That made the payload unparseable, so the structured pass could not see the
    // sibling `accessToken` object and its value survived.
    const input = 'config {"accessToken":{"value":"opaque-live-value","password":"pw"}}';
    const result = redactText(input);

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("opaque-live-value");
    expect(result.text).not.toContain("pw");
    // The fragment is still valid JSON, and the credential key owns its value.
    expect(parseFragment(result.text)).toEqual({ accessToken: "[redacted]" });
  });

  it("redacts every credential key in a mixed payload, not just the first", () => {
    const input = 'config {"api_key":{"a":"first-secret"},"token":{"b":"second-secret"}}';
    const result = redactText(input);

    expect(result.text).not.toContain("first-secret");
    expect(result.text).not.toContain("second-secret");
    expect(parseFragment(result.text)).toEqual({ api_key: "[redacted]", token: "[redacted]" });
  });

  it("redacts an array value and a scalar secret under sibling keys", () => {
    const input = 'config {"secret_access_key":["array-secret-1","array-secret-2"],"password":"scalar-secret"}';
    const result = redactText(input);

    expect(result.text).not.toContain("array-secret-1");
    expect(result.text).not.toContain("scalar-secret");
    expect(parseFragment(result.text)).toEqual({
      secret_access_key: "[redacted]",
      password: "[redacted]",
    });
  });

  it("preserves ordinary siblings around a structured credential", () => {
    const input = '{"credentials":{"SecretAccessKey":{"value":"aws-secret"}},"region":"us-east-1"}';
    const result = redactText(input);

    expect(result.text).not.toContain("aws-secret");
    expect(parseFragment(result.text)).toEqual({
      credentials: { SecretAccessKey: "[redacted]" },
      region: "us-east-1",
    });
  });

  it("redacts a nested encoded payload inside a mixed payload", () => {
    const input = `{"args":["--config","{\\"accessToken\\":{\\"value\\":\\"deep-secret\\"}}"],"api_key":"outer-secret"}`;
    const result = redactText(input);

    expect(result.text).not.toContain("deep-secret");
    expect(result.text).not.toContain("outer-secret");
    expect(parseFragment(result.text)).toEqual({
      args: ["--config", '{"accessToken":"[redacted]"}'],
      api_key: "[redacted]",
    });
  });

  it("redacts a scalar secret outside a fragment and a structured secret inside it", () => {
    const input = 'clientSecret=outside-scalar-secret {"accessToken":{"value":"inside-object-secret"}}';
    const result = redactText(input);

    expect(result.text).not.toContain("outside-scalar-secret");
    expect(result.text).not.toContain("inside-object-secret");
    expect(result.text).toContain("clientSecret=[redacted]");
    expect(parseFragment(result.text)).toEqual({ accessToken: "[redacted]" });
  });

  it("is idempotent on a mixed payload across repeated passes", () => {
    const input =
      'config {"accessToken":{"value":"opaque-live-value","password":"pw"}} api_key=sk-live-aaaaaaaaaaaaaaaa';
    const once = redactText(input);
    const twice = redactText(once.text);
    const thrice = redactText(twice.text);

    expect(twice.text).toBe(once.text);
    expect(thrice.text).toBe(once.text);
    expect(once.text).not.toContain("opaque-live-value");
    expect(once.text).not.toContain("sk-live-aaaaaaaaaaaaaaaa");
    // Two secrets, two placeholders, and no doubled bracket from a re-scan.
    expect(once.text.match(/\[redacted\]/g)?.length).toBe(2);
    expect(parseFragment(once.text)).toEqual({ accessToken: "[redacted]" });
  });

  it("never leaves a bare placeholder inside a JSON value", () => {
    // A bare `[redacted]` is the exact corruption the ordering fix prevents: it
    // is not a JSON value, so it makes the fragment unparseable.
    for (const input of [
      'config {"accessToken":{"value":"opaque-live-value","password":"pw"}}',
      '{"a":{"api_key":{"x":"s1"}},"b":{"token":{"y":"s2"}}}',
      '{"clientSecret":{"deep":{"deeper":"s3"}},"ok":true}',
    ]) {
      const result = redactText(input);
      expect(() => parseFragment(result.text), input).not.toThrow();
      // No unquoted placeholder where a JSON value belongs.
      expect(result.text, input).not.toMatch(/:\s*\[redacted\]/);
    }
  });

  it("redacts a mixed payload through redactSerializedValue too", () => {
    const output = redactSerializedValue(
      JSON.stringify({ config: "x", accessToken: { value: "opaque-live-value", password: "pw" } }),
    );
    expect(output).not.toContain("opaque-live-value");
    expect(JSON.parse(output)).toEqual({ config: "x", accessToken: "[redacted]" });
  });

  it("repairs a payload an earlier build left with a bare placeholder", () => {
    // A previous build's scalar rules wrote `"password":[redacted]` — a bare
    // placeholder — which made the payload unparseable, so the sibling
    // `accessToken` value was never removed and is still stored.
    const input = 'config {"accessToken":{"value":"opaque-live-value","password":[redacted]}}';
    const result = redactText(input);

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("opaque-live-value");
    // The fragment is valid JSON again, with the surviving credential removed.
    expect(parseFragment(result.text)).toEqual({ accessToken: "[redacted]" });
  });

  it("does not grow the escaping of a value that is only a placeholder", () => {
    // Guard against the repair pass re-quoting its own output: a fragment that
    // *is* the marker has nothing inside it to redact, so it must be left alone
    // rather than wrapped into `"[redacted]"`, then `"\"[redacted]\""`, and so on.
    const input = '{"a":"[redacted]","accessToken":{"value":"opaque-live-value"}}';
    const result = redactText(input);

    expect(result.text).not.toContain("opaque-live-value");
    expect(result.text).not.toContain("\\");
    expect(parseFragment(result.text)).toEqual({ a: "[redacted]", accessToken: "[redacted]" });

    const twice = redactText(result.text);
    expect(twice.text).toBe(result.text);
  });
});

describe("a credential assignment owns its whole value", () => {
  /** The balanced JSON value starting at the first `{` or `[`, parsed. */
  function parseFirstFragment(text: string): unknown {
    const start = text.search(/[\[{]/);
    expect(start, `no JSON fragment in ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) return JSON.parse(text.slice(start, i + 1));
      }
    }
    throw new Error(`unbalanced fragment in ${JSON.stringify(text)}`);
  }

  it("redacts a quoted value that merely looks like JSON", () => {
    // Regression: the `[` inside the quoted value was treated as a JSON fragment,
    // which split the assignment — the opening quote landed in the gap and the
    // closing quote in the tail, so no rule could see the complete value.
    const result = redactText('password="correct[42]horse"');
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("correct[42]horse");
    expect(result.text).toBe("password=[redacted]");
  });

  it("redacts a single-quoted value whose content is a JSON object", () => {
    const result = redactText(`clientSecret='{"value":"opaque-live-value"}'`);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("opaque-live-value");
    expect(result.text).toBe("clientSecret=[redacted]");
  });

  it("redacts a quoted value containing escaped quotes", () => {
    const input = `password="{\\"nested\\":\\"opaque-escaped-secret\\"}"`;
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("opaque-escaped-secret");
    expect(result.text).toBe("password=[redacted]");
  });

  it("redacts an assignment embedded in prose and keeps the prose", () => {
    const result = redactText('login password="p@ss[1]word" ok');
    expect(result.text).toBe("login password=[redacted] ok");
  });

  it("redacts an assignment that follows a benign JSON value", () => {
    const result = redactText('{"ok":true} password="correct[42]horse"');
    expect(result.text).not.toContain("correct[42]horse");
    expect(result.text).toContain('{"ok":true}');
  });

  it("redacts a quoted camelCase assignment and an unquoted one", () => {
    for (const [input, secret] of [
      ['accessToken="opaque-quoted-camel"', "opaque-quoted-camel"],
      ["refreshToken='opaque-single-camel'", "opaque-single-camel"],
    ] as const) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).not.toContain(secret);
    }
  });

  it("redacts a bare value that is itself structural", () => {
    const result = redactText("password=correct[42]horse");
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("correct[42]horse");
    expect(result.text).toBe("password=[redacted]");
  });

  it("still redacts an Authorization header's whole token", () => {
    // The assignment check must not consume only the scheme and strand the token.
    const result = redactText("Authorization: Bearer abcdefghijklmnopqrstuvwx");
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwx");
  });

  it("leaves unrelated benign JSON intact", () => {
    for (const input of [
      '{"ok":true,"n":3}',
      'config {"region":"us-east-1","retries":[1,2,3]}',
      'ratio: [1,2]',
      'note: "a[1]b"',
      '{"counts":{"a":1},"names":["x","y"]}',
    ]) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(false);
      expect(result.text, input).toBe(input);
    }
  });

  it("still redacts a credential inside a benign-looking structure", () => {
    const input = '{"region":"us-east-1","accessToken":{"value":"opaque-live-value"}}';
    const result = redactText(input);
    expect(result.text).not.toContain("opaque-live-value");
    expect(parseFirstFragment(result.text)).toEqual({ region: "us-east-1", accessToken: "[redacted]" });
  });

  it("is idempotent for a quoted JSON-looking value across repeated passes", () => {
    const input = 'config password="correct[42]horse" clientSecret=\'{"value":"opaque-live-value"}\'';
    const once = redactText(input);
    const twice = redactText(once.text);
    const thrice = redactText(twice.text);

    expect(once.redacted).toBe(true);
    expect(twice.text).toBe(once.text);
    expect(thrice.text).toBe(once.text);
    expect(once.text).not.toContain("correct[42]horse");
    expect(once.text).not.toContain("opaque-live-value");
    expect(once.text.match(/\[redacted\]/g)?.length).toBe(2);
  });

  it("carries the redaction through sanitiseForDisplay", () => {
    const display = sanitiseForDisplay('password="correct[42]horse"', 500);
    expect(display.redacted).toBe(true);
    expect(display.text).not.toContain("correct[42]horse");
  });

  it("carries the redaction through redactSerializedValue", () => {
    const output = redactSerializedValue(JSON.stringify({ note: 'password="correct[42]horse"' }));
    expect(output).not.toContain("correct[42]horse");
    expect(JSON.parse(output)).toEqual({ note: "password=[redacted]" });

    const nested = redactSerializedValue(JSON.stringify({ log: `clientSecret='{"value":"opaque-live-value"}'` }));
    expect(nested).not.toContain("opaque-live-value");
  });
});

describe("the structural scan fails closed at its limits", () => {
  const SECRET = "opaque-live-value-000111222333";
  const CREDENTIAL = `{"accessToken":{"value":"${SECRET}"}}`;

  it("redacts a credential just below the fragment-attempt limit", () => {
    // 511 harmless fragments, then the credential as the 512th: still inspected,
    // so it is removed by the key-aware pass and no bounded-scan marker appears.
    const input = '{"a":1}'.repeat(511) + CREDENTIAL;
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(SECRET);
    expect(result.text).not.toContain("[redacted:uninspected]");
    expect(result.text).toContain('{"accessToken":"[redacted]"}');
  });

  it("fails closed at exactly 512 harmless fragments followed by a credential", () => {
    // The credential is the 513th fragment, past the attempt cap. The scanner
    // must not leave it in place: the uninspected remainder is replaced.
    const input = '{"a":1}'.repeat(512) + CREDENTIAL;
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(SECRET);
    expect(result.text).toContain("[redacted:uninspected]");
    // The inspected prefix is preserved; only the uninspected remainder is dropped.
    expect(result.text).toContain('{"a":1}');
    expect(result.text.endsWith("[redacted:uninspected]")).toBe(true);
  });

  it("fails closed when the work budget is exhausted before a credential", () => {
    // Unbalanced braces drain the work budget (each one scans to the limit and
    // charges its cost). The credential beyond that point is never inspected, so
    // it must be replaced rather than kept.
    const input = "{".repeat(30_000) + CREDENTIAL;
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(SECRET);
    expect(result.text).toContain("[redacted:uninspected]");
  });

  it("keeps the output bounded for a large pathological input", () => {
    const input = "{".repeat(200_000);
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    // The replacement is bounded regardless of how large the input was.
    expect(result.text.length).toBeLessThan(64);
  });

  it("still redacts a scalar secret before the cap and marks the rest", () => {
    const input = "api_key=sk-live-aaaaaaaaaaaaaaaa " + '{"a":1}'.repeat(512) + CREDENTIAL;
    const result = redactText(input);
    expect(result.text).not.toContain("sk-live-aaaaaaaaaaaaaaaa");
    expect(result.text).not.toContain(SECRET);
  });

  it("does not emit the uninspected marker for ordinary input", () => {
    for (const input of ['{"ok":true}', "password=abc", "a small log line", ""]) {
      expect(redactText(input).text, input).not.toContain("[redacted:uninspected]");
    }
  });

  it("leaves the uninspected marker itself unchanged on a second pass", () => {
    // The marker must be idempotent like the ordinary placeholder, or a repair
    // pass would keep rewriting its own output.
    const marker = "[redacted:uninspected]";
    const once = redactText(marker);
    expect(once.text).toBe(marker);
    expect(redactText(once.text).text).toBe(marker);
  });

  it("recognises both markers as redaction evidence", () => {
    expect(containsRedactionPlaceholder("a [redacted] b")).toBe(true);
    expect(containsRedactionPlaceholder("a [redacted:uninspected] b")).toBe(true);
    expect(containsRedactionPlaceholder("plain text")).toBe(false);
  });
});

describe("a recognised assignment is delimited within budget, or fails closed", () => {
  const LIVE = "opaque-live-value-000111222333";

  it("fails closed when the value's container cannot be delimited in budget", () => {
    // Reproduction: eight unbalanced braces drain most of the budget, so the
    // `{"value":…}` container can only be partially scanned. The matcher used to
    // discard that exhaustion, fall back to consuming just the `{`, and leave
    // `"value":"…"` in the text — where no key remained to identify it. The
    // credential leaked.
    const input = "{".repeat(8) + ' password={"value":"' + LIVE + '"}' + "x".repeat(13000);
    const result = redactText(input);

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(LIVE);
    // No partial-token fallback: the remainder is replaced wholesale.
    expect(result.text).toBe("[redacted:uninspected]");
    expect(result.text).not.toContain("value");
  });

  it("still redacts the same value normally when the budget is not strained", () => {
    const input = 'password={"value":"' + LIVE + '"}';
    const result = redactText(input);
    expect(result.text).toBe("password=[redacted]");
    expect(result.text).not.toContain("uninspected");
  });

  it("redacts a value that merely looks like a container even when it never closes", () => {
    // An unterminated container cannot be delimited, so it must fail closed rather
    // than be guessed at.
    const input = 'password={"value":"' + LIVE + '"';
    const result = redactText(input);
    expect(result.text).not.toContain(LIVE);
  });

  it("redacts an unterminated quoted value rather than splitting it", () => {
    const input = `password="correct[42]horse`;
    const result = redactText(input);
    expect(result.text).not.toContain("correct[42]horse");
  });

  it("is idempotent on a fail-closed result", () => {
    const input = "{".repeat(8) + ' password={"value":"' + LIVE + '"}' + "x".repeat(13000);
    const once = redactText(input);
    expect(redactText(once.text).text).toBe(once.text);
  });
});

describe("environment-style assignment keys are recognised", () => {
  const LIVE = "opaque-live-value-000111222333";

  it("redacts a quoted value under an env-style key", () => {
    // Regression: the assignment scanner classified labels with `isSecretKey`,
    // whose key list has `api_key`/`apikey` but not a bare `key`. `OPENAI_KEY` was
    // therefore not recognised, the value was never consumed as a unit, and the
    // `[` inside it split the assignment.
    for (const [input, secret] of [
      ['OPENAI_KEY="correct[42]horse"', "correct[42]horse"],
      [`OPENAI_KEY='{"value":"${LIVE}"}'`, LIVE],
      ["OPENAI_API_KEY=\"correct[42]horse\"", "correct[42]horse"],
      ["MY_SECRET=\"correct[42]horse\"", "correct[42]horse"],
      ["DB_PASSWORD=\"correct[42]horse\"", "correct[42]horse"],
      ["GITHUB_TOKEN='{\"value\":\"x\"}'", '{"value":"x"}'],
      ["OPENAI_KEY=correct[42]horse", "correct[42]horse"],
    ] as const) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).not.toContain(secret);
      expect(result.text, input).toContain("[redacted]");
    }
  });

  it("classifies the same labels the env-style scalar rule does", () => {
    // The scanner and the rule must agree, or one recognises a label the other
    // does not — which is exactly how `OPENAI_KEY` was missed.
    for (const key of ["OPENAI_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "MY_SECRET", "DB_PASSWORD", "A_CREDENTIAL"]) {
      expect(isSensitiveLabel(key), key).toBe(true);
    }
    for (const key of ["OPENAI_MODEL", "LOG_LEVEL", "RETRY_COUNT", "region", "config", "model"]) {
      expect(isSensitiveLabel(key), key).toBe(false);
    }
  });

  it("leaves benign env-style assignments untouched", () => {
    for (const input of ['OPENAI_MODEL="gpt-4"', 'LOG_LEVEL="debug"', 'RETRY_COUNT="3"']) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(false);
      expect(result.text, input).toBe(input);
    }
  });

  it("is idempotent for an env-style assignment", () => {
    const input = 'OPENAI_KEY="correct[42]horse" GITHUB_TOKEN=\'{"value":"x"}\'';
    const once = redactText(input);
    const twice = redactText(once.text);
    expect(twice.text).toBe(once.text);
    expect(once.text.match(/\[redacted\]/g)?.length).toBe(2);
  });
});

describe("whitespace-heavy input stays bounded", () => {
  const LIVE = "opaque-live-value-000111222333";
  /** Generous: the unbounded backwards scan took ~60s for this input. */
  const TIME_BUDGET_MS = 5_000;

  it("redacts an assignment after 200,000 spaces without scanning them repeatedly", () => {
    const input = " ".repeat(200_000) + `password="${LIVE}"`;
    const started = Date.now();
    const result = redactText(input);
    const elapsed = Date.now() - started;

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(LIVE);
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
  });

  it("leaves 200,000 spaces alone within the same bound", () => {
    const input = " ".repeat(200_000);
    const started = Date.now();
    const result = redactText(input);
    const elapsed = Date.now() - started;

    expect(result.redacted).toBe(false);
    expect(result.text).toBe(input);
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
  });

  it("resolves a key across a long whitespace gap in bounded time", () => {
    // The separator is far from the key; a backwards scan would walk the gap once
    // per space. The ring resolves it without ever walking the gap again.
    const input = "password" + " ".repeat(50_000) + `="${LIVE}"`;
    const started = Date.now();
    const result = redactText(input);
    const elapsed = Date.now() - started;

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(LIVE);
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
  });

  it("stays bounded on a long run of separators", () => {
    const input = ":".repeat(200_000) + ` password="${LIVE}"`;
    const started = Date.now();
    const result = redactText(input);
    const elapsed = Date.now() - started;

    expect(result.text).not.toContain(LIVE);
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
  });
});

describe("structured JSON properties use the same label classifier as assignments", () => {
  const OPAQUE = "opaque-secret-value-000111222333";

  it("masks an opaque value under an env-style JSON property", () => {
    // Regression: `redactStructuredLeaves` classified property names with the
    // narrower `isSecretKey`, which has no bare `key`. `{"OPENAI_KEY":"…"}` was
    // therefore left intact even though `OPENAI_KEY=…` was masked — the same label
    // recognised by one path and not the other.
    expect(redactStructuredLeaves({ OPENAI_KEY: OPAQUE })).toEqual({ OPENAI_KEY: "[redacted]" });
    expect(JSON.stringify(redactStructuredLeaves({ OPENAI_KEY: OPAQUE }))).not.toContain(OPAQUE);
  });

  it("masks an env-style property nested in objects and arrays", () => {
    expect(redactStructuredLeaves({ a: { b: { OPENAI_KEY: OPAQUE } } })).toEqual({
      a: { b: { OPENAI_KEY: "[redacted]" } },
    });
    expect(redactStructuredLeaves([{ OPENAI_KEY: OPAQUE }, { ok: 1 }])).toEqual([
      { OPENAI_KEY: "[redacted]" },
      { ok: 1 },
    ]);
    expect(redactStructuredLeaves({ list: [{ deep: { GITHUB_TOKEN: OPAQUE } }] })).toEqual({
      list: [{ deep: { GITHUB_TOKEN: "[redacted]" } }],
    });
  });

  it("masks a whole object or array value under an env-style property", () => {
    expect(redactStructuredLeaves({ OPENAI_KEY: { nested: { deeper: OPAQUE } } })).toEqual({
      OPENAI_KEY: "[redacted]",
    });
    expect(redactStructuredLeaves({ OPENAI_KEY: [OPAQUE, OPAQUE] })).toEqual({ OPENAI_KEY: "[redacted]" });
  });

  it("keeps ordinary siblings of an env-style property", () => {
    expect(redactStructuredLeaves({ OPENAI_KEY: OPAQUE, region: "us-east-1", retries: [1, 2, 3] })).toEqual({
      OPENAI_KEY: "[redacted]",
      region: "us-east-1",
      retries: [1, 2, 3],
    });
  });

  it("keeps an absent value absent", () => {
    expect(redactStructuredLeaves({ OPENAI_KEY: null })).toEqual({ OPENAI_KEY: null });
  });

  it("leaves names the classifier rejects untouched", () => {
    // The classifier is unchanged; these are the names it does not treat as
    // credentials, so they must keep their values.
    const input = {
      OPENAI_MODEL: "gpt-4",
      LOG_LEVEL: "debug",
      RETRY_COUNT: 3,
      secretary: "Jane Roe",
      author: "Ada Lovelace",
      monkey: "banana",
      tokenCount: 5,
      passwordReset: true,
      credentialType: "bearer",
    };
    expect(redactStructuredLeaves(input)).toEqual(input);
  });

  it("treats TOKEN_COUNT, MAX_TOKENS and MODEL_KEY_ID as the classifier does", () => {
    // Verified, not assumed: `isSensitiveLabel` already accepts all three (they end
    // in a credential word), so they stay sensitive. No exception was added to
    // make them non-sensitive, and none should be — that would be a value
    // exception in the classifier.
    for (const name of ["TOKEN_COUNT", "MAX_TOKENS", "MODEL_KEY_ID"]) {
      expect(isSensitiveLabel(name), name).toBe(true);
      expect(redactStructuredLeaves({ [name]: OPAQUE }), name).toEqual({ [name]: "[redacted]" });
    }
  });

  it("masks the same label in assignment form and in JSON form", () => {
    // Equivalence: the two paths must agree, which is what the shared classifier
    // guarantees.
    for (const label of ["OPENAI_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "accessToken", "clientSecret", "SecretKey"]) {
      const fromJson = JSON.stringify(redactStructuredLeaves({ [label]: OPAQUE }));
      expect(fromJson, label).not.toContain(OPAQUE);
      expect(redactText(`${label}=${OPAQUE}`).text, label).not.toContain(OPAQUE);
    }
  });

  it("is stable across repeated passes over structured JSON", () => {
    const input = { OPENAI_KEY: OPAQUE, nested: { GITHUB_TOKEN: OPAQUE }, region: "us-east-1" };
    const once = redactStructuredLeaves(input);
    const twice = redactStructuredLeaves(once);
    const thrice = redactStructuredLeaves(twice);
    expect(twice).toEqual(once);
    expect(thrice).toEqual(once);

    const serialisedOnce = redactSerializedValue(JSON.stringify(input));
    expect(redactSerializedValue(serialisedOnce)).toBe(serialisedOnce);
    expect(JSON.parse(serialisedOnce)).toEqual({ OPENAI_KEY: "[redacted]", nested: { GITHUB_TOKEN: "[redacted]" }, region: "us-east-1" });
  });
});

describe("escaped (double-encoded) JSON embedded in prose", () => {
  const OPAQUE = "opaque-secret-value-000111222333";

  it("redacts an env-label value in an escaped document", () => {
    // Regression: an escaped document (`\"key\":\"…\"`) is what a serialised tool
    // input looks like. The escaped scalar rules knew only the two narrow key
    // shapes, and the scanner could not parse an escaped object at all, so the
    // credential passed through untouched.
    const result = redactText(`config: {\\"OPENAI_KEY\\":\\"${OPAQUE}\\"}`);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(OPAQUE);
    expect(result.text).toBe('config: {\\"OPENAI_KEY\\":\\"[redacted]\\"}');
  });

  it("consumes a whole escaped container value under a credential key", () => {
    // The value is an escaped object, so the key is the only evidence that the
    // whole value is a credential — and it must be consumed as one unit.
    const result = redactText(`config: {\\"accessToken\\":{\\"value\\":\\"${OPAQUE}\\"}}`);
    expect(result.text).not.toContain(OPAQUE);
    expect(result.text).toBe('config: {\\"accessToken\\":\\"[redacted]\\"}');
  });

  it("consumes an escaped array value under a credential key", () => {
    const result = redactText(`{\\"OPENAI_KEY\\":[\\"a\\",\\"${OPAQUE}\\"]}`);
    expect(result.text).not.toContain(OPAQUE);
    expect(result.text).toBe('{\\"OPENAI_KEY\\":\\"[redacted]\\"}');
  });

  it("redacts a credential nested inside an escaped container", () => {
    const result = redactText(`{\\"outer\\":{\\"OPENAI_KEY\\":\\"${OPAQUE}\\"}}`);
    expect(result.text).not.toContain(OPAQUE);
    expect(result.text).toContain('\\"outer\\"');
  });

  it("keeps ordinary escaped siblings byte for byte", () => {
    const input = `{\\"region\\":\\"us-east-1\\",\\"OPENAI_KEY\\":\\"${OPAQUE}\\",\\"retries\\":[1,2]}`;
    const result = redactText(input);
    expect(result.text).not.toContain(OPAQUE);
    expect(result.text).toBe('{\\"region\\":\\"us-east-1\\",\\"OPENAI_KEY\\":\\"[redacted]\\",\\"retries\\":[1,2]}');
  });

  it("leaves a benign escaped document untouched", () => {
    for (const input of ['note {\\"region\\":\\"us-east-1\\",\\"count\\":5}', '{\\"OPENAI_MODEL\\":\\"gpt-4\\"}', '{\\"ok\\":true}']) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(false);
      expect(result.text, input).toBe(input);
    }
  });

  it("redacts an escaped document through redactSerializedValue", () => {
    const output = redactSerializedValue(JSON.stringify({ log: `config: {\\"OPENAI_KEY\\":\\"${OPAQUE}\\"}` }));
    expect(output).not.toContain(OPAQUE);
    expect(JSON.parse(output) as { log: string }).toEqual({ log: 'config: {\\"OPENAI_KEY\\":\\"[redacted]\\"}' });
  });

  it("is idempotent across repeated passes over an escaped document", () => {
    const input = `{\\"region\\":\\"us-east-1\\",\\"OPENAI_KEY\\":\\"${OPAQUE}\\",\\"nested\\":{\\"GITHUB_TOKEN\\":\\"${OPAQUE}\\"},\\"n\\":1}`;
    const once = redactText(input);
    const twice = redactText(once.text);
    const thrice = redactText(twice.text);
    expect(once.redacted).toBe(true);
    expect(once.text).not.toContain(OPAQUE);
    expect(twice.text).toBe(once.text);
    expect(thrice.text).toBe(once.text);
    // The escaping level is preserved and the sibling keys survive.
    expect(once.text).toContain('\\"region\\":\\"us-east-1\\"');
    expect(once.text).toContain('\\"n\\":1');
  });

  it("keeps an escaped value that is already a placeholder stable", () => {
    const input = '{\\"OPENAI_KEY\\":\\"[redacted]\\",\\"n\\":1}';
    const once = redactText(input);
    expect(once.text).toBe(input);
    expect(redactText(once.text).text).toBe(input);
  });

  it("fails closed when a long run of escaped fragments exhausts the scan", () => {
    const input = '{\\"a\\":1}'.repeat(600) + `{\\"OPENAI_KEY\\":\\"${OPAQUE}\\"}`;
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(OPAQUE);
    expect(result.text).toContain("[redacted:uninspected]");
  });
});

describe("escaped fragments redact ordinary values as well as credential-key values", () => {
  /** The escaped-document text of a value: what a serialised tool input looks like. */
  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  const GHP = "ghp_abcdefghijklmnopqrstuvwx";
  const JWT =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

  it("redacts a provider token in an ordinary sibling of a credential key", () => {
    // Regression: once any sensitive value changed, the whole fragment was emitted
    // and the scalar rules were skipped — so a token pasted into a sibling field
    // survived alongside the credential that had been removed.
    const input = escapedDocument({ OPENAI_KEY: "opaque-key", note: GHP });
    const result = redactText(input);

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(GHP);
    expect(result.text).toContain('\\"OPENAI_KEY\\":\\"[redacted]\\"');
  });

  it("redacts an Authorization header in a nested sibling", () => {
    const input = escapedDocument({ a: { OPENAI_KEY: "k", hdr: `Authorization: Bearer ${JWT}` } });
    const result = redactText(input);
    expect(result.text).not.toContain(JWT);
    expect(result.text).toContain('\\"hdr\\"');
  });

  it("redacts a token in a string array entry", () => {
    const input = escapedDocument({ note: ["plain", `token ${GHP}`] });
    const result = redactText(input);
    expect(result.text).not.toContain(GHP);
    expect(result.text).toContain('\\"plain\\"');
  });

  it("keeps ordinary escaped text unchanged", () => {
    for (const input of [escapedDocument({ region: "us-east-1", count: 5 }), escapedDocument({ ok: true })]) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(false);
      expect(result.text, input).toBe(input);
    }
  });

  it("is idempotent when both a credential and a sibling token are redacted", () => {
    const input = escapedDocument({ OPENAI_KEY: "k", note: GHP, nested: { hdr: `Bearer ${JWT}` }, n: 1 });
    const once = redactText(input);
    const twice = redactText(once.text);
    const thrice = redactText(twice.text);
    expect(once.text).not.toContain(GHP);
    expect(once.text).not.toContain(JWT);
    expect(twice.text).toBe(once.text);
    expect(thrice.text).toBe(once.text);
    expect(once.text).toContain('\\"n\\":1');
  });
});

describe("escaped values are delimited as a whole, or fail closed", () => {
  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  it("consumes a value whose content holds an escaped quote", () => {
    // Regression: `\"` was read as a delimiter unconditionally, so the value
    // `\"first\\\"opaque-suffix\"` ended at the escaped quote and its tail leaked.
    const input = escapedDocument({ password: 'first"opaque-suffix' });
    const result = redactText(input);

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("opaque-suffix");
    expect(result.text).toBe('{\\"password\\":\\"[redacted]\\"}');
  });

  it("consumes an escaped array of primitive numbers", () => {
    const input = escapedDocument({ OPENAI_KEY: [17, 23, 42, 91] });
    const result = redactText(input);
    expect(result.text).not.toContain("17");
    expect(result.text).toBe('{\\"OPENAI_KEY\\":\\"[redacted]\\"}');
  });

  it("consumes escaped arrays of booleans, null, strings and nested arrays", () => {
    for (const value of [[true, false, null], ["a", "b"], [[1, 2], [3]], [{ deep: 1 }]]) {
      const input = escapedDocument({ GITHUB_TOKEN: value });
      const result = redactText(input);
      expect(result.text, JSON.stringify(value)).toBe('{\\"GITHUB_TOKEN\\":\\"[redacted]\\"}');
    }
  });

  it("consumes an escaped number, boolean and null value", () => {
    expect(redactText(escapedDocument({ OPENAI_KEY: 42 })).text).toBe('{\\"OPENAI_KEY\\":\\"[redacted]\\"}');
    expect(redactText(escapedDocument({ OPENAI_KEY: true })).text).toBe('{\\"OPENAI_KEY\\":\\"[redacted]\\"}');
    expect(redactText(escapedDocument({ OPENAI_KEY: null })).text).toBe('{\\"OPENAI_KEY\\":null}');
  });

  it("fails closed when a recognised credential value cannot be delimited", () => {
    // An unterminated escaped string cannot be delimited, so the remainder is
    // replaced rather than a partial value being kept.
    const input = '{\\"password\\":\\"opaque-unterminated';
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("opaque-unterminated");
    expect(result.text).toContain("[redacted:uninspected]");
  });

  it("preserves well-formed escaped formatting around a redacted value", () => {
    const input = '{ \\"OPENAI_KEY\\" : [ 17 , 23 ] , \\"n\\" : 1 }';
    const result = redactText(input);
    expect(result.text).not.toContain("17");
    expect(result.text).toContain('{ \\"OPENAI_KEY\\" : \\"[redacted]\\" , \\"n\\" : 1 }');
  });

  it("is idempotent for escaped containers and escaped-quote values", () => {
    for (const input of [
      escapedDocument({ password: 'first"opaque-suffix' }),
      escapedDocument({ OPENAI_KEY: [17, 23, 42, 91] }),
      escapedDocument({ GITHUB_TOKEN: [[1, 2], [3]] }),
    ]) {
      const once = redactText(input);
      const twice = redactText(once.text);
      expect(twice.text, input).toBe(once.text);
      expect(redactText(twice.text).text, input).toBe(once.text);
    }
  });
});

describe("scalar rules stay linear on adversarial input", () => {
  /** Generous: the unbounded patterns took ~110s for a comparable input. */
  const TIME_BUDGET_MS = 10_000;

  it("bounds the url-userinfo and base64 rules on long runs", () => {
    const shapes = [
      "y".repeat(200_000),
      "A1a".repeat(66_000) + "/",
      "AbAb".repeat(50_000),
      "a".repeat(200_000) + "@",
      "a".repeat(200_000) + ":",
      "Ab3/".repeat(50_000),
    ];
    for (const input of shapes) {
      const started = Date.now();
      const result = redactText(input);
      const elapsed = Date.now() - started;
      expect(elapsed, `len=${input.length}`).toBeLessThan(TIME_BUDGET_MS);
      expect(result.text.length).toBeGreaterThan(0);
    }
  });

  it("still redacts a URL userinfo credential", () => {
    const result = redactText("clone https://alice:hunter2@example.com/repo.git");
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("hunter2");
    expect(result.text).toContain("https://[redacted]@example.com");
  });

  it("still redacts a mixed-case base64 blob and leaves ordinary text alone", () => {
    const blob = "Ab3dEf4gHi5jKl6mNo7pQr8sTu9vWx0yZ".repeat(2);
    const result = redactText(`data: ${blob}`);
    expect(result.text).not.toContain(blob);

    const ordinary = "the quick brown fox jumps over the lazy dog";
    expect(redactText(ordinary).text).toBe(ordinary);
  });
});

describe("nested encoded documents inside an ordinary string value", () => {
  /** The escaped-document text of a value: what a serialised tool input looks like. */
  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  it("recurses into a nested document and redacts its credential array", () => {
    // Regression: an ordinary string value was checked only by the scalar rules,
    // which cannot see the nested `\\\"` delimiters — so the outer credential was
    // removed and the nested one survived.
    const input = escapedDocument({ OPENAI_KEY: "k", note: JSON.stringify({ OPENAI_KEY: [17, 23, 42, 91] }) });
    const result = redactText(input);

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("[17,23,42,91]");
    expect(result.text).toContain('\\"OPENAI_KEY\\":\\"[redacted]\\"');
  });

  it("recurses through more than one nesting level", () => {
    const input = escapedDocument({ note: JSON.stringify({ nested: JSON.stringify({ GITHUB_TOKEN: [1, 2] }) }) });
    const result = redactText(input);
    expect(result.text).not.toContain("[1,2]");
  });

  it("is idempotent across repeated passes over a nested document", () => {
    const input = escapedDocument({ OPENAI_KEY: "k", note: JSON.stringify({ OPENAI_KEY: [17, 23, 42, 91] }) });
    const once = redactText(input);
    const twice = redactText(once.text);
    const thrice = redactText(twice.text);

    expect(once.text).not.toContain("[17,23,42,91]");
    expect(twice.text).toBe(once.text);
    expect(thrice.text).toBe(once.text);
    expect(once.text).not.toContain("[redacted:uninspected]");
  });

  it("still redacts a token in a nested document's ordinary sibling", () => {
    const input = escapedDocument({ note: JSON.stringify({ OPENAI_KEY: "k", hdr: "token ghp_abcdefghijklmnopqrstuvwx" }) });
    const result = redactText(input);
    expect(result.text).not.toContain("ghp_abcdefghijklmnopqrstuvwx");
  });

  it("leaves a benign nested document byte for byte", () => {
    const input = escapedDocument({ note: JSON.stringify({ region: "us-east-1", count: 5 }) });
    expect(redactText(input).text).toBe(input);
    expect(redactText(input).redacted).toBe(false);
  });
});

describe("escaped primitive values validate syntax and boundary", () => {
  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  it("fails closed on a malformed number suffix", () => {
    // Regression: only the numeric prefix was consumed, so the tail was left with
    // no key in front of it.
    const result = redactText('{\\"password\\":123opaque-secret}');
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("opaque-secret");
    expect(result.text).toBe("[redacted:uninspected]");
  });

  it("fails closed on a malformed literal suffix", () => {
    for (const input of ['{\\"password\\":trueopaque-secret}', '{\\"password\\":nullopaque-secret}']) {
      const result = redactText(input);
      expect(result.text, input).not.toContain("opaque-secret");
      expect(result.text, input).toBe("[redacted:uninspected]");
    }
  });

  it("fails closed on a malformed numeric token", () => {
    const result = redactText('{\\"password\\":12x3}');
    expect(result.text).not.toContain("x3");
    expect(result.text).toBe("[redacted:uninspected]");
  });

  it("fails closed on a mismatched container", () => {
    for (const input of ['{\\"password\\":[1,2}', '{\\"password\\":{"a":1]}']) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).toContain("[redacted:uninspected]");
    }
  });

  it("still consumes well-formed primitives", () => {
    for (const [value, expected] of [
      [42, '{\\"OPENAI_KEY\\":\\"[redacted]\\"}'],
      [-1.5e3, '{\\"OPENAI_KEY\\":\\"[redacted]\\"}'],
      [true, '{\\"OPENAI_KEY\\":\\"[redacted]\\"}'],
      [false, '{\\"OPENAI_KEY\\":\\"[redacted]\\"}'],
    ] as const) {
      expect(redactText(escapedDocument({ OPENAI_KEY: value })).text, String(value)).toBe(expected);
    }
    // `null` stays absent, as the structured path preserves it.
    expect(redactText(escapedDocument({ OPENAI_KEY: null })).text).toBe('{\\"OPENAI_KEY\\":null}');
  });
});

describe("a credential label cannot make the classifier exponential", () => {
  /** Generous: the broken pattern takes ~2.6 s at the smallest size checked. */
  const TIME_BUDGET_MS = 1_000;

  it("classifies a near-miss label in bounded time", () => {
    // The behavioural backstop, on the sizes where the broken pattern is slow but
    // still finite (2.6 s at 28) so a regression fails rather than runs away. The
    // fixed classifier is under a millisecond.
    for (const n of [28, 512, 20_000]) {
      const label = "secret" + "A".repeat(n);
      const started = Date.now();
      expect(isSensitiveLabel(label), `n=${n}`).toBe(false);
      redactText(`${label}="x"`);
      expect(Date.now() - started, `n=${n}`).toBeLessThan(TIME_BUDGET_MS);
    }
    // A label within the examinable bound is classified, not failed closed.
    expect(redactText(`${"secret" + "A".repeat(28)}="x"`).redacted).toBe(false);
    // A label beyond the bound cannot be examined whole, so the assignment fails
    // closed rather than being classified from a truncated suffix.
    expect(redactText(`${"secret" + "A".repeat(512)}="x"`).redacted).toBe(true);
  });

  it("classifies long real labels and their near-misses correctly", () => {
    for (const label of ["secretAccessKey", "SecretKey", "clientSecretValue", "OPENAI_KEY", "accessToken"]) {
      expect(isSensitiveLabel(label), label).toBe(true);
    }
    for (const label of ["secretary", "monkey", "secretSanta", "secret" + "A".repeat(200), "credential" + "B".repeat(200)]) {
      expect(isSensitiveLabel(label), label).toBe(false);
    }
  });
});

describe("url userinfo credentials of any length", () => {
  const TIME_BUDGET_MS = 5_000;

  it("redacts a userinfo longer than any cap", () => {
    // Regression: the 256-character cap meant a longer credential matched nothing,
    // the engine backtracked, and the whole userinfo was left in the text.
    for (const repeat of [50, 500, 5_000]) {
      const input = "https://alice:" + "opaque_".repeat(repeat) + "@example.com/repo";
      const result = redactText(input);
      expect(result.text, `repeat=${repeat}`).not.toContain("opaque_");
      expect(result.text, `repeat=${repeat}`).toBe("https://[redacted]@example.com/repo");
    }
  });

  it("still redacts an ordinary userinfo and leaves a user-only URL alone", () => {
    expect(redactText("https://alice:hunter2@example.com/repo.git").text).toBe("https://[redacted]@example.com/repo.git");
    expect(redactText("https://token@example.com/x").text).toBe("https://token@example.com/x");
  });

  it("stays bounded on adversarial URL-like input", () => {
    for (const input of [
      "a://" + "x".repeat(200_000),
      "a://" + "x".repeat(200_000) + ":",
      "a://".repeat(50_000),
      "://".repeat(66_000),
      "a://" + "x:y@".repeat(50_000),
    ]) {
      const started = Date.now();
      redactText(input);
      expect(Date.now() - started, `len=${input.length}`).toBeLessThan(TIME_BUDGET_MS);
    }
  });
});

describe("plaintext around an escaped quoted phrase is still scanned", () => {
  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  const GHP = "ghp_abcdefghijklmnopqrstuvwx";

  it("redacts a token that follows an escaped quoted phrase", () => {
    // Regression: content containing an escaped quote was taken to be fully
    // inspected, so the plaintext between and around the quotes — where the token
    // sat — was never passed to the scalar rules.
    const input = escapedDocument({ note: `say "hello" ${GHP}` });
    const result = redactText(input);

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(GHP);
    // The quoted phrase and the escaping level survive.
    expect(result.text).toContain("hello");
    expect(result.text).toContain('\\"');
  });

  it("redacts a credential assignment that precedes an escaped quoted phrase", () => {
    const input = escapedDocument({ note: 'password=synthetic-value and "quoted"' });
    const result = redactText(input);

    expect(result.text).not.toContain("synthetic-value");
    expect(result.text).toContain('password=[redacted]');
    expect(result.text).toContain("quoted");
  });

  it("redacts tokens on both sides of an escaped quoted phrase", () => {
    const input = escapedDocument({ note: `${GHP} and "quoted" and ${GHP}` });
    const result = redactText(input);
    expect(result.text).not.toContain(GHP);
    expect(result.text).toContain("quoted");
    expect(result.text.match(/\[redacted\]/g)?.length).toBe(2);
  });

  it("keeps the nested-document repair alongside the plaintext scan", () => {
    const input = escapedDocument({
      OPENAI_KEY: "k",
      note: `${GHP} ${JSON.stringify({ OPENAI_KEY: [17, 23, 42, 91] })}`,
    });
    const result = redactText(input);
    expect(result.text).not.toContain(GHP);
    expect(result.text).not.toContain("[17,23,42,91]");
  });

  it("is idempotent across repeated passes", () => {
    for (const input of [
      escapedDocument({ note: `say "hello" ${GHP}` }),
      escapedDocument({ note: 'password=synthetic-value and "quoted"' }),
      escapedDocument({ note: `${GHP} and "quoted" and ${GHP}` }),
    ]) {
      const once = redactText(input);
      const twice = redactText(once.text);
      const thrice = redactText(twice.text);
      expect(once.redacted, input).toBe(true);
      expect(twice.text, input).toBe(once.text);
      expect(thrice.text, input).toBe(once.text);
    }
  });

  it("leaves escaped prose without a credential byte for byte", () => {
    const input = escapedDocument({ note: 'say "hello" and "goodbye"' });
    expect(redactText(input).text).toBe(input);
    expect(redactText(input).redacted).toBe(false);
  });
});

describe("the credential-label classifier is linear at every length", () => {
  /** Generous: the broken pattern took seconds and grew quadratically. */
  const TIME_BUDGET_MS = 1_000;

  it("classifies adversarial near-miss labels in bounded time", () => {
    // Regression: the leading alphanumeric prefix and the trailing suffix of the
    // camelCase key shape overlapped, so a near-miss label — a valid prefix, a
    // repeated `Secret` candidate, and no suffix — cost quadratic work. The sizes
    // ascend so a regression fails on the first case rather than running away.
    for (const n of [256, 4_096, 20_000]) {
      const label = "aSecretX".repeat(n) + "!";
      const started = Date.now();
      expect(isSensitiveLabel(label), `n=${n}`).toBe(false);
      expect(redactText(`${label}="x"`).redacted, `n=${n}`).toBe(false);
      expect(Date.now() - started, `n=${n}`).toBeLessThan(TIME_BUDGET_MS);
    }
  });

  it("classifies repeated Secret candidates correctly", () => {
    for (const label of [
      "aSecretXaSecretX",
      "aSecretXaSecretXaSecretX",
      "SecretSecret",
      "SecretKeySecretKey",
      "mySecretmySecret",
    ]) {
      // Each of these ends in something other than a credential word, so none is a
      // credential label; the point is that the answer is reached quickly.
      const started = Date.now();
      isSensitiveLabel(label);
      expect(Date.now() - started, label).toBeLessThan(TIME_BUDGET_MS);
    }
    // The established positives and negatives are unchanged.
    for (const label of ["accessToken", "clientSecret", "secretAccessKey", "SecretKey", "myApiKey", "clientSecretValue"]) {
      expect(isSensitiveLabel(label), label).toBe(true);
    }
    for (const label of ["secretary", "monkey", "secretSanta", "tokenCount", "passwordReset", "credentialType"]) {
      expect(isSensitiveLabel(label), label).toBe(false);
    }
  });

  it("still redacts the camelCase scalar forms", () => {
    for (const [input, secret] of [
      ["accessToken: opaque-unquoted-value-1234", "opaque-unquoted-value-1234"],
      ["clientSecret=opaque-unquoted-value-5678", "opaque-unquoted-value-5678"],
      ['{"accessToken":"opaque-quoted-value-9012"}', "opaque-quoted-value-9012"],
      ['\\"accessToken\\":\\"opaque-escaped-value-3456\\"', "opaque-escaped-value-3456"],
      ["myApiKey: opaque-camel-value-7890", "opaque-camel-value-7890"],
    ] as const) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).not.toContain(secret);
    }
  });
});

describe("the linear camelCase classifier agrees with the pattern it replaced", () => {
  /**
   * The classifier as it was written before: the same shape, as a regular
   * expression. It is the oracle for the linear parser, and it is only usable on
   * short labels — that is precisely why it was replaced.
   */
  const ORACLE = new RegExp(
    "^(?:(?:[A-Za-z0-9]*[a-z0-9]" +
      "(?:Secret|Token|Password|Passwd|Credential|Credentials|PrivateKey|ApiKey|APIKey|apiKey|Authorization)" +
      "(?:[A-Z][A-Za-z0-9]*)?)" +
      "|(?:(?:[Ss]ecret|[Cc]redential)(?:[A-Z][A-Za-z0-9]*)?" +
      "(?:Key|Value|Token|Secret|Password|Passwd|Credential|Credentials|PrivateKey|ApiKey|APIKey|apiKey|Authorization)" +
      "(?:[A-Z][A-Za-z0-9]*)?))$",
  );

  /** Every string of length 1..4 over a small alphabet that exercises the shape. */
  function* shortLabels(): Generator<string> {
    const alphabet = ["a", "S", "K", "X", "1", "_"];
    for (let length = 1; length <= 4; length += 1) {
      const indices = new Array<number>(length).fill(0);
      for (;;) {
        yield indices.map((index) => alphabet[index]).join("");
        let position = length - 1;
        while (position >= 0) {
          indices[position] += 1;
          if (indices[position] < alphabet.length) break;
          indices[position] = 0;
          position -= 1;
        }
        if (position < 0) break;
      }
    }
  }

  it("agrees on every short label over a shape-exercising alphabet", () => {
    let checked = 0;
    for (const label of shortLabels()) {
      expect(isCamelSecretLabel(label), label).toBe(ORACLE.test(label));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(1_000);
  });

  it("agrees on the documented labels and their near-misses", () => {
    const labels = [
      "accessToken", "refreshToken", "clientSecret", "clientSecretKey", "idToken", "userPassword",
      "myApiKey", "clientSecretValue", "secretKey", "secretValue", "credentialKey", "secretAccessKey",
      "SecretKey", "SecretAccessKey", "APIKey", "apiKey", "SecretValue", "CredentialToken",
      "secretary", "author", "monkey", "tokenCount", "passwordReset", "credentialType", "secretSanta",
      "turnstile", "passwordHash", "OPENAI_MODEL", "LOG_LEVEL", "RETRY_COUNT", "region", "config", "model",
      "accessTokenValue", "SecretKeyValue", "aSecret", "aSecretX", "Secret", "Key", "Value", "Token",
      "SecretSecret", "secretSecret", "CredentialCredentials", "xApiKey", "ApiKeyX", "mySecretKey",
    ];
    for (const label of labels) {
      expect(isCamelSecretLabel(label), label).toBe(ORACLE.test(label));
    }
  });

  it("agrees on labels built from the words themselves", () => {
    const words = ["Secret", "Token", "Password", "Key", "Value", "Credential", "ApiKey", "apiKey", "secret", "credential"];
    const prefixes = ["", "a", "my", "client", "X", "1", "ab1"];
    const suffixes = ["", "X", "Value", "Key", "x", "1", "Zz9"];
    for (const prefix of prefixes) {
      for (const first of words) {
        for (const second of words) {
          for (const suffix of suffixes) {
            const label = prefix + first + second + suffix;
            expect(isCamelSecretLabel(label), label).toBe(ORACLE.test(label));
          }
        }
      }
    }
  });
});

describe("the linear separator and env classifiers agree with the patterns they replaced", () => {
  /**
   * The two predicates as they were written before, as regular expressions. They
   * are the oracle for the linear parsers, and they are only usable on short labels
   * — that is precisely why they were replaced.
   */
  const SEPARATOR_ORACLE = /^(?:[A-Za-z0-9]+[_.-])*(?:api[_-]?key|apikey|secret|token|password|passwd|credential|private[_-]?key|authorization)(?:[_.-][A-Za-z0-9]+)*$/i;
  const ENV_ORACLE = /^[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*$/;

  /** Every string of length 1..4 over an alphabet that exercises the shapes. */
  function* shortLabels(): Generator<string> {
    const alphabet = ["a", "K", "e", "_", ".", "-", "1"];
    for (let length = 1; length <= 4; length += 1) {
      const indices = new Array<number>(length).fill(0);
      for (;;) {
        yield indices.map((index) => alphabet[index]).join("");
        let position = length - 1;
        while (position >= 0) {
          indices[position] += 1;
          if (indices[position] < alphabet.length) break;
          indices[position] = 0;
          position -= 1;
        }
        if (position < 0) break;
      }
    }
  }

  it("agrees on every short separator-delimited label", () => {
    let checked = 0;
    for (const label of shortLabels()) {
      expect(isSeparatorSecretLabel(label), label).toBe(SEPARATOR_ORACLE.test(label));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(1_000);
  });

  it("agrees on every short environment-style label", () => {
    const alphabet = ["A", "K", "E", "Y", "_", "1", "a"];
    let checked = 0;
    for (let length = 1; length <= 4; length += 1) {
      const indices = new Array<number>(length).fill(0);
      for (;;) {
        const label = indices.map((index) => alphabet[index]).join("");
        expect(isEnvSecretLabel(label), label).toBe(ENV_ORACLE.test(label));
        checked += 1;
        let position = length - 1;
        while (position >= 0) {
          indices[position] += 1;
          if (indices[position] < alphabet.length) break;
          indices[position] = 0;
          position -= 1;
        }
        if (position < 0) break;
      }
    }
    expect(checked).toBeGreaterThan(2_000);
  });

  it("agrees on the documented separator labels and their near-misses", () => {
    const labels = [
      "api_key", "apikey", "api-key", "API_KEY", "my_api_key", "my_secret_value", "db_password",
      "secret", "secret_key", "secret.value", "access_token", "refresh-token", "private_key",
      "privateKey", "private-key", "privatekey", "client_credential", "authorization", "Authorization",
      "author", "secretary", "key", "value", "token_count", "password_reset", "credential_type",
      "a_b", "a.b", "a-b", "a__b", "_a", "a_", "a_._b", "apikey_key", "key_apikey", "privatekey_key",
      "region", "config", "model",
    ];
    for (const label of labels) {
      expect(isSeparatorSecretLabel(label), label).toBe(SEPARATOR_ORACLE.test(label));
    }
  });

  it("agrees on the documented env labels and their near-misses", () => {
    const labels = [
      "OPENAI_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "MY_SECRET", "DB_PASSWORD", "A_CREDENTIAL",
      "KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "XKEY", "KEYX", "OPENAI_MODEL",
      "LOG_LEVEL", "RETRY_COUNT", "region", "config", "model", "Openai_Key", "openai_key",
      "MY_SECRETS", "MY_KEY_2", "KEY2", "2KEY",
    ];
    for (const label of labels) {
      expect(isEnvSecretLabel(label), label).toBe(ENV_ORACLE.test(label));
    }
  });

  it("is linear on a repeated separator label", () => {
    // Regression: the predicate was quadratic — 1077 ms for 64 000 characters.
    const started = Date.now();
    for (const n of [1_000, 8_000, 64_000]) {
      expect(isSecretKey("api_key.".repeat(n) + "!")).toBe(false);
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("an escaped string's content goes through the whole escaped pipeline", () => {
  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  it("redacts an assignment with a container value inside the content", () => {
    // Regression: an ordinary string's content was checked only by the scalar
    // rules, which understand neither a container value nor an escaped-string
    // value — so `password=[17,23,42,91]` survived the credential key in front of it.
    for (const [content, gone] of [
      ["password=[17,23,42,91]", "[17,23,42,91]"],
      ['accessToken={"value":"opaque-live"}', "opaque-live"],
      ["api_key=[1,2,3]", "[1,2,3]"],
      ['GITHUB_TOKEN={"a":{"b":[1,2]}}', '"b":[1,2]'],
    ] as const) {
      const input = escapedDocument({ note: content });
      const result = redactText(input);
      expect(result.redacted, content).toBe(true);
      expect(result.text, content).not.toContain(gone);
    }
  });

  it("redacts an assignment with an escaped-string value inside the content", () => {
    const input = escapedDocument({ note: 'password="synthetic-opaque-value"' });
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("synthetic-opaque-value");
    expect(result.text).toContain("password=");
  });

  it("keeps the escaping of the surrounding document", () => {
    const input = escapedDocument({ note: 'password="synthetic-opaque-value"', region: "us-east-1" });
    const result = redactText(input);
    expect(result.text).not.toContain("synthetic-opaque-value");
    // The document is still escaped at its original level and the sibling survives.
    expect(result.text).toContain('\\"region\\":\\"us-east-1\\"');
  });

  it("is idempotent across repeated passes", () => {
    for (const content of [
      'password="synthetic-opaque-value"',
      "password=[17,23,42,91]",
      'accessToken={"value":"opaque-live"}',
      "api_key=[1,2,3]",
    ]) {
      const input = escapedDocument({ note: content });
      const once = redactText(input);
      const twice = redactText(once.text);
      const thrice = redactText(twice.text);
      expect(twice.text, content).toBe(once.text);
      expect(thrice.text, content).toBe(once.text);
    }
  });

  it("leaves a benign assignment and a benign container alone", () => {
    for (const content of ["region=us-east-1", '{"a":1,"b":[2,3]}', "count=[1,2,3]"]) {
      const input = escapedDocument({ note: content });
      const result = redactText(input);
      expect(result.redacted, content).toBe(false);
      expect(result.text, content).toBe(input);
    }
  });
});

describe("the separator and env key/value rules stay linear", () => {
  /** Generous: the unbounded patterns took seconds and grew quadratically. */
  const TIME_BUDGET_MS = 2_000;

  it("bounds the rules on repeated separator labels", () => {
    // Regression: `SECRET_KEY`'s prefix and suffix repetitions overlapped around the
    // word alternation, so a repeated label made the predicate and every rule built
    // on it quadratic — 1077 ms for 64 000 characters, doubling every 8 000.
    for (const input of [
      "api_key.".repeat(2_000) + "!",
      "my_secret_value_".repeat(1_200) + "!",
      "db_password.".repeat(1_500) + "!",
      "private_key.".repeat(1_500) + "!",
      "OPENAI_KEY_".repeat(2_000) + "!",
    ]) {
      const started = Date.now();
      redactText(input);
      expect(Date.now() - started, `len=${input.length}`).toBeLessThan(TIME_BUDGET_MS);
    }
  });

  it("bounds the predicates on repeated labels", () => {
    const started = Date.now();
    for (const label of [
      "api_key.".repeat(4_000) + "!",
      "OPENAI_KEY_".repeat(4_000) + "!",
      "my_secret_value.".repeat(4_000) + "!",
    ]) {
      isSecretKey(label);
      isSensitiveLabel(label);
    }
    expect(Date.now() - started).toBeLessThan(TIME_BUDGET_MS);
  });

  it("still redacts every separator and env key form", () => {
    for (const [input, secret] of [
      ["api_key=opaque-secret-1", "opaque-secret-1"],
      ["my_secret_value: opaque-secret-2", "opaque-secret-2"],
      ["db_password='opaque-secret-3'", "opaque-secret-3"],
      ['{"api_key":"opaque-secret-4"}', "opaque-secret-4"],
      ["privateKey=opaque-secret-5", "opaque-secret-5"],
      ["OPENAI_KEY=opaque-secret-6", "opaque-secret-6"],
      ['OPENAI_KEY="opaque-secret-7"', "opaque-secret-7"],
      ['\\"api_key\\":\\"opaque-secret-8\\"', "opaque-secret-8"],
      ['\\"OPENAI_KEY\\":\\"opaque-secret-9\\"', "opaque-secret-9"],
    ] as const) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).not.toContain(secret);
    }
  });

  it("leaves ordinary words untouched", () => {
    for (const input of ["region=us-east-1", "config: prod", "author: Ada Lovelace", "secretary: Jane Roe"]) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(false);
      expect(result.text, input).toBe(input);
    }
  });
});

describe("the full assignment grammar at every escaped depth", () => {
  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  it("redacts a quoted label with either separator", () => {
    // Regression: only escaped quoted keys followed by `:` were detected, so a
    // single-quoted label and its container value were left whole.
    for (const [note, gone] of [
      ["'password': [17,23,42,91]", "[17,23,42,91]"],
      ["'api_key'=[9,9]", "[9,9]"],
      ['"password": [1,2]', "[1,2]"],
      ["password: [1,2]", "[1,2]"],
    ] as const) {
      const result = redactText(escapedDocument({ note }));
      expect(result.redacted, note).toBe(true);
      expect(result.text, note).not.toContain(gone);
    }
  });

  it("consumes a bare value that contains brackets", () => {
    const result = redactText(escapedDocument({ note: "password=correct[42]horse" }));
    expect(result.text).not.toContain("[42]horse");
    expect(result.text).not.toContain("correct");
  });

  it("is idempotent across the whole grammar", () => {
    for (const note of [
      "'password': [17,23,42,91]",
      "password=correct[42]horse",
      '"password": [1,2]',
      "password=[1,2]",
    ]) {
      const input = escapedDocument({ note });
      const once = redactText(input);
      const twice = redactText(once.text);
      expect(twice.text, note).toBe(once.text);
      expect(redactText(twice.text).text, note).toBe(once.text);
    }
  });
});

describe("a credential value must be complete and well formed", () => {
  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  it("fails closed when a container is followed by a suffix", () => {
    // Regression: only the array was consumed, leaving the suffix with no key.
    for (const note of ["password=[1,2]opaque-suffix", "password={a:1}opaque"]) {
      const result = redactText(escapedDocument({ note }));
      expect(result.text, note).not.toContain("opaque-suffix");
      expect(result.text, note).toContain("[redacted:uninspected]");
    }
  });

  it("fails closed on a mismatched closer", () => {
    for (const note of ["password=[1,2}", "password={a:1]"]) {
      const result = redactText(escapedDocument({ note }));
      expect(result.redacted, note).toBe(true);
      expect(result.text, note).toContain("[redacted:uninspected]");
    }
  });

  it("still consumes well-formed structured values", () => {
    for (const [note, gone] of [
      ["password=[1,2]", "[1,2]"],
      ["password={a:1}", "{a:1}"],
      ["password=[[1],[2]]", "[[1],[2]]"],
    ] as const) {
      const result = redactText(escapedDocument({ note }));
      expect(result.text, note).not.toContain(gone);
    }
  });
});

describe("separator-only runs and nested containers stay bounded", () => {
  /** Generous: the rescanning walk took twenty seconds for 40 000 characters. */
  const TIME_BUDGET_MS = 3_000;

  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  it("advances past a plain separator-only run", () => {
    for (const n of [50_000, 100_000]) {
      const started = Date.now();
      const result = redactText(".".repeat(n) + "!");
      expect(Date.now() - started, `n=${n}`).toBeLessThan(TIME_BUDGET_MS);
      expect(result.text.length).toBe(n + 1);
    }
  });

  it("advances past an escaped separator-only run", () => {
    for (const n of [50_000, 100_000]) {
      const input = escapedDocument({ note: ".".repeat(n) + "!" });
      const started = Date.now();
      redactText(input);
      expect(Date.now() - started, `n=${n}`).toBeLessThan(TIME_BUDGET_MS);
    }
  });

  it("stays bounded on deeply nested containers", () => {
    let nested = "x";
    for (let i = 0; i < 400; i += 1) nested = `[${nested}]`;
    const started = Date.now();
    const result = redactText(escapedDocument({ note: nested }));
    expect(Date.now() - started).toBeLessThan(TIME_BUDGET_MS);
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("stays bounded on a long prefix before a credential key", () => {
    const started = Date.now();
    const result = redactText("a".repeat(100_000) + ' password="opaque-secret-value"');
    expect(Date.now() - started).toBeLessThan(TIME_BUDGET_MS);
    expect(result.text).not.toContain("opaque-secret-value");
  });
});

describe("the reviewer's exact leakage repros are repaired", () => {
  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  const GHP = "ghp_abcdefghijklmnopqrstuvwx";

  it("A: redacts a quoted-label container assignment inside an escaped ordinary string", () => {
    // Repro: `escapedDocument({ note: "'password': [17,23,42,91]" })` retained the
    // array. A single-quoted label was not recognised at the decoded depth, so the
    // container value was never consumed.
    const input = escapedDocument({ note: "'password': [17,23,42,91]" });
    const result = redactText(input);

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("[17,23,42,91]");
    expect(result.text).not.toContain("17,23,42,91");
    expect(result.text).toBe('{\\"note\\":\\"\'password\': [redacted]\\"}');
    // The same shape in plain (single-encoded) JSON.
    expect(redactText(JSON.stringify({ note: "'password': [17,23,42,91]" })).text).toBe(
      '{"note":"\'password\': [redacted]"}',
    );
  });

  it("A: redacts a whole bare value that contains brackets, leaving no suffix", () => {
    // Repro: `escapedDocument({ note: "password=correct[42]horse" })` masked only the
    // prefix, because the bare-value scan stopped at the `[`.
    const input = escapedDocument({ note: "password=correct[42]horse" });
    const result = redactText(input);

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("[42]horse");
    expect(result.text).not.toContain("horse");
    expect(result.text).not.toContain("correct");
    expect(result.text).toBe('{\\"note\\":\\"password=[redacted]\\"}');
  });

  it("B: redacts a malformed bare credential in an ordinary container", () => {
    // Repro: `{"outer":[ghp_…]}` — a bare token inside a container the structural
    // walk owns. Marking the whole container owned hid the token from the scalar
    // complement pass, so nothing removed it.
    const raw = `{"outer":[${GHP}]}`;
    const rawResult = redactText(raw);
    expect(rawResult.redacted).toBe(true);
    expect(rawResult.text).not.toContain(GHP);
    expect(rawResult.text).toBe('{"outer":[[redacted]]}');

    for (const input of [
      escapedDocument({ outer: [GHP] }),
      escapedDocument({ outer: { inner: [GHP] } }),
      escapedDocument({ outer: [{ deep: GHP }] }),
      JSON.stringify({ outer: escapedDocument({ outer: [GHP] }) }),
    ]) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).not.toContain(GHP);
    }
  });

  it("C: fails closed when a container value is followed by a suffix", () => {
    // Repro: `password=[1,2]opaque-suffix` consumed only the array, leaving the
    // suffix with no key in front of it.
    const input = escapedDocument({ note: "password=[1,2]opaque-suffix" });
    const result = redactText(input);

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("opaque-suffix");
    expect(result.text).not.toContain("[1,2]");
    expect(result.text).toContain("[redacted:uninspected]");
  });

  it("C: fails closed on a mismatched closer and accepts the well-formed counterpart", () => {
    // Repro: `password=[1,2}` was accepted as a complete value; `]` does not close `{`.
    const mismatched = redactText(escapedDocument({ note: "password=[1,2}" }));
    expect(mismatched.redacted).toBe(true);
    expect(mismatched.text).not.toContain("[1,2}");
    expect(mismatched.text).toContain("[redacted:uninspected]");

    // The valid counterpart is consumed as one value rather than failing closed.
    const valid = redactText(escapedDocument({ note: "password=[1,2]" }));
    expect(valid.text).not.toContain("[1,2]");
    expect(valid.text).toBe('{\\"note\\":\\"password=[redacted]\\"}');
    expect(valid.text).not.toContain("[redacted:uninspected]");

    // A quoted label with `=` is the same assignment grammar.
    expect(redactText(escapedDocument({ note: "'api_key'=[9,9]" })).text).toBe('{\\"note\\":\\"\'api_key\'=[redacted]\\"}');
  });

  it("D: a separator-only run is advanced as a unit and does not hide a following assignment", () => {
    // Repro: a separator-only run was rescanned one character at a time — quadratic —
    // and a following credential assignment could be skipped.
    const started = Date.now();
    const input = escapedDocument({ note: ".".repeat(1_000) + " password=opaque-secret-value" });
    const result = redactText(input);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("opaque-secret-value");
    expect(result.text).toContain("password=[redacted]");

    // A run with nothing credential-shaped after it is left byte for byte.
    const plain = ".".repeat(1_000) + "!";
    expect(redactText(plain).text).toBe(plain);
    expect(redactText(plain).redacted).toBe(false);
  });

  it("is idempotent over every repaired repro", () => {
    for (const input of [
      escapedDocument({ note: "'password': [17,23,42,91]" }),
      escapedDocument({ note: "password=correct[42]horse" }),
      escapedDocument({ note: "password=[1,2]opaque-suffix" }),
      escapedDocument({ note: "password=[1,2}" }),
      escapedDocument({ note: "password=[1,2]" }),
      escapedDocument({ outer: { inner: [GHP] } }),
    ]) {
      const once = redactText(input);
      const twice = redactText(once.text);
      expect(once.redacted, input).toBe(true);
      expect(once.text, input).not.toContain(GHP);
      expect(twice.text, input).toBe(once.text);
      expect(redactText(twice.text).text, input).toBe(once.text);
    }
  });

  it("converges from the second pass for a malformed raw container, and never re-leaks", () => {
    // A raw, malformed container (`{"outer":[ghp_…]}`) is redacted by the scalar
    // pass, which rewrites the bare token in place: `{"outer":[[redacted]]}`. The
    // second pass sees a *valid* JSON fragment `["[redacted]"]` and normalises it to
    // `{"outer":["[redacted]"]}` — a representation change, not a leak. Convergence
    // is therefore asserted from the second pass onward, while the token-absence
    // assertion holds at every pass, including the first.
    const input = `{"outer":[${GHP}]}`;
    const once = redactText(input);
    const twice = redactText(once.text);
    const thrice = redactText(twice.text);

    // The token is gone at every pass — this assertion is never relaxed.
    for (const [pass, result] of [["once", once], ["twice", twice], ["thrice", thrice]] as const) {
      expect(result.text, pass).not.toContain(GHP);
    }
    expect(once.text).toBe('{"outer":[[redacted]]}');
    expect(once.redacted).toBe(true);
    // The second pass normalises the now-valid fragment; it still changed the text.
    expect(twice.text).toBe('{"outer":["[redacted]"]}');
    expect(twice.redacted).toBe(true);
    // Convergence: the third pass is byte-identical and changes nothing.
    expect(thrice.text).toBe(twice.text);
    expect(thrice.redacted).toBe(false);
    expect(redactText(thrice.text).text).toBe(twice.text);
  });
});

describe("a credential assignment's value boundary must be complete", () => {
  // Regression: a closing quote or bracket was accepted as proof that the
  // assignment had ended, so only the delimited part was removed and the
  // continuation was stranded with no key in front of it — the leak the boundary
  // check exists to prevent.
  const FAIL_CLOSED = [
    'password=""opaque-live-value',
    'password="abc"opaque-live-value',
    'password="abc""def"',
    '{\\"password\\":\\"abc\\"opaque-live-value}',
    '{\\"password\\":[]opaque-live-value}',
  ] as const;

  it("fails closed when a delimited value is followed by a continuation", () => {
    for (const input of FAIL_CLOSED) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).not.toContain("opaque-live-value");
      expect(result.text, input).toContain("[redacted:uninspected]");
    }
  });

  it("preserves a clearly terminated assignment", () => {
    for (const [input, expected] of [
      ['password="opaque-value"', "password=[redacted]"],
      ['password="opaque-value" ', "password=[redacted] "],
      ['password="opaque-value", x', "password=[redacted], x"],
      ['{"password":"opaque-value"}', '{"password":"[redacted]"}'],
      ['\\"password\\":\\"opaque-value\\"', '\\"password\\":\\"[redacted]\\"'],
      ['{\\"password\\":[1,2]}', '{\\"password\\":\\"[redacted]\\"}'],
      ['\\"password\\":\\"opaque-value\\",\\"n\\":1', '\\"password\\":\\"[redacted]\\",\\"n\\":1'],
    ] as const) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).toBe(expected);
      expect(result.text, input).not.toContain("uninspected");
    }
  });

  it("fails closed through the structured and display entry points too", () => {
    for (const input of FAIL_CLOSED) {
      expect(redactStructuredLeaves({ note: input }).note, input).toBe("[redacted:uninspected]");
      expect(redactSerializedValue(JSON.stringify({ note: input })), input).not.toContain("opaque-live-value");
      expect(sanitiseForDisplay(input, 10_000).text, input).toBe("[redacted:uninspected]");
    }
  });

  it("is idempotent over the boundary shapes", () => {
    for (const input of FAIL_CLOSED) {
      const once = redactText(input);
      const twice = redactText(once.text);
      expect(twice.text, input).toBe(once.text);
      expect(redactText(twice.text).text, input).toBe(once.text);
    }
  });
});

describe("a credential key with an escape the decoder cannot resolve is sensitive", () => {
  // Regression: `{\"access\u0054oken\":\"…\"}` is the escaped spelling of
  // `accessToken`, but the key decoder handles only `\"` and `\\`, so the key was
  // not recognised and its value survived.
  it("redacts a value under a Unicode-escaped credential key", () => {
    const escaped = redactText('{\\"access\\u0054oken\\":\\"opaque-live-value\\"}');
    expect(escaped.redacted).toBe(true);
    expect(escaped.text).not.toContain("opaque-live-value");
    // The raw key spelling survives byte for byte; only the value is replaced.
    expect(escaped.text).toBe('{\\"access\\u0054oken\\":\\"[redacted]\\"}');
  });

  it("classifies conservatively, masking a benign key that carries an unhandled escape", () => {
    const benign = redactText('{\\"region\\u0041\\":\\"us-east-1\\"}');
    expect(benign.redacted).toBe(true);
    expect(benign.text).toBe('{\\"region\\u0041\\":\\"[redacted]\\"}');
  });

  it("leaves an ordinary key untouched and masks a key whose decoded form still carries an escape", () => {
    // The ordinary key is untouched...
    const ordinary = '{\\"region\\":\\"us-east-1\\"}';
    expect(redactText(ordinary).redacted, ordinary).toBe(false);
    expect(redactText(ordinary).text, ordinary).toBe(ordinary);

    // ...and a key that is only a *handled* escape at the outer layer is masked,
    // because decoding once exposes an escape the decoder cannot resolve
    // (`a\\b` -> `a\b`). That is the conservative direction: a key whose decoded
    // form still carries an escape could be an encoded credential key.
    const nested = '{\\"a\\\\b\\":\\"us-east-1\\"}';
    const result = redactText(nested);
    expect(result.redacted, nested).toBe(true);
    expect(result.text, nested).toBe('{\\"a\\\\b\\":\\"[redacted]\\"}');
  });

  it("still redacts the plain single-encoded Unicode-escaped key", () => {
    const result = redactText('{"access\\u0054oken":"opaque-live-value"}');
    expect(result.text).not.toContain("opaque-live-value");
  });
});

describe("nested nonsensitive containers are walked once, with bounded work and depth", () => {
  const GHP = "ghp_abcdefghijklmnopqrstuvwx";

  function escapedDocument(value: unknown): string {
    return JSON.stringify(JSON.stringify(value)).slice(1, -1);
  }

  function nested(depth: number, leaf: unknown): unknown {
    let node = leaf;
    for (let i = 0; i < depth; i += 1) node = { a: node };
    return node;
  }

  it("redacts a credential near the end of a nested container", () => {
    for (const depth of [0, 1, 3, 5, 10, 15]) {
      const result = redactText(escapedDocument(nested(depth, { k: GHP })));
      expect(result.redacted, `depth=${depth}`).toBe(true);
      expect(result.text, `depth=${depth}`).not.toContain(GHP);
      expect(result.text, `depth=${depth}`).not.toContain("uninspected");
    }
  });

  it("reports work that grows linearly with the input", () => {
    // The repeated subtree scan was quadratic, so the ratio of work to length grew
    // with nesting. A ratio that stays bounded — and does not increase as nesting
    // deepens — is the deterministic statement that the walk is single-pass.
    const ratios: number[] = [];
    for (const depth of [2, 4, 8, 12, 16]) {
      const input = escapedDocument(nested(depth, { k: "opaque-ordinary-value" }));
      const work = redactTextWithWork(input).work;
      ratios.push(work.scanned / input.length);
      expect(work.maxContainerDepth, `depth=${depth}`).toBe(depth + 1);
      expect(work.scanned / input.length, `depth=${depth}`).toBeLessThan(5);
    }
    // Deeper nesting costs proportionally no more per character than shallow.
    expect(ratios[ratios.length - 1]!).toBeLessThanOrEqual(ratios[0]!);
  });

  it("reports the same work for the same input on every call", () => {
    const input = escapedDocument(nested(8, { k: GHP }));
    const first = redactTextWithWork(input).work;
    for (let i = 0; i < 25; i += 1) {
      const work = redactTextWithWork(input).work;
      expect(work.scanned).toBe(first.scanned);
      expect(work.maxContainerDepth).toBe(first.maxContainerDepth);
    }
  });

  it("fails closed once nesting reaches the depth cap, and stays bounded", () => {
    for (const depth of [20, 50, 200]) {
      const started = Date.now();
      const result = redactText(escapedDocument(nested(depth, { k: GHP })));
      expect(Date.now() - started, `depth=${depth}`).toBeLessThan(1_000);
      expect(result.text, `depth=${depth}`).not.toContain(GHP);
      expect(result.text, `depth=${depth}`).toContain("[redacted:uninspected]");
      expect(redactTextWithWork(escapedDocument(nested(depth, { k: GHP }))).work.maxContainerDepth, `depth=${depth}`).toBe(20);
    }
  });

  it("fails closed on a malformed container instead of keeping part of it", () => {
    for (const input of ['{\\"a\\":{\\"b\\":1]}', '{\\"a\\":[1,2}}', '{\\"a\\":1]}', '{\\"a\\":{\\"b\\":1}']) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).toContain("[redacted:uninspected]");
    }
  });
});

describe("a brace inside a container's quoted string does not close the container", () => {
  // Regression: the container scanner skipped an escaped string (`\"…\"`) but not
  // an ordinary quoted one, so a brace *inside* a plain JSON string was read as the
  // container's close and the tail survived with no key in front of it.
  it("redacts the whole container when a brace sits inside a quoted value", () => {
    for (const [input, expected] of [
      ['password={"value":"},opaque-live-value"}', "password=[redacted]"],
      ['password={"value":"opaque"}', "password=[redacted]"],
      ['password={"a":1}', "password=[redacted]"],
      ['password={"value":"a}b"}', "password=[redacted]"],
    ] as const) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).not.toContain("opaque-live-value");
      expect(result.text, input).toBe(expected);
    }
  });

  it("fails closed on the escaped form when the container cannot be delimited", () => {
    const input = '{\\"password\\":{\\"value\\":\\"},\\"opaque-live-value\\"}}';
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("opaque-live-value");
  });

  it("fails closed on an unterminated quoted string inside a container", () => {
    const result = redactText('password={"value":"opaque-unterminated}');
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("opaque-unterminated");
    expect(result.text).toContain("[redacted:uninspected]");
  });
});

describe("the preceding-key lookup is bounded and linear", () => {
  // Regression: an unanchored pattern over the whole preceding text made a long
  // non-matching prefix before a valid fragment quadratic — 100 000 characters took
  // hundreds of milliseconds and doubled with the input.
  it("stays linear on a long non-matching prefix before a valid fragment", () => {
    for (const n of [50_000, 100_000, 200_000]) {
      const input = "z".repeat(n) + " [1]";
      const started = Date.now();
      const result = redactText(input);
      expect(Date.now() - started, `n=${n}`).toBeLessThan(1_000);
      // The prefix is not a credential, and the fragment holds no credential.
      expect(result.redacted, `n=${n}`).toBe(false);
      expect(result.text, `n=${n}`).toBe(input);
    }
  });

  it("still replaces a structured value under a preceding credential key", () => {
    for (const [input, expected] of [
      ['accessToken: {"a":1}', "accessToken: [redacted]"],
      ['"api_key": {"a":1}', '"api_key": [redacted]'],
      ["token=[1,2]", "token=[redacted]"],
      ["OPENAI_KEY: [1,2]", "OPENAI_KEY: [redacted]"],
    ] as const) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).toBe(expected);
    }
  });

  it("leaves an ordinary structured value alone", () => {
    for (const input of ["region: [1,2]", "count = [1,2,3]", '{"a":1}']) {
      expect(redactText(input).redacted, input).toBe(false);
    }
  });

  it("reports the fragment lookup as part of the structural work", () => {
    const input = "z".repeat(1_000) + ' accessToken: {"a":1}';
    const work = redactTextWithWork(input).work;
    expect(work.scanned).toBeGreaterThan(0);
    expect(work.scanned).toBeLessThan(input.length * 20);
  });
});

describe("a key with an escape hidden one layer deeper is sensitive", () => {
  // Regression: `{"access\\u0054oken":"…"}` is `accessToken` with the escape one
  // layer deeper — the decoder handled the outer `\\` and exposed an unresolved
  // `\u0054` at the next layer, so the key was not recognised and the value
  // survived.
  it("redacts a value under a key whose escape resolves only one layer deeper", () => {
    const input = String.raw`{"access\\u0054oken":"opaque-demo-value"}`;
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("opaque-demo-value");
    // The raw key spelling is preserved byte for byte.
    expect(result.text).toBe(String.raw`{"access\\u0054oken":"[redacted]"}`);
  });

  it("redacts through every entry point", () => {
    const input = String.raw`{"access\\u0054oken":"opaque-demo-value"}`;
    expect(redactStructuredLeaves({ note: input }).note).not.toContain("opaque-demo-value");
    expect(redactSerializedValue(JSON.stringify({ note: input }))).not.toContain("opaque-demo-value");
    expect(sanitiseForDisplay(input, 10_000).text).not.toContain("opaque-demo-value");
  });

  it("still redacts the single-encoded and escaped single-layer forms", () => {
    expect(redactText('{"access\\u0054oken":"opaque-demo-value"}').text).toBe('{"accessToken":"[redacted]"}');
    expect(redactText('{\\"access\\u0054oken\\":\\"opaque-demo-value\\"}').text).toBe(
      '{\\"access\\u0054oken\\":\\"[redacted]\\"}',
    );
  });

  it("leaves an ordinary key untouched", () => {
    const input = '{"region":"us-east-1"}';
    expect(redactText(input).redacted).toBe(false);
    expect(redactText(input).text).toBe(input);
  });
});

describe("a bare assignment with a quoted continuation fails closed", () => {
  // Regression: `password=prefix"opaque-demo-suffix"` scalar-redacted `prefix` and
  // left the quoted part with no key in front of it.
  it("fails closed on an adjacent quoted continuation", () => {
    for (const input of [
      'password=prefix"opaque-demo-suffix"',
      'password=prefix"opaque-demo-suffix',
      "password=prefix'opaque-demo-suffix'",
      'api_key=prefix"opaque-demo-suffix"',
    ]) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).not.toContain("opaque-demo-suffix");
      expect(result.text, input).toContain("[redacted:uninspected]");
    }
  });

  it("preserves a clearly terminated bare assignment", () => {
    for (const [input, expected] of [
      ["password=opaque-plain-value", "password=[redacted]"],
      ['password="opaque-plain-value"', "password=[redacted]"],
      ["password=opaque-plain-value ", "password=[redacted] "],
      ["password=opaque-plain-value, x", "password=[redacted], x"],
      ["accessToken=opaque-plain-value", "accessToken=[redacted]"],
    ] as const) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).toBe(expected);
    }
  });

  it("fails closed through the display entry point too", () => {
    const result = sanitiseForDisplay('password=prefix"opaque-demo-suffix"', 10_000);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("opaque-demo-suffix");
  });
});

describe("the private-key block pass is linear and fails closed", () => {
  const COMPLETE = "-----BEGIN RSA PRIVATE KEY-----\nMIIopaque\n-----END RSA PRIVATE KEY-----";
  const INCOMPLETE = "-----BEGIN RSA PRIVATE KEY-----\nMIIopaque";

  it("replaces a complete block with the canonical marker", () => {
    const result = redactText(COMPLETE);
    expect(result.redacted).toBe(true);
    expect(result.text).toBe("-----BEGIN PRIVATE KEY-----[redacted]-----END PRIVATE KEY-----");
    expect(result.text).not.toContain("MIIopaque");
  });

  it("fails closed on an incomplete block", () => {
    const result = redactText(INCOMPLETE);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("MIIopaque");
    expect(result.text).toContain("[redacted:uninspected]");
  });

  it("stays linear on repeated BEGIN markers with no END", () => {
    // Regression: the pattern retried its label run from every `-----BEGIN `, so
    // this shape was quadratic — 880 000 characters took over three seconds.
    for (const n of [10_000, 20_000, 40_000]) {
      const input = "-----BEGIN PRIVATE KEY".repeat(n);
      const started = Date.now();
      const result = redactText(input);
      expect(Date.now() - started, `n=${n}`).toBeLessThan(1_000);
      expect(result.redacted, `n=${n}`).toBe(true);
    }
  });

  it("stays linear on repeated complete blocks", () => {
    const input = `${COMPLETE}\n`.repeat(2_000);
    const started = Date.now();
    const result = redactText(input);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.text).not.toContain("MIIopaque");
  });

  it("reports work proportional to the input, deterministically", () => {
    const ratios: number[] = [];
    for (const n of [100, 400, 1_600]) {
      const input = `${COMPLETE}\n`.repeat(n);
      const first = redactPrivateKeyBlocksWithWork(input);
      const second = redactPrivateKeyBlocksWithWork(input);
      expect(first.scanned, `n=${n}`).toBe(second.scanned);
      ratios.push(first.scanned / input.length);
    }
    // Each character is examined once, so the ratio is constant — not growing with n.
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(0.1);
  });

  it("is idempotent over both shapes", () => {
    for (const input of [COMPLETE, INCOMPLETE]) {
      const once = redactText(input);
      const twice = redactText(once.text);
      expect(twice.text, input).toBe(once.text);
      expect(redactText(twice.text).text, input).toBe(once.text);
    }
  });
});

describe("the bounded preceding-key lookup fails closed when it cannot decide", () => {
  const SENTINEL = "opaque-review-sentinel";
  const FRAGMENT = JSON.stringify({ value: SENTINEL });
  /**
   * A non-sensitive key, so the assignment matcher leaves the fragment to the
   * preceding-key lookup. A sensitive key would be consumed as a whole assignment
   * before the lookup ever ran.
   */
  const PLAIN_KEY = "region";
  /** A long but examinable sensitive key: fully classified, so the value is redacted. */
  const LONG_KEY = `password.${"z".repeat(64)}`;

  it("fails closed when more whitespace than the bound separates the key from the fragment", () => {
    // Regression: the backward walk reported "no key" when it reached its bound, so a
    // long whitespace run before a valid fragment hid the key and the value survived.
    for (const gap of [" ".repeat(257), " ".repeat(300), "\n".repeat(257), "\t".repeat(257)]) {
      const result = redactText(`${PLAIN_KEY}=${gap}${FRAGMENT}`);
      expect(result.redacted, JSON.stringify(gap.slice(0, 1))).toBe(true);
      expect(result.text, JSON.stringify(gap.slice(0, 1))).not.toContain(SENTINEL);
      // The fragment is replaced by the uninspected marker: the scan could not prove
      // the fragment was not a credential value.
      expect(result.text, JSON.stringify(gap.slice(0, 1))).toContain("[redacted:uninspected]");
    }
  });

  it("still redacts the same value when the gap is within the bound", () => {
    for (const gap of ["", " ", " ".repeat(100), " ".repeat(200)]) {
      const result = redactText(`password=${gap}${FRAGMENT}`);
      expect(result.text, `gap=${gap.length}`).not.toContain(SENTINEL);
      expect(result.text, `gap=${gap.length}`).toContain("[redacted]");
      expect(result.text, `gap=${gap.length}`).not.toContain("[redacted:uninspected]");
    }
  });

  it("keeps the bounded work: the lookup never scans the whole prefix", () => {
    for (const n of [1_000, 10_000, 100_000]) {
      const input = `${LONG_KEY}=${" ".repeat(300)}${JSON.stringify({ value: SENTINEL })}${"z".repeat(n)}`;
      const started = Date.now();
      const work = redactTextWithWork(input).work;
      expect(Date.now() - started, `n=${n}`).toBeLessThan(1_000);
      // The bounded walk does not rescan the prefix, so the work stays linear in the
      // input and the ratio does not grow with the prefix.
      expect(work.scanned, `n=${n}`).toBeLessThan(input.length * 20);
    }
  });

  it("does not mark an ordinary nearby structured value", () => {
    for (const input of ['region: {"value":"us-east-1"}', 'region = {"a":1}', 'count: [1,2,3]']) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(false);
      expect(result.text, input).toBe(input);
    }
  });

  it("still redacts an ordinary nearby credential value", () => {
    for (const [input, expected] of [
      [`password: ${JSON.stringify({ value: SENTINEL })}`, "password: [redacted]"],
      [`accessToken=${JSON.stringify({ value: SENTINEL })}`, "accessToken=[redacted]"],
      ['OPENAI_KEY: {"a":1}', "OPENAI_KEY: [redacted]"],
    ] as const) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).toBe(expected);
    }
  });

  it("fails closed through the structured and display entry points too", () => {
    const input = `${LONG_KEY}=${" ".repeat(257)}${JSON.stringify({ value: SENTINEL })}`;
    expect(redactSerializedValue(JSON.stringify({ note: input }))).not.toContain(SENTINEL);
    expect(redactStructuredLeaves({ note: input }).note).not.toContain(SENTINEL);
    expect(sanitiseForDisplay(input, 100_000).text).not.toContain(SENTINEL);
  });
});

describe("the partial redaction an older build wrote is repaired", () => {
  const SENTINEL = "opaque-review-sentinel";
  const ARTIFACT = `password=[redacted],${SENTINEL}"}`;

  it("recovers the exact partial artifact a v13 database holds", () => {
    // The old scanner stopped at a brace inside the container's quoted string, so
    // `password={"value":"},<tail>"}` was stored as `password=[redacted],<tail>"`.
    // The current scanner accepted `[redacted]` as a complete value followed by a
    // valid `,`, so the tail survived.
    const result = redactText(ARTIFACT);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(SENTINEL);
    expect(result.text).toBe("password=[redacted:uninspected]");
  });

  it("recovers the artifact inside a JSON document without breaking the document", () => {
    const result = redactText(JSON.stringify({ note: ARTIFACT }));
    expect(result.text).not.toContain(SENTINEL);
    expect(result.text).toBe('{"note":"password=[redacted:uninspected]"}');
    // The repaired document is still valid JSON.
    expect(() => JSON.parse(result.text)).not.toThrow();
  });

  it("recovers the artifact when the tail carries no closing quote", () => {
    const result = redactText(`password=[redacted],${SENTINEL}`);
    expect(result.text).not.toContain(SENTINEL);
    expect(result.text).toBe("password=[redacted:uninspected]");
  });

  it("fails a spaced continuation after a redacted sensitive value, and leaves ordinary prose alone", () => {
    // Whitespace after the comma is not an exemption: the leaked suffix may begin
    // with one, so `password=[redacted], x` is consumed like any other artifact.
    const spaced = redactText("password=[redacted], x");
    expect(spaced.redacted).toBe(true);
    expect(spaced.text).toBe("password=[redacted:uninspected]");

    // A placeholder that ends the text, an already-repaired marker, prose without a
    // sensitive key, and a non-sensitive key are all left alone.
    for (const input of [
      "password=[redacted]",
      "password=[redacted:uninspected]",
      `the list [redacted],${SENTINEL}`,
      `region=[redacted],${SENTINEL}`,
    ]) {
      const result = redactText(input);
      expect(result.text, input).toBe(input);
    }
  });

  it("consumes the whole leaked remainder when it contains whitespace", () => {
    // Regression: recovery stopped at the first whitespace (or skipped entirely when
    // the comma was followed by a space), so a multi-word suffix stayed in the text.
    for (const input of [
      `password=[redacted],first opaque-secret-suffix`,
      `password=[redacted], multi word suffix`,
      `password=[redacted], opaque-live-value"}`,
      `password=[redacted], multi word opaque-live-value"}`,
    ]) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).toBe("password=[redacted:uninspected]");
      for (const needle of ["opaque-secret-suffix", "word ", "opaque-live-value"]) {
        expect(result.text, `${input}/${needle}`).not.toContain(needle);
      }
    }
  });

  it("fails an ambiguous comma after a container closed rather than keeping the tail", () => {
    for (const input of ["password=[1,2],opaque-tail", 'password="abc",opaque-tail']) {
      const result = redactText(input);
      expect(result.redacted, input).toBe(true);
      expect(result.text, input).not.toContain("opaque-tail");
      expect(result.text, input).toContain("[redacted:uninspected]");
    }
    // A spaced sibling after a non-sensitive value is still a legitimate continuation.
    expect(redactText("password=[1,2], x").text).toBe("password=[redacted], x");
  });

  it("is idempotent over the artifact and its repaired form", () => {
    for (const input of [ARTIFACT, JSON.stringify({ note: ARTIFACT }), `password=[redacted],${SENTINEL}`]) {
      const once = redactText(input);
      const twice = redactText(once.text);
      expect(twice.text, input).toBe(once.text);
      expect(redactText(twice.text).text, input).toBe(once.text);
    }
  });

  it("reports the recovery as redacted through the display entry point", () => {
    const result = sanitiseForDisplay(ARTIFACT, 10_000);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(SENTINEL);
  });
});

describe("legitimate structured JSON keeps its siblings", () => {
  // Regression: the artifact prepass ran before the structured parse, so a valid
  // document that merely carried a bare placeholder as a redacted value was treated
  // as a damaged assignment — its siblings and structure were deleted.
  it("preserves unrelated siblings in a document with a bare placeholder value", () => {
    for (const [input, expected] of [
      ['{"password":[redacted],"region":"us-east-1"}', '{"password":"[redacted]","region":"us-east-1"}'],
      ['{"accessToken":[redacted],"n":1}', '{"accessToken":"[redacted]","n":1}'],
      ['{"a":{"password":[redacted],"region":"us-east-1"}}', '{"a":{"password":"[redacted]","region":"us-east-1"}}'],
      ['{"password":[redacted],"list":[1,2,3]}', '{"password":"[redacted]","list":[1,2,3]}'],
    ] as const) {
      const result = redactText(input);
      expect(result.text, input).toBe(expected);
      // The repaired document is still valid JSON and its siblings survive.
      expect(() => JSON.parse(result.text), input).not.toThrow();
    }
  });

  it("preserves siblings through the structured and display entry points", () => {
    const input = '{"password":[redacted],"region":"us-east-1"}';
    expect(redactSerializedValue(input)).toBe('{"password":"[redacted]","region":"us-east-1"}');
    expect(redactStructuredLeaves({ note: input }).note).toBe('{"password":"[redacted]","region":"us-east-1"}');
    expect(sanitiseForDisplay(input, 10_000).text).toBe('{"password":"[redacted]","region":"us-east-1"}');
  });

  it("still recovers the malformed artifact, including a whitespace suffix", () => {
    // The distinction is parseability: this shape cannot be parsed or repaired, so
    // recovery runs and the whole leaked remainder is consumed.
    for (const [input, expected] of [
      ['{"password":[redacted],opaque-live-value"}', '{"password":[redacted:uninspected]'],
      ['{"password":[redacted], multi word opaque-live-value"}', '{"password":[redacted:uninspected]'],
    ] as const) {
      const result = redactText(input);
      expect(result.text, input).toBe(expected);
      expect(result.text, input).not.toContain("opaque-live-value");
    }
  });

  it("is idempotent for both the structured and the artifact form", () => {
    for (const input of [
      '{"password":[redacted],"region":"us-east-1"}',
      '{"password":[redacted],opaque-live-value"}',
      "password=[redacted], multi word suffix",
    ]) {
      const once = redactText(input);
      const twice = redactText(once.text);
      expect(twice.text, input).toBe(once.text);
      expect(redactText(twice.text).text, input).toBe(once.text);
    }
  });
});

describe("legacy artifact recovery is one bounded forward pass", () => {
  const SENTINEL = "opaque-review-sentinel";

  it("stays linear on marker-heavy text with no uninspected marker", () => {
    // Regression: the recovery found the next marker with two `indexOf` calls per
    // iteration, so `"[redacted] ".repeat(N)` re-scanned the whole remaining suffix
    // every time a marker was not an artifact — 352 000 characters took most of a
    // second and 16 MiB could stall a collector.
    const timings: number[] = [];
    for (const n of [2_000, 8_000, 32_000, 128_000]) {
      const input = "[redacted] ".repeat(n);
      const started = Date.now();
      const result = redactText(input);
      const elapsed = Date.now() - started;
      timings.push(elapsed);
      expect(elapsed, `n=${n}`).toBeLessThan(2_000);
      expect(result.text.length, `n=${n}`).toBeGreaterThan(0);
    }
    // The largest input must not cost disproportionately more than the smallest:
    // a quadratic pass would blow past this by orders of magnitude.
    expect(timings[timings.length - 1]!).toBeLessThan(2_000);
  });

  it("stays bounded on a large marker-heavy input", () => {
    // The scale that stalled before: roughly 4 MiB of plain markers.
    const input = "[redacted] ".repeat(Math.floor((4 * 1024 * 1024) / 11));
    const started = Date.now();
    redactText(input);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports deterministic work that is linear in the input", () => {
    // Work is charged to the shared budget, so the same input always reports the same
    // work and the cost is proportional to the input rather than to a re-scanned
    // suffix (a quadratic pass would show a ratio that grows with the input).
    const first = redactTextWithWork("[redacted] ".repeat(8_000)).work.scanned;
    for (let i = 0; i < 20; i += 1) {
      expect(redactTextWithWork("[redacted] ".repeat(8_000)).work.scanned).toBe(first);
    }
    const ratios: number[] = [];
    for (const n of [2_000, 8_000, 32_000]) {
      const input = "[redacted] ".repeat(n);
      ratios.push(redactTextWithWork(input).work.scanned / input.length);
    }
    // Linear: the per-character cost does not increase with the input.
    expect(ratios[ratios.length - 1]!).toBeLessThanOrEqual(ratios[0]!);
  });

  it("counts an unchanged recovery pass, not just a changed one", () => {
    // Regression: the recovery's work was only charged when it changed the text, so an
    // unchanged marker-heavy input got a fresh structural budget and the shared
    // accounting under-reported the total.
    const input = "[redacted] ".repeat(500);
    const unchanged = redactTextWithWork(input);
    expect(unchanged.text).toBe(input);
    // The recovery scanned the text even though it changed nothing, and that work is
    // counted: the reported total exceeds the input length.
    expect(unchanged.work.scanned).toBeGreaterThan(input.length);
  });

  it("fails closed when the combined work exceeds the allowance", () => {
    // The recovery scans the brace run and exhausts the shared allowance before it can
    // inspect the whole text, so the remainder is replaced rather than kept — the
    // recovery does not get a fresh budget.
    const input = `[redacted] ${"{".repeat(20_000)}`;
    const started = Date.now();
    const result = redactTextWithWork(input);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.text).toBe("[redacted:uninspected]");
    expect(result.work.scanned).toBeGreaterThan(0);
  });

  it("reports the recovery's work when it exhausts its own budget", () => {
    const input = `[redacted] ${"{".repeat(20_000)}`;
    const work = redactTextWithWork(input).work.scanned;
    expect(work).toBeGreaterThan(0);
    expect(redactTextWithWork(input).work.scanned).toBe(work);
  });

  it("counts the recovery pass against the shared budget", () => {
    // The prepass work was omitted from the shared accounting; it is now included, so
    // the reported work exceeds the input length for text the recovery inspected.
    const input = `password=[redacted], multi word ${SENTINEL}`;
    const work = redactTextWithWork(input).work;
    expect(work.scanned).toBeGreaterThan(input.length);
  });

  it("still recovers every legacy artifact", () => {
    for (const [input, expected] of [
      ["password=[redacted],opaque-live-value", "password=[redacted:uninspected]"],
      ["password=[redacted], multi word suffix", "password=[redacted:uninspected]"],
      [`password=[redacted],first word ${SENTINEL}`, "password=[redacted:uninspected]"],
      ["password=[redacted:uninspected] opaque-leftover", "password=[redacted:uninspected]"],
      ['password=[redacted],opaque-live-value"}', "password=[redacted:uninspected]"],
    ] as const) {
      const result = redactText(input);
      expect(result.text, input).toBe(expected);
    }
  });

  it("still bypasses recovery for recoverable structured JSON", () => {
    for (const [input, expected] of [
      ['{"password":[redacted],"region":"us-east-1"}', '{"password":"[redacted]","region":"us-east-1"}'],
      ['{"password":[redacted:uninspected],"n":1}', '{"password":"[redacted]","n":1}'],
    ] as const) {
      expect(redactText(input).text, input).toBe(expected);
    }
  });

  it("leaves a below-cap marker run byte for byte", () => {
    for (const input of ["[redacted] ".repeat(100), "note=[redacted] [redacted]"]) {
      const result = redactText(input);
      expect(result.text, input).toBe(input);
    }
  });

  it("is idempotent on marker-heavy text", () => {
    for (const input of ["[redacted] ".repeat(200), "[redacted:uninspected] ".repeat(200)]) {
      const once = redactText(input);
      const twice = redactText(once.text);
      expect(twice.text, "marker-heavy").toBe(once.text);
      expect(redactText(twice.text).text, "marker-heavy").toBe(once.text);
    }
  });
});

describe("embedded recoverable JSON is protected from legacy-tail recovery", () => {
  // Regression: the recovery was skipped only when the *whole* input parsed, so
  // recoverable JSON embedded in prose — `config {"password":[redacted],"region":"us-east-1"}`
  // — ran the recovery, which consumed `region` and everything after it.
  const SIBLING = "us-east-1";

  it("preserves the sibling and following text of an embedded document", () => {
    for (const [input, expected] of [
      [
        `config {"password":[redacted],"region":"${SIBLING}"}`,
        `config {"password":"[redacted]","region":"${SIBLING}"}`,
      ],
      [
        `config {"password":[redacted],"region":"${SIBLING}"} done`,
        `config {"password":"[redacted]","region":"${SIBLING}"} done`,
      ],
      [
        `log: {"password":[redacted],"region":"${SIBLING}"} trailing text here`,
        `log: {"password":"[redacted]","region":"${SIBLING}"} trailing text here`,
      ],
      [
        `prefix {"a":{"password":[redacted],"region":"${SIBLING}"}} suffix`,
        `prefix {"a":{"password":"[redacted]","region":"${SIBLING}"}} suffix`,
      ],
    ] as const) {
      const result = redactText(input);
      expect(result.text, input).toBe(expected);
      expect(result.text, input).not.toContain("[redacted:uninspected]");
    }
  });

  it("still recovers an actual malformed legacy artifact in prose", () => {
    for (const [input, expected] of [
      ["log password=[redacted], multi word suffix", "log password=[redacted:uninspected]"],
      [`config: password=[redacted], multi word ${SIBLING}`, "config: password=[redacted:uninspected]"],
    ] as const) {
      const result = redactText(input);
      expect(result.text, input).toBe(expected);
      expect(result.text, input).not.toContain("multi word");
    }
  });

  it("still consumes a fragment that is not recoverable JSON", () => {
    // The fragment here is not a parseable container, so it is not protected and the
    // whole remainder is consumed.
    const result = redactText("password=[redacted], notjson {a:1");
    expect(result.text).toBe("password=[redacted:uninspected]");
  });

  it("preserves a protected fragment through the structured entry points", () => {
    const input = `config {"password":[redacted],"region":"${SIBLING}"}`;
    expect(redactSerializedValue(input)).toContain(SIBLING);
    expect(redactStructuredLeaves({ note: input }).note).toContain(SIBLING);
    expect(sanitiseForDisplay(input, 10_000).text).toContain(SIBLING);
  });

  it("is idempotent for the embedded and the artifact shapes", () => {
    for (const input of [
      `config {"password":[redacted],"region":"${SIBLING}"}`,
      "log password=[redacted], multi word suffix",
      `log: {"password":[redacted],"region":"${SIBLING}"} trailing`,
    ]) {
      const once = redactText(input);
      const twice = redactText(once.text);
      expect(twice.text, input).toBe(once.text);
      expect(redactText(twice.text).text, input).toBe(once.text);
    }
  });
});

describe("a credential key is examined whole, or the assignment fails closed", () => {
  // Regression: the key lookup kept only the last 64 characters of the run, so a long
  // credential key whose sensitive prefix was earlier was read as a non-credential
  // suffix. The assignment was therefore never consumed, and its quoted value was
  // split around the `[42]` inside it — the whole credential survived.
  const VALUE = '="prefix[42]suffix"';
  const LIMIT = 256;
  /** A sensitive key of exactly `length` characters: `password.` plus filler. */
  const keyOf = (length: number): string => `password.${"z".repeat(length - "password.".length)}`;

  it("redacts the exact reported repro", () => {
    const input = `password.${"z".repeat(64)}${VALUE}`;
    const result = redactText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain("[42]");
    expect(result.text).not.toContain("suffix");
    expect(result.text).not.toContain("prefix");
    // The key is preserved; only the value is replaced.
    expect(result.text).toBe(`password.${"z".repeat(64)}=[redacted]`);
  });

  it("examines a key at the bound and fails closed one character beyond it", () => {
    // limit - 1 and limit: the run is examined in full, so the sensitive prefix is
    // recognised and the value is redacted as one unit.
    for (const length of [LIMIT - 1, LIMIT]) {
      const result = redactText(`${keyOf(length)}${VALUE}`);
      expect(result.redacted, `len=${length}`).toBe(true);
      expect(result.text, `len=${length}`).not.toContain("suffix");
      expect(result.text, `len=${length}`).not.toContain("[42]");
      expect(result.text, `len=${length}`).not.toContain("[redacted:uninspected]");
    }
    // limit + 1 and beyond: the run cannot be examined whole, so the assignment fails
    // closed instead of being classified from a truncated suffix.
    for (const length of [LIMIT + 1, LIMIT + 100]) {
      const result = redactText(`${keyOf(length)}${VALUE}`);
      expect(result.redacted, `len=${length}`).toBe(true);
      expect(result.text, `len=${length}`).not.toContain("suffix");
      expect(result.text, `len=${length}`).not.toContain("[42]");
      expect(result.text, `len=${length}`).toContain("[redacted:uninspected]");
    }
  });

  it("redacts a long key with a quoted value holding a JSON-looking fragment", () => {
    for (const [input, expected] of [
      [`${keyOf(LIMIT)}${VALUE}`, `${keyOf(LIMIT)}=[redacted]`],
      [`"${keyOf(LIMIT)}"${VALUE}`, `"${keyOf(LIMIT)}"=[redacted]`],
      [`${keyOf(LIMIT)}=prefix[42]suffix`, `${keyOf(LIMIT)}=[redacted]`],
      [`${keyOf(LIMIT)}='prefix[42]suffix'`, `${keyOf(LIMIT)}=[redacted]`],
    ] as const) {
      const result = redactText(input);
      expect(result.text, input.slice(0, 20)).toBe(expected);
    }
  });

  it("redacts a long environment-style key too", () => {
    const key = `OPENAI_KEY${"Z".repeat(246)}`;
    const result = redactText(`${key}${VALUE}`);
    expect(result.text).toBe(`${key}=[redacted]`);
  });

  it("fails closed for a long non-sensitive key rather than leaking past it", () => {
    // The run cannot be examined whole, so it is not classified — but nothing is
    // assumed about it either: the remainder is replaced.
    const result = redactText(`${`region.${"z".repeat(250)}`}${VALUE}`);
    expect(result.text).not.toContain("suffix");
    expect(result.text).toContain("[redacted:uninspected]");
  });

  it("preserves bounded work on a long-key run", () => {
    for (const n of [1_000, 10_000, 50_000]) {
      const input = `${keyOf(LIMIT)}${VALUE}${"z".repeat(n)}`;
      const started = Date.now();
      const work = redactTextWithWork(input).work;
      expect(Date.now() - started, `n=${n}`).toBeLessThan(1_000);
      expect(work.scanned, `n=${n}`).toBeLessThan(input.length * 20);
    }
  });

  it("fails closed through the structured and display entry points", () => {
    const input = `${keyOf(LIMIT + 1)}${VALUE}`;
    expect(redactSerializedValue(JSON.stringify({ note: input }))).not.toContain("suffix");
    expect(redactStructuredLeaves({ note: input }).note).not.toContain("suffix");
    expect(sanitiseForDisplay(input, 100_000).text).not.toContain("suffix");
  });

  it("is idempotent for the examined and the fail-closed shapes", () => {
    for (const input of [`${keyOf(LIMIT)}${VALUE}`, `${keyOf(LIMIT + 1)}${VALUE}`]) {
      const once = redactText(input);
      const twice = redactText(once.text);
      expect(twice.text, input.slice(0, 20)).toBe(once.text);
      expect(redactText(twice.text).text, input.slice(0, 20)).toBe(once.text);
    }
  });
});
