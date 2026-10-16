/**
 * Redaction and truncation for persisted upstream content.
 *
 * The observer stores snippets of upstream conversation and tool output. That
 * content routinely contains credentials (a shell command echoing an env var, a
 * tool reading a config file, a curl with an Authorization header), so every
 * persisted string is passed through {@link redactText} first.
 *
 * The policy is deliberately conservative: a false positive costs a redacted
 * snippet, a false negative persists a live credential in a database that the
 * dashboard renders.
 *
 * **This module is deliberately dependency-free.** It imports nothing, so it can
 * be the lowest layer of the redaction boundary: both the collector (which
 * normalises upstream content) and the persistence layer (which writes rows) use
 * it directly, and the persistence layer never has to reach into the collector —
 * or into upstream or runtime configuration — to redact a value at the point it
 * is stored. Keeping it import-free is what makes that layering enforceable
 * rather than merely conventional.
 */

export interface RedactionResult {
  readonly text: string;
  readonly redacted: boolean;
}

export interface DisplayText {
  readonly text: string;
  readonly truncated: boolean;
  readonly redacted: boolean;
}

const PLACEHOLDER = "[redacted]";

/**
 * The marker substituted for content the scanner could not inspect.
 *
 * Distinct from {@link PLACEHOLDER} on purpose. `[redacted]` says "this specific
 * value was recognised as a credential and removed". This says "the structural
 * scan gave up before it reached here, so nothing about this text has been
 * checked" — a fail-closed outcome, not a matched credential. Keeping them
 * separate means a reader (and the badge logic) can tell a bounded scan from a
 * clean result.
 */
const UNINSPECTED_MARKER = "[redacted:uninspected]";

/**
 * The replacement for a value in a *double-encoded* document: a JSON document
 * whose quotes are themselves escaped, e.g. the string
 * `{\"OPENAI_KEY\":\"…\"}`. Written in the same escaped form as the text it
 * replaces, so the surrounding document keeps the escaping level it had — the
 * result stays valid when the string it lives in is decoded.
 */
const ESCAPED_PLACEHOLDER = '\\"[redacted]\\"';

/**
 * The marker redaction substitutes for removed content.
 *
 * Exported because badge logic elsewhere has to recognise text that an *earlier*
 * build already redacted: a row repaired before the badge existed carries this
 * marker without being flagged, and a repair pass can only tell by looking for
 * it. Keeping the marker single-sourced means that detection cannot drift from
 * the substitution itself.
 */
export const REDACTION_PLACEHOLDER = PLACEHOLDER;

/**
 * The marker substituted when the structural scan hits a work or attempt limit.
 *
 * Exported so callers and tests can recognise the fail-closed outcome without
 * duplicating the literal.
 */
export const REDACTION_UNINSPECTED_MARKER = UNINSPECTED_MARKER;

/**
 * Whether text carries a redaction marker — a matched credential (`[redacted]`)
 * or a bounded scan (`[redacted:uninspected]`).
 *
 * Both count, because both mean the stored text is not the verbatim upstream
 * record: one removed a recognised credential, the other stopped inspecting. The
 * check is a substring test, not an exact match, so it also sees a marker that
 * appears inside a larger string.
 */
export function containsRedactionPlaceholder(input: string): boolean {
  return input.includes(PLACEHOLDER) || input.includes(UNINSPECTED_MARKER);
}

/**
 * Bounds on the structured (JSON-aware) redaction pass.
 *
 * The pass exists so a whole object or array value under a credential key is
 * replaced rather than missed, but it must never be able to turn a large or
 * adversarial string into quadratic work. The total characters examined across a
 * single string is capped by a work budget proportional to that string
 * ({@link JSON_SCAN_BUDGET_FACTOR}× its length, with a
 * {@link JSON_SCAN_BUDGET_FLOOR} floor), at most
 * {@link JSON_FRAGMENT_ATTEMPT_LIMIT} fragments are examined, and recursion
 * through nested structured values stops at {@link MAX_REDACTION_DEPTH} (deep
 * enough for any real payload; beyond it the subtree is redacted wholesale
 * rather than leaking).
 */
const JSON_FRAGMENT_ATTEMPT_LIMIT = 512;
const JSON_SCAN_BUDGET_FACTOR = 8;
const JSON_SCAN_BUDGET_FLOOR = 100_000;
const MAX_REDACTION_DEPTH = 20;

/**
 * The three credential-key shapes are implemented as **linear parsers**, not as
 * regular expressions, and each parser documents its own shape:
 *
 * - separator-delimited (`api_secret`, `my_secret_value`, `db_password`) —
 *   {@link isSeparatorSecretLabel};
 * - camelCase and PascalCase (`accessToken`, `clientSecret`, `SecretKey`,
 *   `secretAccessKey`) — {@link isCamelSecretLabel};
 * - environment-variable style (`OPENAI_KEY`, `GITHUB_TOKEN`, `MY_SECRET`) —
 *   {@link isEnvSecretLabel}.
 *
 * They were patterns once. Every one had repetitions that overlapped around a word
 * alternation, so a near-miss label divided the input many ways and the match grew
 * quadratically — seconds for a few tens of thousands of characters. A
 * backtracking engine cannot be bounded from outside, so each shape is now decided
 * in a single forward pass, and the rules built on them are linear passes too
 * ({@link redactKeyValues}). What must stay true is that the assignment scanner,
 * the structured-leaf property test, the escaped-document walk and the scalar
 * rules all classify a label the same way: a name is sensitive everywhere or
 * nowhere.
 */


/**
 * A scalar value in any of the forms these payloads use: bare, double-quoted,
 * single-quoted.
 *
 * The bare form excludes `[` and `]` as well as the obvious delimiters, and `{`
 * for the same reason: a structured value (`{"api_key":{"a":1}}`) must not be
 * matched as a one-character bare token, or redaction would replace the opening
 * brace alone and corrupt the JSON. A whole object or array value is handled by
 * the assignment and structured passes instead, which replace the entire balanced
 * value.
 *
 * Excluding `[`/`]` also keeps redaction idempotent: without it a later rule in
 * the same pass would match the *inside* of an earlier rule's `[redacted]` output
 * and extend it (turning one placeholder into `[redacted]]`), so running
 * redaction twice would keep changing the text.
 */
const SECRET_VALUE = "(?:\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|[^\\s,;)}\\]\\[\"'{]+(?:\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*')*)";

/** The value shapes an env-style assignment can take. */
const ENV_SECRET_VALUE = "(?:\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|[^\\s'\"\\[\\]]+(?:\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*')*)";

/**
 * The content of a string in a *double-encoded* document.
 *
 * In the escaped representation a `\"` is a string **delimiter**, not content, so
 * the content may hold any character except a quote or a backslash, plus escapes
 * that are not `\"` (`\\`, `\n`). The obvious `(?:[^"\\]|\\.)*` is wrong: it lets
 * `\"` be consumed as content, so a rule can run past the value's closing
 * delimiter, swallow the `,\"nextKey\"` that follows it, and re-emit a corrupted
 * document. That is not hypothetical — it is what made a second pass over
 * `\"api_key\":\"[redacted]\",\"n\":1}` lose `,\"n\"`.
 */
const ESCAPED_VALUE_CONTENT = "(?:[^\"\\\\]|\\\\[^\"])*";

interface Rule {
  readonly name: string;
  /**
   * A pattern rule, or absent when the rule is implemented as {@link Rule.apply}.
   *
   * A rule whose key shape has an ambiguous repetition cannot be a pattern: a
   * backtracking engine has no way to bound its own work, so the scan would be
   * quadratic however the caller charges a budget. Those rules run as a linear pass
   * instead, and sit in the same slot so the rule ordering is unchanged.
   */
  readonly pattern?: RegExp;
  readonly replacement?: string | ((...args: string[]) => string);
  readonly apply?: (input: string) => string;
}

/**
 * Order matters: rules that consume a labelled value run before the generic
 * high-entropy rules, so the label survives and the secret does not.
 */
/** Whether `ch` is an ASCII letter, digit, or underscore-free alphanumeric. */
function isAlnumChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9");
}

function isUpperLetter(ch: string): boolean {
  return ch >= "A" && ch <= "Z";
}

function isLowerOrDigit(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
}

/** Credential words that may end a camelCase key, with a run before them. */
const CAMEL_TRAILING_WORDS: readonly string[] = [
  "Secret",
  "Token",
  "Password",
  "Passwd",
  "Credential",
  "Credentials",
  "PrivateKey",
  "ApiKey",
  "APIKey",
  "apiKey",
  "Authorization",
];

/** Credential words that may follow a leading `secret`/`credential`. */
const CAMEL_COMPOUND_WORDS: readonly string[] = [
  "Key",
  "Value",
  "Token",
  "Secret",
  "Password",
  "Passwd",
  "Credential",
  "Credentials",
  "PrivateKey",
  "ApiKey",
  "APIKey",
  "apiKey",
  "Authorization",
];

/** The two leading compounds of the `secret`/`credential` branch. */
const CAMEL_LEADING_WORDS: readonly string[] = ["Secret", "secret", "Credential", "credential"];

/**
 * Whether a camelCase key names a credential, decided in one linear pass.
 *
 * This is the classifier the whole redactor shares — the assignment scanner, the
 * structured-leaf property test, the escaped document walk, and the scalar rules.
 * It replaced an equivalent regular expression whose repetitions overlapped and
 * whose cost therefore grew quadratically on a near-miss label.
 *
 * The shape, in words: either a run of alphanumerics that ends in a lowercase
 * letter or digit followed by a credential word (`accessToken`, `clientSecret`,
 * `myApiKey`) and then an optional camel run; or a leading `secret`/`credential`,
 * an optional camel run, a credential word, and an optional camel run
 * (`SecretKey`, `secretAccessKey`, `clientSecretValue`).
 *
 * The "all alphanumerics" and "optional camel run" tests are answered from
 * precomputed tables, so every candidate costs O(1) after an O(n) setup and the
 * whole classifier is O(n) in the key length. Nothing here backtracks.
 */
/** Single-run credential words of the separator-delimited key shape, lowercased. */
const SEPARATOR_SECRET_WORDS = new Set([
  // `apikey` and `privatekey` are the separator-less spellings of the two
  // `api[_-]?key` / `private[_-]?key` alternations; the joined forms are below.
  "apikey",
  "privatekey",
  "secret",
  "token",
  "password",
  "passwd",
  "credential",
  "authorization",
]);

/** The two-run credential phrases of the separator-delimited key shape. */
const SEPARATOR_SECRET_PAIRS: readonly (readonly [string, string])[] = [
  ["api", "key"],
  ["private", "key"],
];

/**
 * Whether a separator-delimited key names a credential, decided in one linear pass.
 *
 * The shape is runs of alphanumerics joined by single `_`, `.` or `-`, with a
 * credential word occupying a whole window: `api_key`, `my_secret_value`,
 * `db_password`, `private-key`. It replaced a pattern whose prefix and suffix
 * repetitions both matched alphanumeric runs around a middle alternation, which
 * divided the input many ways — a repeated label such as `"api_key."×n` cost
 * seconds and grew quadratically. Splitting on the separators once and testing the
 * runs is the same language, in linear time.
 */
export function isSeparatorSecretLabel(key: string): boolean {
  if (key.length === 0) return false;
  const runs: string[] = [];
  let current = "";
  for (let i = 0; i < key.length; i += 1) {
    const ch = key[i]!;
    if (ch === "_" || ch === "." || ch === "-") {
      // A separator must sit between two runs: no leading, trailing or doubled one.
      if (current === "") return false;
      runs.push(current);
      current = "";
      continue;
    }
    if (!isAlnumChar(ch)) return false;
    current += ch;
  }
  if (current === "") return false;
  runs.push(current);

  const lower = runs.map((run) => run.toLowerCase());
  for (const run of lower) {
    if (SEPARATOR_SECRET_WORDS.has(run)) return true;
  }
  for (let i = 0; i + 1 < lower.length; i += 1) {
    for (const [first, second] of SEPARATOR_SECRET_PAIRS) {
      if (lower[i] === first && lower[i + 1] === second) return true;
    }
  }
  return false;
}

/** The credential words an environment-style key must contain. */
const ENV_SECRET_WORDS: readonly string[] = ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL"];

/**
 * Whether an environment-style key names a credential, in one linear pass.
 *
 * The shape is an uppercase name that contains a credential word: `OPENAI_KEY`,
 * `GITHUB_TOKEN`, `MY_SECRET`. Its pattern had a leading and a trailing
 * `[A-Z0-9_]*` around the word alternation, and those two overlap, so it divided a
 * run many ways. A character check plus a substring search is the same language,
 * in linear time.
 */
export function isEnvSecretLabel(key: string): boolean {
  if (key.length === 0) return false;
  if (key[0]! < "A" || key[0]! > "Z") return false;
  for (let i = 0; i < key.length; i += 1) {
    const ch = key[i]!;
    if (!((ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_")) return false;
  }
  // The shape's leading `[A-Z]` consumes index 0, so the credential word cannot
  // start there: `KEY` is not an env-style credential label, but `XKEY` is.
  return ENV_SECRET_WORDS.some((word) => key.indexOf(word, 1) !== -1);
}

export function isCamelSecretLabel(key: string): boolean {
  const length = key.length;
  if (length === 0) return false;

  // nonAlnumBefore[i] = number of non-alphanumeric characters in key[0..i).
  const nonAlnumBefore = new Int32Array(length + 1);
  for (let i = 0; i < length; i += 1) {
    nonAlnumBefore[i + 1] = nonAlnumBefore[i]! + (isAlnumChar(key[i]!) ? 0 : 1);
  }
  const alnumRange = (from: number, to: number): boolean => nonAlnumBefore[to] === nonAlnumBefore[from];
  /** `(?:[A-Z][A-Za-z0-9]*)?$` at `from`. */
  const camelRunToEnd = (from: number): boolean =>
    from === length || (isUpperLetter(key[from]!) && alnumRange(from + 1, length));
  /** `(?:[A-Z][A-Za-z0-9]*)?` spanning exactly `[from, to)`. */
  const camelRun = (from: number, to: number): boolean =>
    from === to || (isUpperLetter(key[from]!) && alnumRange(from + 1, to));

  // Branch 1: <run ending in [a-z0-9]><word><optional camel run>
  for (const word of CAMEL_TRAILING_WORDS) {
    let from = 0;
    for (;;) {
      const at = key.indexOf(word, from);
      if (at === -1) break;
      from = at + 1;
      if (at < 1) continue;
      if (!isLowerOrDigit(key[at - 1]!)) continue;
      if (!alnumRange(0, at)) continue;
      if (camelRunToEnd(at + word.length)) return true;
    }
  }

  // Branch 2: <Secret|Credential><optional camel run><word><optional camel run>
  for (const lead of CAMEL_LEADING_WORDS) {
    if (!key.startsWith(lead)) continue;
    const afterLead = lead.length;
    for (const word of CAMEL_COMPOUND_WORDS) {
      let from = afterLead;
      for (;;) {
        const at = key.indexOf(word, from);
        if (at === -1) break;
        from = at + 1;
        if (!camelRun(afterLead, at)) continue;
        if (camelRunToEnd(at + word.length)) return true;
      }
    }
  }

  return false;
}

/** How a credential key is written in the text being scanned. */
type KeyForm = "quoted" | "escaped" | "bare";

interface KeyValueShape {
  /** Whether `ch` may appear in a key run. */
  readonly isKeyChar: (ch: string) => boolean;
  /** Whether the character before a run lets it begin a key. */
  readonly boundaryBefore: (ch: string | undefined) => boolean;
  /** The end of the whole lexical run at `start`, separators included. */
  readonly lexicalRunEnd: (input: string, start: number) => number;
  /** The end of the key run starting at `start`, trimmed so it can end a key. */
  readonly runEnd: (input: string, start: number) => number;
  /** Whether the candidate key names a credential. */
  readonly classify: (key: string) => boolean;
  /** The separator and value after a quoted key. */
  readonly quoted: RegExp;
  /** The separator and value after a bare key. */
  readonly bare: RegExp;
  /** The separator and escaped string after an escaped key. */
  readonly escaped: RegExp;
}

const CAMEL_QUOTED_VALUE = new RegExp(`^(\\s*:\\s*)${SECRET_VALUE}`);
const CAMEL_BARE_VALUE = new RegExp(`^(\\s*[:=]\\s*)${SECRET_VALUE}`);
// The content pattern is the same corrected one the other escaped rules use: the
// permissive `(?:[^"\]|\.)*` lets `\"` be consumed as content, so the match runs
// past the value's closing delimiter and swallows whatever follows it.
const CAMEL_ESCAPED_VALUE = new RegExp(`^(\\s*:\\s*)\\\\"${ESCAPED_VALUE_CONTENT}\\\\"`);
const ENV_VALUE = new RegExp(`^(\\s*=\\s*)${ENV_SECRET_VALUE}`);

/** The alphanumeric camelCase key shape. */
const CAMEL_SHAPE: KeyValueShape = {
  isKeyChar: isAlnumChar,
  boundaryBefore: (ch) => ch === undefined || !isAlnumChar(ch),
  lexicalRunEnd: (input, start) => {
    let end = start;
    while (end < input.length && isAlnumChar(input[end]!)) end += 1;
    return end;
  },
  runEnd: (input, start) => {
    let end = start;
    while (end < input.length && isAlnumChar(input[end]!)) end += 1;
    return end;
  },
  classify: isCamelSecretLabel,
  quoted: CAMEL_QUOTED_VALUE,
  bare: CAMEL_BARE_VALUE,
  escaped: CAMEL_ESCAPED_VALUE,
};

/** The separator-delimited key shape (`api_key`, `my_secret_value`). */
const SEPARATOR_SHAPE: KeyValueShape = {
  isKeyChar: (ch) => isAlnumChar(ch) || ch === "_" || ch === "." || ch === "-",
  boundaryBefore: (ch) => ch === undefined || !isAlnumChar(ch),
  lexicalRunEnd: (input, start) => {
    let end = start;
    while (end < input.length && isSeparatorKeyChar(input[end]!)) end += 1;
    return end;
  },
  runEnd: (input, start) => {
    let end = start;
    while (end < input.length && isSeparatorKeyChar(input[end]!)) end += 1;
    // A key must end with an alphanumeric, so a trailing separator is not part of it.
    while (end > start && !isAlnumChar(input[end - 1]!)) end -= 1;
    return end;
  },
  classify: isSeparatorSecretLabel,
  quoted: CAMEL_QUOTED_VALUE,
  bare: CAMEL_BARE_VALUE,
  escaped: CAMEL_ESCAPED_VALUE,
};

/** The environment-variable key shape (`OPENAI_KEY`). */
const ENV_SHAPE: KeyValueShape = {
  isKeyChar: (ch) => (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_",
  boundaryBefore: (ch) => ch === undefined || !(isAlnumChar(ch) || ch === "_"),
  lexicalRunEnd: (input, start) => {
    let end = start;
    while (end < input.length && ((input[end]! >= "A" && input[end]! <= "Z") || (input[end]! >= "0" && input[end]! <= "9") || input[end] === "_")) {
      end += 1;
    }
    return end;
  },
  runEnd: (input, start) => {
    let end = start;
    while (end < input.length && ((input[end]! >= "A" && input[end]! <= "Z") || (input[end]! >= "0" && input[end]! <= "9") || input[end] === "_")) {
      end += 1;
    }
    return end;
  },
  classify: isEnvSecretLabel,
  quoted: CAMEL_QUOTED_VALUE,
  bare: ENV_VALUE,
  escaped: CAMEL_ESCAPED_VALUE,
};

interface KeyValueHit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Match one credential key and the value that follows it.
 *
 * The key has already been classified, so this only checks the delimiters around
 * it and then the separator and value. Every test is O(1) or a bounded anchored
 * match, so the caller stays linear.
 */
function matchKeyValue(
  input: string,
  runStart: number,
  runEnd: number,
  form: KeyForm,
  shape: KeyValueShape,
): KeyValueHit | null {
  const key = input.slice(runStart, runEnd);

  if (form === "bare") {
    const value = shape.bare.exec(input.slice(runEnd));
    if (value === null) return null;
    return { start: runStart, end: runEnd + value[0].length, text: `${key}${value[1]}${PLACEHOLDER}` };
  }

  if (form === "quoted") {
    const quote = runStart > 0 ? input[runStart - 1] : undefined;
    if ((quote !== "\"" && quote !== "'") || input[runEnd] !== quote) return null;
    const value = shape.quoted.exec(input.slice(runEnd + 1));
    if (value === null) return null;
    return {
      start: runStart - 1,
      end: runEnd + 1 + value[0].length,
      text: `${quote}${key}${quote}${value[1]}${PLACEHOLDER}`,
    };
  }

  if (runStart < 2) return null;
  if (input.slice(runStart - 2, runStart) !== "\\\"" || input.slice(runEnd, runEnd + 2) !== "\\\"") return null;
  const value = shape.escaped.exec(input.slice(runEnd + 2));
  if (value === null) return null;
  return {
    start: runStart - 2,
    end: runEnd + 2 + value[0].length,
    text: `\\"${key}\\"${value[1]}\\"${PLACEHOLDER}\\"`,
  };
}

/**
 * Redact every credential key/value pair of one shape and form, in a single pass.
 *
 * The scan walks maximal key runs. A run is a candidate exactly when the shape's
 * boundary accepts what precedes it and the classifier accepts the run, and
 * maximality is what replaces a lookbehind assertion: the character before a
 * maximal run is never a key character by construction. Each run is classified in
 * O(1) amortised and its value matched with an anchored pattern, so the whole pass
 * is linear — which the equivalent regular expressions were not.
 */
function redactKeyValues(input: string, form: KeyForm, shape: KeyValueShape): string {
  let output = "";
  let copiedTo = 0;
  let i = 0;
  while (i < input.length) {
    if (!shape.isKeyChar(input[i]!) || !shape.boundaryBefore(i === 0 ? undefined : input[i - 1])) {
      i += 1;
      continue;
    }
    const runStart = i;
    // The whole lexical run, separators included. The key is the part that ends in
    // an alphanumeric, but the scan must advance past *all* of it: stepping one
    // character into a run of separators would rescan the remainder at every
    // position, which is quadratic — a 100 000-character separator run took
    // twenty seconds.
    const lexicalEnd = shape.lexicalRunEnd(input, runStart);
    const runEnd = shape.runEnd(input, runStart);
    if (runEnd <= runStart) {
      i = lexicalEnd;
      continue;
    }
    if (!shape.classify(input.slice(runStart, runEnd))) {
      i = lexicalEnd;
      continue;
    }
    const hit = matchKeyValue(input, runStart, runEnd, form, shape);
    if (hit === null) {
      i = lexicalEnd;
      continue;
    }
    output += input.slice(copiedTo, hit.start) + hit.text;
    copiedTo = hit.end;
    i = hit.end;
  }
  return copiedTo === 0 ? input : output + input.slice(copiedTo);
}

/** The camelCase rules, kept as named wrappers so the rule table reads the same. */
function redactCamelKeyValues(input: string, form: KeyForm): string {
  return redactKeyValues(input, form, CAMEL_SHAPE);
}

/** The PEM keyword and delimiter that open and close a private-key block. */
const PEM_BEGIN = "-----BEGIN ";
const PEM_END = "-----END ";
const PEM_SUFFIX = "PRIVATE KEY";
const PEM_DASHES = "-----";
const PEM_CANONICAL = `-----BEGIN PRIVATE KEY-----${PLACEHOLDER}-----END PRIVATE KEY-----`;

/** Whether `ch` may appear in a PEM label (`[A-Z0-9 ]`). */
function isPemLabelChar(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === " ";
}

/**
 * Read a PEM `[A-Z0-9 ]*PRIVATE KEY-----` marker whose label starts at `from`.
 *
 * The label run is scanned **once** and the caller advances past it, so the whole
 * pass is linear. `markerEnd` is where scanning may resume when the marker does
 * not match — past the run, never back into it — which is what stops a repeated
 * near-miss (`-----BEGIN AAAAA…`) from being rescanned from every position.
 */
function readPemMarker(input: string, from: number): { readonly end: number; readonly matched: boolean } {
  let j = from;
  while (j < input.length && isPemLabelChar(input[j]!)) j += 1;
  const run = input.slice(from, j);
  if (!run.endsWith(PEM_SUFFIX)) return { end: j, matched: false };
  if (input.slice(j, j + PEM_DASHES.length) !== PEM_DASHES) return { end: j, matched: false };
  return { end: j + PEM_DASHES.length, matched: true };
}

/**
 * Redact PEM private-key blocks in a single linear pass, and report the work.
 *
 * The rule was a pattern — `/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END
 * [A-Z0-9 ]*PRIVATE KEY-----/g` — and its `[A-Z0-9 ]*` run is retried from every
 * start position that begins `-----BEGIN `, so a repeated near-miss with no `END`
 * cost O(n²): 880 000 characters of `-----BEGIN PRIVATE KEY` took over three
 * seconds and doubled with the input. There is no way to bound a backtracking
 * engine from outside, so the block is now delimited by an explicit forward pass
 * that examines each character once.
 *
 * **Fail closed on an incomplete block.** A `BEGIN` marker with no matching `END`
 * has no delimited body, so the rest of the text is replaced by
 * {@link UNINSPECTED_MARKER} rather than kept — the body of an unterminated block
 * may be key material, and keeping it is exactly the leak this exists to prevent.
 *
 * `scanned` is the number of characters the pass examined, so a test can assert
 * the cost is linear without timing it.
 */
export function redactPrivateKeyBlocksWithWork(input: string): { readonly text: string; readonly scanned: number } {
  let output = "";
  let copiedTo = 0;
  let scanned = 0;
  let i = 0;
  while (i < input.length) {
    const beginAt = input.indexOf(PEM_BEGIN, i);
    if (beginAt === -1) break;
    scanned += beginAt - i + PEM_BEGIN.length;
    const begin = readPemMarker(input, beginAt + PEM_BEGIN.length);
    scanned += begin.end - (beginAt + PEM_BEGIN.length);
    if (!begin.matched) {
      i = Math.max(begin.end, beginAt + 1);
      continue;
    }
    // Find a matching END marker, resuming past each near-miss so the runs are
    // never rescanned.
    let endAt = -1;
    let searchFrom = begin.end;
    for (;;) {
      const candidate = input.indexOf(PEM_END, searchFrom);
      if (candidate === -1) {
        scanned += input.length - searchFrom;
        break;
      }
      scanned += candidate - searchFrom + PEM_END.length;
      const end = readPemMarker(input, candidate + PEM_END.length);
      scanned += end.end - (candidate + PEM_END.length);
      if (end.matched) {
        endAt = end.end;
        break;
      }
      searchFrom = Math.max(end.end, candidate + 1);
    }
    output += input.slice(copiedTo, beginAt);
    if (endAt === -1) {
      output += UNINSPECTED_MARKER;
      return { text: output, scanned };
    }
    output += PEM_CANONICAL;
    copiedTo = endAt;
    i = endAt;
  }
  return { text: output + input.slice(copiedTo), scanned };
}

const RULES: readonly Rule[] = [
  {
    name: "private-key-block",
    apply: (input) => redactPrivateKeyBlocksWithWork(input).text,
  },
  {
    name: "authorization-header",
    pattern: /(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `$1${PLACEHOLDER}`,
  },
  {
    name: "bearer-token",
    pattern: /\b(bearer|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replacement: `$1 ${PLACEHOLDER}`,
  },
  {
    // Credentials embedded in a URL's userinfo (`scheme://user:pass@host`).
    //
    // The **scheme** repetition is bounded, because it is the one that made the
    // rule quadratic: a greedy `[a-z0-9+.-]*` that has to be followed by `://`
    // is retried from every start position, so a long run with no delimiter cost
    // O(n²) — 110 seconds for 300,000 characters. Capping it keeps the scan linear.
    //
    // The **userinfo** repetitions are deliberately left unbounded. They are
    // guarded by the scheme, so they only run after a `://` has been found, and
    // each is stopped by the delimiters in its own character class — so the total
    // work is linear in the input. Capping them instead would be a leak: a
    // credential longer than the cap matches nothing, the engine backtracks, and
    // the whole userinfo is left in the text verbatim. The value is either consumed
    // whole or not matched at all; there is no partial redaction.
    name: "url-userinfo",
    pattern: /([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s:@]*:[^/\s@]*@/gi,
    replacement: `$1${PLACEHOLDER}@`,
  },
  {
    // Double-encoded JSON: a JSON string that itself contains JSON, which is
    // exactly what a tool input looks like after `JSON.stringify`. The quotes are
    // escaped, so the plain quoted-key rule below cannot see them.
    name: "escaped-quoted-key-secret",
    apply: (input) => redactKeyValues(input, "escaped", SEPARATOR_SHAPE),
  },
  {
    // The camelCase counterpart of the rule above: a double-encoded JSON key like
    // `\"accessToken\":\"...\"`. A linear pass, not a pattern — see {@link Rule.apply}.
    name: "camel-escaped-quoted-key-secret",
    apply: (input) => redactCamelKeyValues(input, "escaped"),
  },
  {
    // The environment-style counterpart, for a double-encoded `\"OPENAI_KEY\":\"…\"`.
    // The escaped rules used the two narrow key patterns, so an env-style label was
    // recognised in plain assignments but not in the escaped form.
    name: "env-escaped-quoted-key-secret",
    apply: (input) => redactKeyValues(input, "escaped", ENV_SHAPE),
  },
  {
    // A secret whose key is quoted, which is the form `JSON.stringify` produces.
    // Without this rule `{"api_key":"..."}` bypasses redaction entirely, because
    // the unquoted-key rule cannot match a quote between key and separator.
    name: "quoted-key-secret",
    apply: (input) => redactKeyValues(input, "quoted", SEPARATOR_SHAPE),
  },
  {
    // The camelCase counterpart of the quoted-key rule, for `{"accessToken":"..."}`.
    name: "camel-quoted-key-secret",
    apply: (input) => redactCamelKeyValues(input, "quoted"),
  },
  {
    // An unquoted key followed by `:` or `=`, as in a YAML fragment, a shell
    // assignment, or a log line. Both rules are needed: neither subsumes the
    // other's key syntax.
    name: "key-value-secret",
    apply: (input) => redactKeyValues(input, "bare", SEPARATOR_SHAPE),
  },
  {
    // The camelCase counterpart of the key-value rule, for `accessToken: value`
    // and `clientSecret=value`.
    name: "camel-key-value-secret",
    apply: (input) => redactCamelKeyValues(input, "bare"),
  },
  {
    // An environment-style assignment, with or without quotes around the value.
    // `API_KEY="secret"` must be caught as well as `API_KEY=secret`. The key shape
    // is {@link ENV_SECRET_KEY}, shared with {@link isSensitiveLabel}.
    name: "env-style-secret",
    apply: (input) => redactKeyValues(input, "bare", ENV_SHAPE),
  },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: PLACEHOLDER },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, replacement: PLACEHOLDER },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replacement: PLACEHOLDER },
  { name: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replacement: PLACEHOLDER },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g, replacement: PLACEHOLDER },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: PLACEHOLDER,
  },
  {
    name: "hex-secret",
    pattern: /\b[0-9a-fA-F]{48,}\b/g,
    replacement: PLACEHOLDER,
  },
  {
    // Mixed-case base64 blobs. Requires upper, lower and a digit so ordinary
    // long identifiers are not swallowed.
    //
    // The character-class requirements are checked on the *matched text* rather
    // than by lookaheads. They used to be `(?=[^\s]*[A-Z])` and friends, each of
    // which scans to the end of the run from every position the engine tries, so a
    // single long alphanumeric run cost O(n²) — about 110 seconds for 300,000
    // characters. Testing the match afterwards is linear and finds the same blobs.
    name: "base64-blob",
    pattern: /\b[A-Za-z0-9+/]{48,}={0,2}\b/g,
    replacement: (match: string) =>
      /[A-Z]/.test(match) && /[a-z]/.test(match) && /\d/.test(match) ? PLACEHOLDER : match,
  },
];

/**
 * How far the scanner will walk backwards to find the key that precedes a value.
 *
 * The key and the whitespace around it are short in any real payload, so a bounded
 * walk is enough — and a bound is required, because a backwards scan for a key at
 * every fragment is otherwise quadratic in the length of the preceding text.
 */
const MAX_PRECEDING_KEY_SCAN = 256;

/**
 * Whether a sensitive key immediately precedes the value at `start`.
 *
 * This replaces an unanchored pattern (`/(["']?)([A-Za-z0-9_][A-Za-z0-9_.$:-]*)\1\s*[:=]\s*$/`)
 * run over the whole preceding text. The `$` anchored the end but the engine still
 * tried every start position, and `input.slice(0, start)` copied the prefix on top
 * of that, so a long non-matching prefix before a valid fragment cost O(n²) — a
 * 100 000-character prefix took hundreds of milliseconds and doubled with the
 * input. The lookup here is a single bounded backward walk: skip the whitespace,
 * require the separator, skip more whitespace, take an optional closing quote, read
 * a bounded key run, and classify it. Nothing is copied and nothing is retried.
 *
 * The work is reported in `scanned` so the caller charges it against the pass
 * budget — an unbudgeted lookup was the second half of the defect.
 *
 * **The answer is three-valued, and the third value is load-bearing.** When the
 * walk stops because it reached the start of the input, the absence of a key is
 * *proved*, so the answer is `nonsensitive`. When it stops because the bound was
 * reached while a key or whitespace run may still continue, the answer is
 * **`unresolved`** — the walk cannot see far enough to decide. Reporting
 * `nonsensitive` there was a fail-open: a long key or a long whitespace run before
 * a valid fragment hid the credential key entirely and the value survived. The
 * caller fails closed on `unresolved` rather than treating it as "no key".
 */
type PrecedingKeyOutcome = "sensitive" | "nonsensitive" | "unresolved";

function precedingSensitiveKey(input: string, start: number): { readonly outcome: PrecedingKeyOutcome; readonly scanned: number } {
  let i = start - 1;
  let scanned = 0;
  /** Skip whitespace; `false` means the bound was reached with input still to look at. */
  const skipSpace = (): boolean => {
    while (i >= 0 && isSpaceChar(input[i]!)) {
      if (scanned >= MAX_PRECEDING_KEY_SCAN) return false;
      i -= 1;
      scanned += 1;
    }
    return true;
  };

  if (!skipSpace()) return { outcome: "unresolved", scanned };
  // The walk reached the start of the input: there is provably no key here.
  if (i < 0) return { outcome: "nonsensitive", scanned };
  const separator = input[i]!;
  if (separator !== ":" && separator !== "=") return { outcome: "nonsensitive", scanned };
  i -= 1;
  scanned += 1;
  if (!skipSpace()) return { outcome: "unresolved", scanned };
  if (i < 0) return { outcome: "nonsensitive", scanned };

  let quote = "";
  if (input[i] === "\"" || input[i] === "'") {
    quote = input[i]!;
    i -= 1;
    scanned += 1;
  }

  const keyEnd = i;
  while (i >= 0 && isKeyChar(input[i]!)) {
    if (scanned >= MAX_PRECEDING_KEY_SCAN) {
      // The key run may continue past the bound, so the label is incomplete.
      return { outcome: "unresolved", scanned };
    }
    i -= 1;
    scanned += 1;
  }
  const keyStart = i + 1;
  if (keyEnd < keyStart) return { outcome: "nonsensitive", scanned };
  if (quote !== "") {
    // A quoted key must be closed immediately before its run.
    if (i < 0 || input[i] !== quote) return { outcome: "nonsensitive", scanned };
  }
  return { outcome: isSensitiveRawKey(input.slice(keyStart, keyEnd + 1)) ? "sensitive" : "nonsensitive", scanned };
}

/** Characters that can open a JSON value the structured pass should inspect. */
function opensJsonValue(ch: string | undefined): boolean {
  return ch === "{" || ch === "[";
}

/**
 * The outcome of a bounded structural scan.
 *
 * Three states, and the difference between the last two is the whole point:
 *
 * - `matched` — the structure closed, and `end` is its last character.
 * - `unmatched` — the scan reached the *end of the input* without closing. The
 *   structure simply does not exist; there is nothing more to look at.
 * - `exhausted` — the scan hit its work budget while input remained. The
 *   structure may well exist; the scan is not allowed to keep looking.
 *
 * Collapsing `unmatched` into `exhausted` would make an ordinary stray brace fail
 * the whole value closed; collapsing `exhausted` into `unmatched` is the leak this
 * type exists to prevent — the caller would treat "I stopped early" as "there is
 * nothing here" and fall back to a partial match.
 */
interface ScanOutcome {
  readonly status: "matched" | "unmatched" | "exhausted";
  readonly end: number;
  readonly scanned: number;
}

/**
 * The character that balances the JSON value opened at `start`.
 *
 * A deliberately shallow matcher: it counts braces and brackets, skipping string
 * literals and their escapes. It does not validate the fragment — a candidate it
 * returns is handed to `JSON.parse`, which rejects anything malformed — so a
 * brace in ordinary prose costs one failed parse, never a wrong rewrite.
 *
 * `budget` caps how far it may look, so the caller can bound the total work of a
 * pass over a large or adversarial string. Every character examined is reported in
 * `scanned` so the caller can charge it, and the outcome distinguishes "no such
 * structure" from "ran out of budget".
 */
function matchJsonEnd(input: string, start: number, budget: number): ScanOutcome {
  const limit = Math.min(input.length, start + Math.max(0, budget));
  let depth = 0;
  let inString = false;
  let escaped = false;
  let i = start;
  for (; i < limit; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return { status: "matched", end: i, scanned: i - start + 1 };
    }
  }
  const scanned = i - start;
  // Either the input ended (there is no such structure) or the budget did (there
  // may be one, but the scan stopped). Those are different answers.
  return { status: limit >= input.length ? "unmatched" : "exhausted", end: -1, scanned };
}

/** `JSON.stringify`, or `null` when the value cannot be serialised. */
function stringifyJson(value: unknown): string | null {
  try {
    const out = JSON.stringify(value);
    return out === undefined ? null : out;
  } catch {
    return null;
  }
}

/**
 * What {@link redactJsonFragment} did with one balanced fragment.
 *
 * `parsed` is the load-bearing field: it records whether the fragment was valid
 * JSON. A fragment that parses is *fully handled* by the key-aware pass — even
 * when nothing changed — and must never be handed to the scalar rules, because
 * those rules rewrite `"key":"value"` into `"key":[redacted]` (a bare placeholder
 * where a JSON string belonged). That is the corruption this ordering exists to
 * prevent: once the payload is invalid JSON the structured pass can no longer
 * parse it, so every *other* credential key inside it survives.
 *
 * A fragment that does not parse is not JSON at all (`{not json}` in prose), so
 * the scalar rules remain its only treatment.
 */
interface FragmentOutcome {
  readonly parsed: boolean;
  readonly text: string;
  readonly changed: boolean;
  /** Characters examined by the bounded preceding-key lookup. */
  readonly scanned: number;
  /**
   * Whether the caller must fail closed from this fragment to the end of the input.
   *
   * Set when the preceding-key lookup could not prove that no credential key
   * precedes the fragment. Replacing only the fragment would leave whatever follows
   * it — which may be the rest of the credential's value — with no key in front of
   * it, so the whole remainder is treated as uninspected.
   */
  readonly failClosed: boolean;
}

/**
 * Parse a candidate JSON fragment, tolerating a bare redaction placeholder.
 *
 * Strict parsing is tried first, so nothing about valid JSON changes. Only when
 * that fails is the marker re-quoted and the parse retried.
 *
 * The tolerance exists for one specific, real case: a build whose scalar rules
 * ran *before* the structured pass could rewrite a scalar value inside a
 * structured payload into `"key":[redacted]` — a bare placeholder where a JSON
 * string belonged. That left the payload unparseable, so the credential the
 * payload *also* contained was never removed and is still sitting in the
 * database. Repairing the fragment is what lets the repair pass reach it.
 *
 * A repaired value is only accepted when it is a **container**. Quoting a bare
 * marker inside a payload is a repair; quoting a fragment that *is* the marker
 * (`[redacted]` on its own) is not — there is nothing inside it to redact, and
 * re-wrapping it as `"[redacted]"` would make the next pass see a string that
 * again looks like a bare marker, growing the escaping on every level. Requiring
 * a container stops that at the source. A fragment that still does not parse is
 * simply not JSON.
 */
function parseJsonFragment(
  fragment: string,
): { readonly ok: true; readonly value: unknown; readonly repaired: boolean } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(fragment), repaired: false };
  } catch {
    // Fall through to the repair attempt.
  }
  const repaired = quoteBarePlaceholders(fragment);
  if (repaired === fragment) return { ok: false };
  try {
    const value: unknown = JSON.parse(repaired);
    if (typeof value !== "object" || value === null) return { ok: false };
    return { ok: true, value, repaired: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Re-quote a bare redaction marker that appears outside a string literal.
 *
 * A bare marker is never a valid JSON value, so quoting it can only turn invalid
 * input into parseable input. The scan skips string literals and their escapes,
 * so a marker that is *already* a quoted string value is left exactly as it is.
 *
 * Both markers are handled: `[redacted]` and the fail-closed
 * `[redacted:uninspected]`. Treating only the first as repairable meant a document
 * carrying the second was not recognised as structured JSON, so the artifact
 * recovery ran over it and deleted its siblings.
 */
function quoteBarePlaceholders(fragment: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < fragment.length) {
    const ch = fragment[i];
    if (inString) {
      output += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      output += ch;
      i += 1;
      continue;
    }
    const markerLength = matchMarkerAt(fragment, i);
    if (markerLength !== -1) {
      output += `"${fragment.slice(i, i + markerLength)}"`;
      i += markerLength;
      continue;
    }
    output += ch;
    i += 1;
  }
  return output;
}

/**
 * Redact one balanced JSON fragment, key-aware.
 *
 * A sensitive key immediately preceding the fragment owns the whole value, so
 * the value is replaced outright (`accessToken: {"a":1}`). Otherwise the parsed
 * value is redacted key-aware and re-serialised only if something changed, so an
 * ordinary object is returned untouched and the surrounding text is preserved
 * verbatim.
 *
 * A fragment that only parses once a legacy bare placeholder is re-quoted is
 * re-serialised regardless: the stored text was not valid JSON, so replacing it
 * with the valid form is itself the repair.
 */
function redactJsonFragment(input: string, start: number, end: number, depth: number): FragmentOutcome {
  const original = input.slice(start, end + 1);
  const parsed = parseJsonFragment(original);
  if (!parsed.ok) return { parsed: false, text: original, changed: false, scanned: 0, failClosed: false };
  const preceding = precedingSensitiveKey(input, start);
  if (preceding.outcome === "sensitive") {
    return { parsed: true, text: PLACEHOLDER, changed: true, scanned: preceding.scanned, failClosed: false };
  }
  if (preceding.outcome === "unresolved") {
    // The lookup could not see far enough to prove that no credential key precedes
    // this fragment. The fragment's value may continue past it, so the caller fails
    // closed over the whole remainder — replacing only the fragment would leave the
    // rest of a possible credential with no key in front of it.
    return {
      parsed: true,
      text: UNINSPECTED_MARKER,
      changed: true,
      scanned: preceding.scanned,
      failClosed: true,
    };
  }
  const after = stringifyJson(redactStructuredLeaves(parsed.value, undefined, depth + 1));
  if (after === null) return { parsed: true, text: original, changed: false, scanned: preceding.scanned, failClosed: false };
  if (parsed.repaired) {
    return { parsed: true, text: after, changed: after !== original, scanned: preceding.scanned, failClosed: false };
  }
  const before = stringifyJson(parsed.value);
  if (before === null || before === after) {
    return { parsed: true, text: original, changed: false, scanned: preceding.scanned, failClosed: false };
  }
  return { parsed: true, text: after, changed: true, scanned: preceding.scanned, failClosed: false };
}

/**
 * How far the scanner will read a credential key.
 *
 * Bounds the key lookup to constant work, so a long or adversarial string cannot
 * turn the scan quadratic. Real keys are far shorter; the bound is generous enough
 * that a realistic compound label is examined **in full**.
 *
 * The bound is not a truncation point. A run that reaches it may continue past it,
 * so the label cannot be classified from what was read — the lookup fails closed
 * instead (see {@link matchCredentialAssignment}). Reading only the last
 * {@link MAX_ASSIGNMENT_KEY_CHARS} characters is what let a long credential key
 * hide behind a non-credential suffix.
 */
const MAX_ASSIGNMENT_KEY_CHARS = 256;

/**
 * Capacity of the recent-non-space ring.
 *
 * Enough for a maximum-length key, the quote that may delimit it, and slack.
 */
const NON_SPACE_HISTORY = MAX_ASSIGNMENT_KEY_CHARS + 8;

/** Characters that end a bare (unquoted) value. */
const BARE_VALUE_TERMINATORS = new Set([" ", "\t", "\n", "\r", "\f", "\v", ",", ";", ")", "}", "\"", "'"]);

function isSpaceChar(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

/** The key charset {@link PRECEDING_SECRET_KEY} accepts. */
function isKeyChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "." || ch === "$" || ch === ":" || ch === "-";
}

/**
 * The indices of the most recent non-whitespace characters, newest first.
 *
 * This is what makes the assignment check forward-only. Resolving "is the value
 * at `i` part of a credential assignment?" needs the character *before* the
 * whitespace that preceded `i` — and, for `key = value`, one before that too. A
 * backwards scan for either is unbounded: 200,000 spaces turn it into ~2×10¹⁰
 * character comparisons. Instead the ring is appended to as the scanner moves
 * forward, so both lookups are O(1) and the whitespace is never walked twice.
 *
 * Capacity is a constant, so the ring can answer only about the last
 * {@link NON_SPACE_HISTORY} non-space characters. That is deliberate and matches
 * {@link MAX_ASSIGNMENT_KEY_CHARS}: a "key" longer than that is not a credential
 * label, and refusing to resolve it costs nothing.
 */
class NonSpaceHistory {
  private readonly indices = new Int32Array(NON_SPACE_HISTORY);
  private head = 0;
  private size = 0;

  push(index: number): void {
    this.indices[this.head] = index;
    this.head = (this.head + 1) % NON_SPACE_HISTORY;
    if (this.size < NON_SPACE_HISTORY) this.size += 1;
  }

  /** The `k`-th most recent index (`0` is the most recent), or `-1` if unknown. */
  back(k: number): number {
    if (k < 0 || k >= this.size) return -1;
    return this.indices[(this.head - 1 - k + NON_SPACE_HISTORY * 2) % NON_SPACE_HISTORY]!;
  }
}

/** The quoted string that opens at `start`, scanned within `budget`. */
function matchQuotedEnd(input: string, start: number, budget: number): ScanOutcome {
  const quote = input[start];
  let i = start + 1;
  let scanned = 1;
  while (i < input.length) {
    if (scanned >= budget) return { status: "exhausted", end: -1, scanned };
    const ch = input[i]!;
    if (ch === "\\") {
      i += 2;
      scanned += 2;
      continue;
    }
    if (ch === quote) return { status: "matched", end: i, scanned };
    i += 1;
    scanned += 1;
  }
  return { status: "unmatched", end: -1, scanned };
}

interface AssignmentOutcome {
  readonly status: "matched" | "none" | "exhausted";
  readonly end: number;
  readonly scanned: number;
}

/**
 * A complete credential assignment whose value starts at `i`, if there is one.
 *
 * This is the fix for a whole class of leak: a credential assignment whose value
 * merely *looks* like JSON. Given `password="correct[42]horse"`, the structural
 * scanner used to see the `[` inside the quoted value, treat `[42]` as a JSON
 * fragment, and split the assignment in two — the opening quote landed in the
 * "gap" and the closing quote in the tail, so neither the scalar rules (which
 * need a whole quoted value) nor the structured pass (whose fragment was only
 * `[42]`) could see the credential. `clientSecret='{"value":"…"}'` and
 * `OPENAI_KEY="…"` failed the same way. Consuming the whole assignment value as
 * one unit, *before* any nested fragment is considered, removes the credential
 * regardless of what its text contains.
 *
 * Three outcomes, and the distinction matters:
 *
 * - `matched` — a value was delimited, and `end` is its last character.
 * - `none` — there is no credential assignment starting here.
 * - `exhausted` — a credential assignment *was* recognised but its value could not
 *   be delimited within the remaining budget, or it opens a structure that never
 *   closes. The caller must fail closed: a partial match here is exactly the bug
 *   this returns `exhausted` to prevent. Consuming "the value" as a truncated
 *   token would leave the rest of the real value in the text with no key in front
 *   of it, which no rule would then recognise — the original leak, reproduced.
 *
 * Every character and ring lookup is reported in `scanned`, so the caller charges
 * the whole cost against the pass budget. That includes the separators, the key,
 * the container, the quote, and the bare-token scan.
 *
 * A plain bare value (`password=abc`) is deliberately **not** consumed: the scalar
 * rules already handle it, and consuming just the first whitespace-delimited word
 * would strand the rest of a multi-word value (an `Authorization: Bearer …` header
 * would keep its token). A bare value is only consumed when it contains a brace or
 * bracket, i.e. when it is itself structural — the case the scalar rules cannot
 * reach.
 */
function matchCredentialAssignment(
  input: string,
  i: number,
  history: NonSpaceHistory,
  budget: number,
): AssignmentOutcome {
  let scanned = 1;
  const separatorIndex = history.back(0);
  if (separatorIndex < 0) return { status: "none", end: -1, scanned };
  const separator = input[separatorIndex];
  if (separator !== ":" && separator !== "=") return { status: "none", end: -1, scanned };

  const keyLast = history.back(1);
  scanned += 1;
  if (keyLast < 0) return { status: "none", end: -1, scanned };

  const last = input[keyLast]!;
  let key: string | null = null;
  if (last === "\"" || last === "'") {
    // A quoted key (`"password":`): walk back through the ring to the opening quote.
    // A quote beyond the bound leaves the label unexamined, so the assignment fails
    // closed rather than being classified from a truncated suffix.
    for (let k = 2; k < NON_SPACE_HISTORY; k += 1) {
      scanned += 1;
      const at = history.back(k);
      if (at < 0) break;
      if (input[at] === last) {
        key = input.slice(at + 1, keyLast);
        break;
      }
      if (keyLast - at > MAX_ASSIGNMENT_KEY_CHARS + 2) {
        return { status: "exhausted", end: -1, scanned };
      }
    }
  } else if (isKeyChar(last)) {
    // An unquoted key: the contiguous run of key characters ending here.
    //
    // The run is examined **in full**, and only in full. The ring holds the last
    // {@link NON_SPACE_HISTORY} non-space characters, so a run that reaches the bound
    // may continue past it and the label cannot be classified. Classifying the
    // *suffix* is exactly the leak this avoids: `password.` + `z`.repeat(64) was read
    // as a run of `z`s — a non-credential label — so the assignment was never
    // consumed and its value was split at the `[42]` inside it. A run that cannot be
    // examined whole fails closed instead of being classified from what was read.
    let start = keyLast;
    for (let k = 2; k < NON_SPACE_HISTORY; k += 1) {
      scanned += 1;
      const at = history.back(k);
      // `-1` means the ring holds no earlier non-space character, so the run
      // genuinely begins at the start of the input.
      if (at < 0) break;
      if (!isKeyChar(input[at]!) || at !== start - 1) break;
      start = at;
      if (keyLast - start + 1 > MAX_ASSIGNMENT_KEY_CHARS) {
        return { status: "exhausted", end: -1, scanned };
      }
    }
    key = input.slice(start, keyLast + 1);
  }
  if (key === null || !isSensitiveRawKey(key)) return { status: "none", end: -1, scanned };

  const remaining = budget - scanned;
  if (remaining <= 0) return { status: "exhausted", end: -1, scanned };

  const first = input[i]!;
  if (first === "\"" || first === "'") {
    const quoted = matchQuotedEnd(input, i, remaining);
    scanned += quoted.scanned;
    // An unterminated quote is not a delimited value; delimit or fail closed.
    if (quoted.status !== "matched") return { status: "exhausted", end: -1, scanned };
    // A closing quote proves only that the *quoted segment* ended, not that the
    // assignment did: `password="abc"opaque` and `password="abc""def"` both
    // continue past it. Accept the value only when a real follower terminates it,
    // or the continuation would be stranded with no key in front of it.
    if (!isAssignmentValueBoundary(input, quoted.end + 1, input.length)) {
      return { status: "exhausted", end: -1, scanned };
    }
    if (isAmbiguousCommaFollower(input, quoted.end + 1, input.length)) {
      return { status: "exhausted", end: -1, scanned };
    }
    return { status: "matched", end: quoted.end, scanned };
  }
  if (first === "{" || first === "[") {
    // A container value is delimited by pairing, not by the first closer: `[1,2}`
    // is not a container. It must also be followed by something that may follow a
    // value, or `password=[1,2]opaque-suffix` would consume the array and leave the
    // suffix with no key in front of it.
    const containerEnd = scanEscapedContainer(input, i, input.length);
    if (containerEnd === -1) return { status: "exhausted", end: -1, scanned };
    scanned += containerEnd - i;
    if (!isAssignmentValueBoundary(input, containerEnd, input.length)) return { status: "exhausted", end: -1, scanned };
    if (isAmbiguousCommaFollower(input, containerEnd, input.length)) {
      return { status: "exhausted", end: -1, scanned };
    }
    return { status: "matched", end: containerEnd - 1, scanned };
  }

  // A value that opens an escaped string (`\"…\"`) is the escaped representation of
  // a quoted value, which the escaped scalar rules own. Treating its leading `\` as
  // a bare token would either strand the string or fail the whole value closed, so
  // it is not a bare value at all.
  if (isEscapedStringStart(input, i)) return { status: "none", end: -1, scanned };

  let end = i;
  while (end < input.length && end - i < remaining && !BARE_VALUE_TERMINATORS.has(input[end]!)) end += 1;
  const consumed = end - i;
  scanned += consumed;
  if (end < input.length && consumed >= remaining) {
    // The budget ran out mid-token, so the value may continue past what was read.
    return { status: "exhausted", end: -1, scanned };
  }
  // A quote immediately after the token is an ambiguous continuation: the bare
  // token may be only the prefix of a quoted value (`password=prefix"secret"`), so
  // accepting it would strand the quoted part with no key in front of it. Fail
  // closed rather than keep a partial value.
  if (end < input.length && (input[end] === "\"" || input[end] === "'")) {
    return { status: "exhausted", end: -1, scanned };
  }
  const token = input.slice(i, end);
  if (consumed === 0 || (!token.includes("{") && !token.includes("["))) {
    return { status: "none", end: -1, scanned };
  }
  return { status: "matched", end: end - 1, scanned };
}

/**
 * Redact one span of text: credential assignments and JSON fragments key-aware,
 * everything else by rule.
 *
 * The scan walks the input forward once, and at each position first checks for a
 * complete credential assignment ({@link matchCredentialAssignment}) and then for
 * a balanced JSON value. Either is consumed as a unit and skipped, so a nested
 * fragment can never split a credential's value away from its key.
 *
 * That ordering is the whole point. Running the scalar rules first used to
 * rewrite a scalar credential inside a structured payload into a bare
 * `[redacted]`, which made the fragment unparseable; the structured pass then
 * found nothing to fix, so a sibling credential under another key survived. Here
 * a parsed fragment is never exposed to the scalar rules, so one rule can never
 * corrupt the JSON that another rule depends on.
 *
 * **Bounded, and fail-closed.** Every character examined — the forward walk, the
 * whitespace resolution (through {@link NonSpaceHistory}, never a backwards scan),
 * the key, the quote, the container, the bare token — is charged against a work
 * budget proportional to the input, and at most {@link JSON_FRAGMENT_ATTEMPT_LIMIT}
 * fragments are examined. When any cap is reached, or when a recognised value
 * cannot be delimited within the remaining budget, the uninspected remainder is
 * replaced by {@link UNINSPECTED_MARKER} rather than being kept raw: a structure
 * the scanner never reached may hold a credential, and keeping it would be a
 * silent leak.
 */
/** Whether an escaped string (`\"`) opens at `p`. */
function isEscapedStringStart(input: string, p: number): boolean {
  return input[p] === "\\" && input[p + 1] === "\"";
}

/**
 * The exclusive end of the escaped string opening at `start`, or `-1`.
 *
 * The subtlety is that in the escaped representation a `\` may itself be escaped,
 * so a `\"` is a **delimiter** only when the backslashes before it are balanced —
 * otherwise it is a quote *inside* the value. Reading `\"` as a delimiter
 * unconditionally is wrong: it makes `\"first\\\"opaque-suffix\"` look like the
 * string `first\` followed by trailing junk, so a credential's tail escapes the
 * value that was redacted and survives.
 *
 * So the scan simulates the decoded document rather than guessing from the
 * escaped one: `\\` contributes a decoded backslash, `\"` a decoded quote, and a
 * decoded quote is a delimiter exactly when the decoded backslashes before it are
 * even. The text is never actually decoded — only the parity is tracked — so the
 * escaping level of everything outside the string is preserved.
 */
function scanEscapedString(input: string, start: number, limit: number): number {
  let i = start + 2;
  let pendingBackslashes = 0;
  while (i < limit) {
    const ch = input[i]!;
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === "\\") {
        pendingBackslashes += 1;
        i += 2;
        continue;
      }
      if (next === "\"") {
        if (pendingBackslashes % 2 === 0) return i + 2;
        pendingBackslashes = 0;
        i += 2;
        continue;
      }
      pendingBackslashes = 0;
      i += 2;
      continue;
    }
    if (ch === "\"") {
      if (pendingBackslashes % 2 === 0) return i + 1;
      pendingBackslashes = 0;
      i += 1;
      continue;
    }
    pendingBackslashes = 0;
    i += 1;
  }
  return -1;
}

/**
 * Decode an escaped string's content, for label classification only.
 *
 * `\"` becomes `"` and `\\` becomes `\`; every other escape is left alone. The
 * result is never written back to the text — it exists so a key can be compared
 * against the classifier, which is why it is safe for it to be lossy.
 */
function decodeEscapedString(content: string): string {
  let output = "";
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === "\\") {
      const next = content[i + 1];
      if (next === "\"") {
        output += "\"";
        i += 1;
        continue;
      }
      if (next === "\\") {
        output += "\\";
        i += 1;
        continue;
      }
    }
    output += content[i];
  }
  return output;
}

/**
 * Whether key text carries an escape {@link decodeEscapedString} does not decode.
 *
 * The decoder handles only `\"` and `\\`, so a key written with any other escape
 * stays spelled with a backslash — `access\u0054oken` does not decode to
 * `accessToken`, so a credential under it was never classified and its value
 * survived. The escape cannot be resolved here (resolving `\uXXXX` would mean
 * changing the decoder, and the decoder's output is spliced back into the raw text
 * by offset, so it must stay byte-faithful), and guessing wrong in the permissive
 * direction is a leak. So an unresolved escape is treated as **evidence the key is
 * a credential**.
 *
 * `\\` and `\"` are the handled escapes, so a fully-handled pair is not itself
 * evidence; whether the *decoded* result still carries an escape is a separate
 * layer, which {@link isSensitiveRawKey} checks.
 */
function hasUnhandledEscape(content: string): boolean {
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] !== "\\") continue;
    const next = content[i + 1];
    if (next === "\"" || next === "\\") {
      i += 1;
      continue;
    }
    return true;
  }
  return false;
}

/**
 * How many decoding layers a key may be examined through before it fails closed.
 *
 * A key can be escaped more than once (`JSON.stringify(JSON.stringify(…))`), and
 * each layer can hide an escape the previous one exposed: `\\u0054` is a handled
 * `\\` at the first layer and an unresolved `\u0054` at the second. The bound keeps
 * the examination linear; a key that is still changing at the cap is treated as
 * sensitive rather than trusted.
 */
const MAX_KEY_DECODE_LAYERS = 4;

/**
 * Whether a key is sensitive, conservatively, at every decoding layer.
 *
 * A name is sensitive when it names a credential by any known shape, **or** when it
 * carries an escape the decoder cannot resolve at any layer it is examined through.
 * The second clause is what closes the nested-escape leak: a key written
 * `access\\u0054oken` is a handled `\\` followed by text at the first layer, but
 * decoding once exposes `access\u0054oken`, whose `\u0054` is unresolved — so the
 * key is treated as a credential and its value removed whole. The raw key spelling
 * and every unrelated byte are untouched; only the value is replaced.
 *
 * This is the one classification every key site shares, so a key is treated the
 * same wherever it appears — as a JSON property name, an escaped-document key, or
 * an assignment label.
 */
function isSensitiveRawKey(rawContent: string): boolean {
  let text = rawContent;
  for (let layer = 0; layer < MAX_KEY_DECODE_LAYERS; layer += 1) {
    if (hasUnhandledEscape(text) || isSensitiveLabel(text)) return true;
    const decoded = decodeEscapedString(text);
    if (decoded === text) return false;
    text = decoded;
  }
  // Still decoding at the cap: an escape may be hidden at a deeper layer, so fail
  // closed rather than trust it.
  return true;
}

/**
 * Decode an escaped string's content together with a map back to the raw text.
 *
 * `map[i]` is the index in the raw content of decoded character `i`, and the final
 * entry is the raw length. The map exists so a nested repair can be spliced back
 * into the raw content at exactly the right offsets: everything outside the
 * repaired span keeps its original escaping byte for byte, which re-encoding the
 * whole string would not guarantee.
 */
function decodeEscapedStringMapped(content: string): { readonly text: string; readonly map: number[] } {
  let text = "";
  const map: number[] = [];
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === "\\") {
      const next = content[i + 1];
      if (next === "\"") {
        map.push(i);
        text += "\"";
        i += 1;
        continue;
      }
      if (next === "\\") {
        map.push(i);
        text += "\\";
        i += 1;
        continue;
      }
    }
    map.push(i);
    text += content[i];
  }
  map.push(content.length);
  return { text, map };
}

/** Re-escape replacement text for the content of an escaped string. */
function escapeEscapedContent(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** One replaced range of an escaped document, in that document's coordinates. */
interface EscapedEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * The end of a *double-encoded* JSON document opened at `start`.
 *
 * A JSON document that has been through `JSON.stringify` twice has its string
 * quotes escaped (`\"`), so {@link matchJsonEnd} — which treats `"` as the string
 * terminator — sees an unterminated string and never finds the close. This matcher
 * reads the escaped form instead, skipping strings with {@link scanEscapedString}
 * and counting the unescaped braces and brackets between them.
 *
 * It only reports `matched` when the span actually contains an escaped quote. A
 * plain fragment that merely failed to parse is not an escaped document, and
 * saying so here keeps the ordinary path in charge of it.
 */
function matchEscapedJsonEnd(input: string, start: number, budget: number): EscapedFragmentScan {
  const limit = Math.min(input.length, start + Math.max(0, budget));
  const stack: string[] = [];
  let sawEscapedQuote = false;
  let i = start;
  while (i < limit) {
    if (isEscapedStringStart(input, i)) {
      const stringEnd = scanEscapedString(input, i, limit);
      if (stringEnd === -1) break;
      sawEscapedQuote = true;
      i = stringEnd;
      continue;
    }
    const ch = input[i];
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      const open = stack.pop();
      if ((ch === "}" && open !== "{") || (ch === "]" && open !== "[")) break;
      if (stack.length === 0) {
        if (!sawEscapedQuote) break;
        return { status: "matched", end: i, scanned: i - start + 1 };
      }
    }
    i += 1;
  }
  const scanned = i - start;
  if (limit < input.length) return { status: "exhausted", end: -1, scanned };
  if (!sawEscapedQuote) return { status: "unmatched", end: -1, scanned };
  // Escaped content was seen but the document never closes — a truncated or
  // malformed payload. It is still worth walking, because a credential under a key
  // inside it must be delimited and, failing that, must fail closed; the walk ends
  // at the last character of the input.
  return { status: "unterminated", end: input.length - 1, scanned };
}

interface EscapedFragmentScan {
  readonly status: "matched" | "unterminated" | "unmatched" | "exhausted";
  /** The last character of the fragment, when `matched` or `unterminated`. */
  readonly end: number;
  readonly scanned: number;
}

/** A well-formed JSON number, as the escaped document's grammar allows. */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Whether `index` can legitimately follow a complete JSON value.
 *
 * A primitive is only *matched* when something that may follow it does. Without
 * that check a malformed value is consumed up to its first non-primitive
 * character and the rest is left in the text — `{\"password\":123opaque-secret}`
 * would redact `123` and leave `opaque-secret}` with no key in front of it, which
 * is the leak the check exists to prevent.
 */
function isEscapedValueBoundary(input: string, index: number, limit: number): boolean {
  if (index >= limit) return true;
  const ch = input[index]!;
  return isSpaceChar(ch) || ch === "," || ch === "}" || ch === "]";
}

/**
 * The index just past a container's matching closer, or `-1` when unbalanced or
 * mismatched.
 *
 * Braces and brackets inside a **string** are content, not structure, so both
 * string representations are skipped: the escaped form (`\"…\"`) and the ordinary
 * quoted form (`"…"`). Skipping only the escaped form is what let a brace inside a
 * plain JSON string close the container early —
 * `password={"value":"},opaque-live-value"}` ended the value at the brace in
 * `"}"`, and the tail survived with no key in front of it. An unterminated string
 * is not a delimited container, so the scan reports `-1` and the caller fails
 * closed.
 */
function scanEscapedContainer(input: string, start: number, limit: number): number {
  const stack: string[] = [];
  let j = start;
  while (j < limit) {
    if (isEscapedStringStart(input, j)) {
      const stringEnd = scanEscapedString(input, j, limit);
      if (stringEnd === -1) return -1;
      j = stringEnd;
      continue;
    }
    if (input[j] === "\"" || input[j] === "'") {
      // An ordinary quoted string in the plain representation.
      const quoted = matchQuotedEnd(input, j, limit - j);
      if (quoted.status !== "matched") return -1;
      j = quoted.end + 1;
      continue;
    }
    const ch = input[j]!;
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      j += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      const open = stack.pop();
      // A closer must match the opener it closes; `[1,2}` is not a container.
      if ((ch === "}" && open !== "{") || (ch === "]" && open !== "[")) return -1;
      if (stack.length === 0) return j + 1;
      j += 1;
      continue;
    }
    j += 1;
  }
  return -1;
}

interface EscapedValueSpan {
  readonly status: "matched" | "malformed" | "exhausted";
  /** Exclusive end of the value, when `matched`. */
  readonly end: number;
  readonly scanned: number;
}

/**
 * Delimit one complete JSON value in the escaped representation.
 *
 * The escaped form carries the same value grammar as JSON, just written with
 * escaped quotes: a string (`\"…\"`), a number, `true`/`false`/`null`, or an array
 * or object whose members are any of those, nested. Every one of them has to be
 * delimited here, because a credential's value is whatever the author put under
 * the key — and a primitive array such as `[17,23,42,91]` contains no escaped
 * quote at all, so a matcher that looks for one never finds the end and leaves the
 * value in place.
 *
 * Anything that is not completely delimited — an unterminated string, an
 * unbalanced container, a run that stops at the work limit — is reported as
 * `malformed` or `exhausted` so the caller can fail closed. There is no partial
 * answer: a half-consumed value is the leak this exists to prevent.
 */
function delimitEscapedValue(input: string, start: number, budget: number): EscapedValueSpan {
  const limit = Math.min(input.length, start + Math.max(0, budget));
  let i = start;
  while (i < limit && isSpaceChar(input[i]!)) i += 1;
  const scannedBase = i - start;
  if (i >= limit) {
    return { status: limit >= input.length ? "malformed" : "exhausted", end: -1, scanned: scannedBase };
  }

  if (isEscapedStringStart(input, i)) {
    const end = scanEscapedString(input, i, limit);
    if (end === -1) {
      return { status: limit >= input.length ? "malformed" : "exhausted", end: -1, scanned: limit - start };
    }
    // A closing `\"` delimits the *string*, not the assignment: the value may
    // continue past it (`\"abc\"opaque`), so a real follower must terminate it.
    if (!isEscapedValueBoundary(input, end, limit)) {
      return { status: limit >= input.length ? "malformed" : "exhausted", end: -1, scanned: end - start };
    }
    return { status: "matched", end, scanned: end - start };
  }

  const first = input[i]!;
  if (first === "{" || first === "[") {
    const end = scanEscapedContainer(input, i, limit);
    if (end === -1) {
      return { status: limit >= input.length ? "malformed" : "exhausted", end: -1, scanned: limit - start };
    }
    // A matching closer delimits the *container*, not the assignment: a suffix
    // (`[1,2]opaque`) would be stranded, so require a real follower.
    if (!isEscapedValueBoundary(input, end, limit)) {
      return { status: limit >= input.length ? "malformed" : "exhausted", end: -1, scanned: end - start };
    }
    return { status: "matched", end, scanned: end - start };
  }

  if (first === "-" || (first >= "0" && first <= "9")) {
    let j = i;
    while (j < limit && /[0-9eE+.\-]/.test(input[j]!)) j += 1;
    // The token has to be a complete JSON number *and* be followed by something
    // that may follow a value. `123opaque-secret` is neither.
    if (!JSON_NUMBER.test(input.slice(i, j)) || !isEscapedValueBoundary(input, j, limit)) {
      return { status: "malformed", end: -1, scanned: j - start };
    }
    return { status: "matched", end: j, scanned: j - start };
  }

  for (const literal of ["true", "false", "null"]) {
    if (input.startsWith(literal, i)) {
      const end = i + literal.length;
      // `trueopaque-secret` must not be read as the literal `true`.
      if (!isEscapedValueBoundary(input, end, limit)) {
        return { status: "malformed", end: -1, scanned: end - start };
      }
      return { status: "matched", end, scanned: end - start };
    }
  }

  return { status: "malformed", end: -1, scanned: i - start };
}

interface EscapedFragmentOutcome {
  readonly status: "matched" | "malformed" | "exhausted";
  readonly text: string;
  readonly changed: boolean;
  readonly scanned: number;
  /** Every replacement applied, in document coordinates. */
  readonly edits: readonly EscapedEdit[];
}

/**
 * Whether a `,` at `index` is followed by something that cannot be a sibling.
 *
 * A comma is a valid follower only when a real sibling follows it. `, x` is a
 * sibling; `,x` immediately followed by value text is ambiguous — the comma may
 * belong to the *inside* of a container the scanner stopped short of, which is
 * exactly the shape the old partial redaction left behind
 * (`password=[redacted],opaque-live-value"}`). Treating it as a terminator is how
 * that artifact stayed intact, so an ambiguous comma is not accepted as a boundary.
 */
function isAmbiguousCommaFollower(input: string, index: number, limit: number): boolean {
  if (index >= limit || input[index] !== ",") return false;
  const next = index + 1;
  if (next >= limit) return false;
  const ch = input[next]!;
  return !isSpaceChar(ch) && ch !== "}" && ch !== "]";
}

/**
 * Whether a completed assignment value may be followed by `index`.
 *
 * A value is only accepted when what follows it can legitimately follow a JSON
 * value — whitespace, a comma, a closing bracket or brace, or the end of the span.
 * Without the check `password=[1,2]opaque-suffix` consumed the array and left
 * `opaque-suffix` behind with no key in front of it, which is the leak this exists
 * to prevent.
 *
 * A quote is deliberately **not** a boundary. A closing quote only proves the
 * *quoted segment* ended, not the assignment: `password="abc"opaque` and
 * `password="abc""def"` both continue past the quote, so accepting it would
 * consume `"abc"` and strand the rest with no key in front of it. There is no
 * enclosing-context information here that could tell an adjacent quoted segment
 * from a continuation, so an ambiguous follower fails closed rather than being
 * treated as a terminator.
 */
function isAssignmentValueBoundary(input: string, index: number, limit: number): boolean {
  if (index >= limit) return true;
  const ch = input[index]!;
  return isSpaceChar(ch) || ch === "," || ch === "}" || ch === "]";
}

/**
 * Delimit one complete assignment value at the escaped level.
 *
 * The grammar is the whole assignment grammar, not just a scalar: an escaped
 * string, a quoted string, a container (pairing validated), or a bare token that
 * may itself contain braces or brackets — the shape the scalar value patterns
 * cannot express, which is why `password=correct[42]horse` used to be consumed up
 * to the `[`. A value that is not completely delimited, or that is not followed by
 * a valid boundary, is reported so the caller fails closed.
 */
function delimitAssignmentValue(
  input: string,
  start: number,
  limit: number,
  budget: number,
): EscapedValueSpan {
  if (start >= limit) return { status: "malformed", end: -1, scanned: 0 };

  if (isEscapedStringStart(input, start)) {
    const end = scanEscapedString(input, start, limit);
    if (end === -1) return { status: "malformed", end: -1, scanned: 0 };
    if (!isAssignmentValueBoundary(input, end, limit)) return { status: "malformed", end: -1, scanned: end - start };
    return { status: "matched", end, scanned: end - start };
  }

  const first = input[start]!;
  if (first === "\"" || first === "'") {
    const quoted = matchQuotedEnd(input, start, budget);
    if (quoted.status !== "matched") {
      return { status: quoted.status === "exhausted" ? "exhausted" : "malformed", end: -1, scanned: quoted.scanned };
    }
    const end = quoted.end + 1;
    if (!isAssignmentValueBoundary(input, end, limit)) return { status: "malformed", end: -1, scanned: end - start };
    return { status: "matched", end, scanned: quoted.scanned };
  }

  if (first === "{" || first === "[") {
    const end = scanEscapedContainer(input, start, limit);
    if (end === -1) return { status: limit >= input.length ? "malformed" : "exhausted", end: -1, scanned: 0 };
    if (!isAssignmentValueBoundary(input, end, limit)) return { status: "malformed", end: -1, scanned: end - start };
    return { status: "matched", end, scanned: end - start };
  }

  // A bare token, consumed to a delimiter so a bracketed fragment stays part of the
  // value. It is accepted only when it actually reaches a boundary, so a truncated
  // value fails closed instead of leaving its tail behind.
  let end = start;
  // Brackets are part of a bare token: stopping at the first `]` would consume
  // `correct[42` out of `correct[42]horse` and leave the tail behind.
  while (end < limit && end - start < budget && !BARE_VALUE_TERMINATORS.has(input[end]!)) {
    end += 1;
  }
  const scanned = end - start;
  if (end - start >= budget && end < limit) return { status: "exhausted", end: -1, scanned };
  if (end === start) return { status: "malformed", end: -1, scanned: 0 };
  if (!isAssignmentValueBoundary(input, end, limit)) return { status: "malformed", end: -1, scanned };
  return { status: "matched", end, scanned };
}

/** The separator and value that may follow a bare key at the escaped level. */

/** Whether `ch` may appear in a separator-delimited key run. */
function isSeparatorKeyChar(ch: string): boolean {
  return isAlnumChar(ch) || ch === "_" || ch === "." || ch === "-";
}

/**
 * The spans of `[start, limit)` that no edit covers, in order.
 *
 * Used to guarantee that a fragment is only reported as handled once *every* span
 * has been checked: the edits cover what the structural walk took ownership of,
 * and this is what is left for the scalar rules.
 */
function complementSpans(
  start: number,
  limit: number,
  covered: readonly EscapedEdit[],
): { readonly start: number; readonly end: number }[] {
  const ordered = [...covered].sort((left, right) => left.start - right.start || left.end - right.end);
  const spans: { start: number; end: number }[] = [];
  let cursor = start;
  for (const span of ordered) {
    if (span.start > cursor) spans.push({ start: cursor, end: span.start });
    if (span.end > cursor) cursor = span.end;
  }
  if (cursor < limit) spans.push({ start: cursor, end: limit });
  return spans;
}

/** Render ordered, non-overlapping edits over `[start, limit)`. */
function renderEscapedEdits(input: string, start: number, limit: number, edits: readonly EscapedEdit[]): string {
  let output = "";
  let cursor = start;
  for (const edit of edits) {
    output += input.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return output + input.slice(cursor, limit);
}

/**
 * Redact the content of one escaped string, in its own encoded document.
 *
 * A nested payload is the normal shape of a serialised tool input: the outer
 * document holds a string whose *content* is itself an encoded document
 * (`JSON.stringify(JSON.stringify(…))`), and the credential can be inside it.
 *
 * The content is decoded once with an offset map, walked by
 * {@link redactEscapedFragment} at the next depth, and the resulting edits are
 * mapped back and re-escaped into the raw content. Only the repaired spans change:
 * every other byte keeps its original escaping, which is why this cannot normalise
 * unrelated text. A content with no escaped quote has nothing to decode, so the
 * walk runs on it directly.
 *
 * Bounded on both axes: `depth` stops nesting at {@link MAX_REDACTION_DEPTH} (a
 * document at that depth fails closed), and work is charged to the caller's budget.
 * A value that cannot be delimited propagates `malformed`, so the caller fails
 * closed instead of keeping a partial credential.
 */
function redactEncodedContent(
  content: string,
  budget: number,
  depth: number,
  work?: RedactionWork,
): { readonly status: "matched" | "malformed" | "exhausted"; readonly text: string; readonly scanned: number } {
  if (depth >= MAX_REDACTION_DEPTH) return { status: "malformed", text: content, scanned: 0 };

  if (!content.includes("\\\"")) {
    const direct = redactEscapedFragment(content, 0, content.length - 1, budget, depth + 1, work);
    if (direct.status !== "matched") return { status: direct.status, text: content, scanned: direct.scanned };
    return { status: "matched", text: direct.text, scanned: direct.scanned };
  }

  const decoded = decodeEscapedStringMapped(content);
  if (budget - decoded.text.length <= 0) return { status: "exhausted", text: content, scanned: 0 };
  const nested = redactEscapedFragment(decoded.text, 0, decoded.text.length - 1, budget - decoded.text.length, depth + 1, work);
  if (nested.status !== "matched") {
    return { status: nested.status, text: content, scanned: decoded.text.length };
  }
  if (!nested.changed) {
    return { status: "matched", text: content, scanned: decoded.text.length + nested.scanned };
  }
  const mapped: EscapedEdit[] = nested.edits.map((edit) => ({
    start: decoded.map[edit.start] ?? content.length,
    end: decoded.map[edit.end] ?? content.length,
    text: escapeEscapedContent(edit.text),
  }));
  return {
    status: "matched",
    text: renderEscapedEdits(content, 0, content.length, mapped),
    scanned: decoded.text.length + nested.scanned,
  };
}

/**
 * Redact one encoded document, key-aware, without decoding it.
 *
 * One forward pass over the escaped text. Two ways a credential is written are
 * recognised, and both consume their **whole** value:
 *
 * - an escaped string followed by `:` is a key (`\"accessToken\":\"…\"`), whose
 *   value may be an escaped string, a primitive, or a nested container;
 * - a bare key followed by `:` or `=` is an assignment (`password=[17,23,42,91]`,
 *   `accessToken={\"value\":\"…\"}`) — the form the document walk alone missed,
 *   which is how a container value under a credential key survived.
 *
 * Every *other* string is an ordinary value: its content is walked recursively (a
 * nested document) and its text checked by the scalar rules, because a document
 * that happens to contain one credential is not thereby free of a pasted provider
 * token in a sibling field. Only the spans that neither mechanism consumed are
 * handed to the scalar rules, so **every span is checked exactly once** and a
 * fragment is never reported as handled with part of it uninspected.
 *
 * Working on the escaped form rather than decoding, redacting and re-encoding is
 * the conservative choice: re-encoding would normalise escapes the original did not
 * use (`\/`, `\uXXXX`) and rewrite text that was never a credential. Here, only the
 * spans positively identified as credential values or credential-shaped string
 * contents are touched.
 *
 * Bounded and fail-closed: a value that cannot be completely delimited, or a work
 * limit reached, is reported so the caller replaces the remainder rather than
 * keeping a partial credential.
 */
function redactEscapedFragment(
  input: string,
  start: number,
  end: number,
  budget: number,
  depth: number,
  work?: RedactionWork,
): EscapedFragmentOutcome {
  const limit = end + 1;
  const edits: EscapedEdit[] = [];
  // Every span the walk inspected, whether or not it changed. The scalar rules run
  // over the complement of *this*, not of `edits`: a span the walk owns must not be
  // rescanned by rules written for plaintext, and a span it never reached must be.
  const owned: EscapedEdit[] = [];
  let i = start;
  let scanned = 0;
  /**
   * Container openers currently being walked, innermost last.
   *
   * The walk descends into a nonsensitive container value by continuing forward,
   * so pairing is tracked as it goes. The previous version looked the whole
   * subtree up with `scanEscapedContainer` and *then* descended, so a nested
   * container was scanned once per enclosing level — quadratic — and the lookahead
   * was charged to neither the budget nor the depth. One matching stack makes the
   * descent a single pass: each opener is pushed once and charged once, each closer
   * pops once, and every push counts toward {@link MAX_REDACTION_DEPTH}.
   */
  const stack: string[] = [];

  /**
   * Account `n` characters of work, failing when the budget would be exceeded.
   *
   * A negative count is a malformed scan and fails closed rather than crediting
   * work back. The caller returns `failed("exhausted")` when this is false, so the
   * remainder is replaced by the uninspected marker instead of being kept raw.
   */
  const charge = (n: number): boolean => {
    if (n < 0) return false;
    scanned += n;
    return scanned <= budget;
  };

  /** Push a container opener, depth-checked and charged. */
  const openContainer = (opener: string): boolean => {
    if (depth + stack.length + 1 > MAX_REDACTION_DEPTH) return false;
    if (!charge(1)) return false;
    stack.push(opener);
    if (work !== undefined && depth + stack.length > work.maxContainerDepth) {
      work.maxContainerDepth = depth + stack.length;
    }
    return true;
  };

  const failed = (status: "malformed" | "exhausted"): EscapedFragmentOutcome => ({
    status,
    text: "",
    changed: edits.length > 0,
    scanned,
    edits,
  });

  /** Inspect an ordinary string value's content: recursively, then by rule. */
  const inspectContent = (contentStart: number, contentEnd: number): "matched" | "malformed" | "exhausted" => {
    const content = input.slice(contentStart, contentEnd);
    const nested = redactEncodedContent(content, budget - scanned, depth, work);
    if (!charge(nested.scanned)) return "exhausted";
    if (nested.status !== "matched") return nested.status;
    if (nested.text !== content) edits.push({ start: contentStart, end: contentEnd, text: nested.text });
    return "matched";
  };

  while (i < limit) {
    if (budget - scanned <= 0) return failed("exhausted");

    // Container pairing is tracked by a single matching stack, so the descent is
    // one forward pass. An opener is pushed (charged, depth-checked); a closer must
    // match the innermost open opener, or the fragment is malformed and fails
    // closed. A closer with no open opener closes a container outside this span,
    // which a bounded fragment cannot have, so it too fails closed.
    const ch = input[i]!;
    if (ch === "{" || ch === "[") {
      if (!openContainer(ch)) return failed("exhausted");
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      const open = stack.pop();
      if (open === undefined) return failed("malformed");
      if ((ch === "}" && open !== "{") || (ch === "]" && open !== "[")) return failed("malformed");
      if (!charge(1)) return failed("exhausted");
      i += 1;
      continue;
    }

    if (isEscapedStringStart(input, i)) {
      const stringEnd = scanEscapedString(input, i, limit);
      if (stringEnd === -1) {
        // An unterminated escaped string is not a key. Inside a bounded span this is
        // routinely a delimiter whose partner the walker already consumed, so it is
        // skipped rather than failing the whole fragment closed.
        i += 1;
        continue;
      }
      if (!charge(stringEnd - i)) return failed("exhausted");
      let k = stringEnd;
      while (k < limit && isSpaceChar(input[k]!)) k += 1;

      if (input[k] !== ":") {
        // Not a key: a value in an array. It has no credential key of its own, but
        // its content still has to be inspected.
        const status = inspectContent(i + 2, stringEnd - 2);
        if (status !== "matched") return failed(status);
        owned.push({ start: i, end: stringEnd, text: "" });
        i = stringEnd;
        continue;
      }

      let v = k + 1;
      while (v < limit && isSpaceChar(input[v]!)) v += 1;
      const rawKey = input.slice(i + 2, stringEnd - 2);

      if (isSensitiveRawKey(rawKey)) {
        const value = delimitEscapedValue(input, v, budget - scanned);
        if (!charge(value.scanned)) return failed("exhausted");
        if (value.status !== "matched") return failed(value.status);
        const raw = input.slice(v, value.end);
        // An absent value stays absent: `null` carries no credential, and the
        // structured path preserves it for the same reason.
        if (raw !== ESCAPED_PLACEHOLDER && raw !== "null") {
          edits.push({ start: v, end: value.end, text: ESCAPED_PLACEHOLDER });
        }
        owned.push({ start: i, end: value.end, text: "" });
        i = value.end;
        continue;
      }

      // A key always owns its value, even when the key is not a credential. Skipping
      // only the key would let the walk descend into a *string* value and read the
      // nested document's own delimiters as this document's.
      if (isEscapedStringStart(input, v)) {
        const valueEnd = scanEscapedString(input, v, limit);
        if (valueEnd === -1) {
          i = stringEnd;
          continue;
        }
        if (!charge(valueEnd - v)) return failed("exhausted");
        const status = inspectContent(v + 2, valueEnd - 2);
        if (status !== "matched") return failed(status);
        owned.push({ start: i, end: valueEnd, text: "" });
        i = valueEnd;
        continue;
      }
      if (input[v] === "{" || input[v] === "[") {
        // A container value: descend so its own keys are visited. Pairing is tracked
        // by the shared matching stack as the walk continues, so each nested
        // container is visited **once** rather than once per enclosing level — the
        // old code scanned the whole subtree up front and then rescanned it on the
        // way down. The opener is not marked owned, so a bare token the descent does
        // not reach stays visible to the scalar complement pass.
        owned.push({ start: i, end: v, text: "" });
        i = v;
        continue;
      }
      const primitive = delimitEscapedValue(input, v, budget - scanned);
      if (!charge(primitive.scanned)) return failed("exhausted");
      owned.push({ start: i, end: primitive.status === "matched" ? primitive.end : v + 1, text: "" });
      i = primitive.status === "matched" ? primitive.end : v + 1;
      continue;
    }

    // An assignment at the escaped level: `password=[17,23,42,91]`,
    // `'password': [1,2]`, `password=correct[42]horse`. The label may be bare or
    // quoted, and the separator may be `:` or `=`.
    let keyStart = i;
    let keyEnd = i;
    let lexicalEnd = i;
    if (input[i] === "\"" || input[i] === "'") {
      const quotedKey = matchQuotedEnd(input, i, limit - i);
      if (quotedKey.status !== "matched") {
        i += 1;
        continue;
      }
      keyStart = i + 1;
      keyEnd = quotedKey.end;
      lexicalEnd = quotedKey.end + 1;
      if (!charge(quotedKey.scanned)) return failed("exhausted");
    } else if (isSeparatorKeyChar(input[i]!) && !(i > start && isAlnumChar(input[i - 1]!))) {
      // The whole lexical run: advancing one character into a separator run would
      // rescan the remainder at every position.
      while (keyEnd < limit && isSeparatorKeyChar(input[keyEnd]!)) keyEnd += 1;
      lexicalEnd = keyEnd;
      while (keyEnd > keyStart && !isAlnumChar(input[keyEnd - 1]!)) keyEnd -= 1;
      if (!charge(lexicalEnd - keyStart)) return failed("exhausted");
    } else {
      i += 1;
      continue;
    }

    if (keyEnd <= keyStart) {
      i = lexicalEnd;
      continue;
    }

    let separatorAt = lexicalEnd;
    while (separatorAt < limit && isSpaceChar(input[separatorAt]!)) separatorAt += 1;
    if (input[separatorAt] !== ":" && input[separatorAt] !== "=") {
      i = lexicalEnd;
      continue;
    }
    const rawKey = input.slice(keyStart, keyEnd);
    if (!isSensitiveRawKey(rawKey)) {
      // Not a credential: keep scanning past the label so the value is visited in
      // its own right.
      i = lexicalEnd;
      continue;
    }

    let valueStart = separatorAt + 1;
    while (valueStart < limit && isSpaceChar(input[valueStart]!)) valueStart += 1;

    const value = delimitAssignmentValue(input, valueStart, limit, budget - scanned);
    if (!charge(value.scanned)) return failed("exhausted");
    if (value.status !== "matched") return failed(value.status);

    const raw = input.slice(valueStart, value.end);
    // An absent value stays absent, and an already-replaced one is left alone so a
    // second pass changes nothing.
    if (raw !== PLACEHOLDER && raw !== "null" && raw !== ESCAPED_PLACEHOLDER && raw !== UNINSPECTED_MARKER) {
      edits.push({ start: valueStart, end: value.end, text: PLACEHOLDER });
    }
    // Only what was actually inspected is owned: the label, the separator and the
    // value. Marking the whole assignment would hide an uninspected descendant from
    // the scalar complement pass.
    owned.push({ start: i, end: value.end, text: "" });
    i = value.end;
  }

  // A container still open at the end of the span is malformed — its closer lies
  // outside the fragment — so the structure is not delimited and fails closed.
  if (stack.length > 0) return failed("malformed");

  // Every span must have been checked before the fragment is reported as handled.
  // The structural walk owns the credential values and the ordinary string
  // contents; the spans it did *not* consume are plaintext — the words around an
  // escaped quoted phrase, for instance — and they go through the scalar rules.
  // Skipping them is how `{\"note\":\"say \\\"hi\\\" ghp_…\"}` kept its token.
  for (const span of complementSpans(start, limit, owned)) {
    const spanText = input.slice(span.start, span.end);
    if (!charge(spanText.length)) return failed("exhausted");
    const scalar = applyScalarRules(spanText);
    if (scalar.redacted) edits.push({ start: span.start, end: span.end, text: scalar.text });
  }
  if (edits.length === 0) return { status: "matched", text: input.slice(start, limit), changed: false, scanned, edits };
  edits.sort((left, right) => left.start - right.start);
  return { status: "matched", text: renderEscapedEdits(input, start, limit, edits), changed: true, scanned, edits };
}


/**
 * The length of one of our redaction markers at `at`, or `-1`.
 *
 * Both markers can be the residue of a legacy partial redaction: `[redacted]` is
 * what the oldest build wrote, and `[redacted:uninspected]` is what migration 14
 * wrote when it consumed only part of the leaked run.
 */
function matchMarkerAt(input: string, at: number): number {
  if (input.startsWith(UNINSPECTED_MARKER, at)) return UNINSPECTED_MARKER.length;
  if (input.startsWith(PLACEHOLDER, at)) return PLACEHOLDER.length;
  return -1;
}

/**
 * Recover the *partial* redaction an older build left behind.
 *
 * A build before the container-string fix redacted a credential container by
 * stopping at a brace inside its quoted string, so
 * `password={"value":"},opaque-live-value"}` became
 * `password=[redacted],opaque-live-value"}` — the placeholder replaced only the
 * prefix and the rest of the value survived. Re-running the current redactor over
 * that text does **not** repair it: `[redacted]` is now a complete-looking value
 * followed by a valid `,`, so the scanner accepts it and the tail stays.
 *
 * This pass recognises that artifact and fails it closed. The signature is precise,
 * so benign prose is not touched: a bare placeholder that is an **assignment value
 * under a sensitive key** and is followed by `,` and at least one more character.
 *
 * **The whole remainder is consumed, because whitespace is not a reliable
 * boundary.** The leaked text is the rest of a container the old build stopped
 * short of, so it can contain spaces and span several words — `first
 * opaque-secret-suffix`, ` multi word suffix`. Stopping at the first whitespace (or
 * skipping entirely when the comma was followed by a space) left those suffixes in
 * the stored text. There is no trustworthy delimiter inside the leaked value, so
 * everything from the marker to the end of the span is replaced by
 * {@link UNINSPECTED_MARKER}. That is deliberately conservative: dropping text
 * costs a redacted snippet, keeping it costs a persisted credential.
 *
 * The `[redacted:uninspected]` marker is recognised the same way, because migration
 * 14 consumed only the first non-space run of the leak and left the rest behind a
 * space (`[redacted:uninspected] opaque-secret-suffix`).
 *
 * This is only reached for text that is **not** recoverable structured JSON (see
 * {@link isRecoverableStructuredJson}), so a legitimate JSON sibling is never
 * consumed here — the structural pass repairs the placeholder and preserves it.
 *
 * Linear and bounded: **one forward pass** with a monotonic cursor, so each
 * character is examined once. Finding the next marker of either kind with two
 * `indexOf` calls per iteration was quadratic — `"[redacted] ".repeat(N)` re-scanned
 * the whole remaining suffix every time a marker turned out not to be an artifact,
 * so 352 000 characters took most of a second and 16 MiB would stall a collector.
 * All the work is charged against the caller's shared budget, and reaching the
 * budget fails closed (the uninspected remainder is replaced) rather than continuing
 * to scan.
 */
function recoverLegacyPartialAssignments(input: string, budget: number): {
  readonly text: string;
  readonly changed: boolean;
  readonly scanned: number;
  readonly exhausted: boolean;
} {
  let output = "";
  let copiedTo = 0;
  let scanned = 0;
  let exhausted = false;
  let i = 0;
  while (i < input.length) {
    if (scanned >= budget) {
      exhausted = true;
      break;
    }
    // A recoverable JSON container is structured data, not the residue of a damaged
    // assignment: the structural pass repairs its bare markers and preserves its
    // siblings, so a marker inside one must not be consumed here. This is the guard
    // for embedded JSON in prose — `config {"password":[redacted],"region":"us-east-1"}`
    // — where the whole input does not parse but the fragment does, and consuming the
    // remainder would delete `region` and everything after it. The container is
    // skipped whole, so no marker inside it reaches the artifact check.
    if (opensJsonValue(input[i])) {
      const fragment = matchJsonEnd(input, i, budget - scanned);
      scanned += fragment.scanned;
      if (fragment.status === "exhausted") {
        exhausted = true;
        break;
      }
      if (fragment.status === "matched" && parseJsonFragment(input.slice(i, fragment.end + 1)).ok) {
        i = fragment.end + 1;
        continue;
      }
    }
    // One forward pass over both marker kinds. `matchMarkerAt` is O(1), so the scan
    // examines each position exactly once however many markers the text holds.
    const markerLength = matchMarkerAt(input, i);
    if (markerLength === -1) {
      i += 1;
      scanned += 1;
      continue;
    }
    scanned += markerLength;
    const at = i;
    const after = at + markerLength;
    // The leaked remainder follows the marker either directly behind a `,` (the shape
    // the oldest build wrote) or behind whitespace (the shape migration 14 left when
    // it consumed only the first non-space run). Whitespace is *not* an exemption —
    // the leaked suffix may begin with one.
    //
    // The whitespace form is only recognised for the **uninspected** marker. That
    // marker is never emitted with content after it (every fail-closed path consumes
    // to the end of its span), so anything following one is legacy residue. The plain
    // `[redacted]` marker *is* legitimately followed by ordinary text — our own output
    // `Authorization: [redacted] and api_key=[redacted]` — so it only triggers on an
    // immediate `,`, which ordinary text does not produce.
    const isUninspectedMarker = input.startsWith(UNINSPECTED_MARKER, at);
    let content = after;
    while (content < input.length && isSpaceChar(input[content]!)) content += 1;
    scanned += content - after;
    if (content >= input.length) {
      // Nothing but whitespace after the marker: there is no leaked value.
      i = after;
      continue;
    }
    const isComma = input[after] === ",";
    const hadSpace = content > after;
    if (!isComma && !(isUninspectedMarker && hadSpace)) {
      i = after;
      continue;
    }
    const key = precedingSensitiveKey(input, at);
    scanned += key.scanned;
    if (key.outcome === "nonsensitive") {
      i = after;
      continue;
    }
    // Consume the entire remainder: the leaked value has no reliable inner
    // delimiter, so nothing after the marker can be trusted as unrelated text.
    scanned += input.length - after;
    output += input.slice(copiedTo, at) + UNINSPECTED_MARKER;
    copiedTo = input.length;
    i = input.length;
  }
  if (exhausted) {
    // Fail closed: the remainder was never inspected, so it is replaced rather than
    // kept — a marker the scan did not reach may hold the rest of a credential.
    return { text: output + UNINSPECTED_MARKER, changed: true, scanned, exhausted: true };
  }
  if (copiedTo === 0) return { text: input, changed: false, scanned, exhausted: false };
  return { text: output + input.slice(copiedTo), changed: true, scanned, exhausted: false };
}

function redactSpan(input: string, depth: number, work?: RedactionWork, preSpent = 0): RedactionResult {
  let output = "";
  let copiedTo = 0;
  let i = 0;
  let attempts = 0;
  let redacted = false;
  // Work already charged by a prepass (the legacy-artifact recovery) is deducted
  // from this pass's budget, so the two share one bounded allowance.
  const totalBudget = Math.max(JSON_SCAN_BUDGET_FLOOR, input.length * JSON_SCAN_BUDGET_FACTOR);
  let budget = totalBudget - preSpent;
  const initialBudget = totalBudget;
  let exhausted = false;
  /**
   * Report the structural work this pass performed.
   *
   * Every charged operation decrements `budget`, so the work is exactly what the
   * pass consumed. Reporting it here makes the cost observable and deterministic —
   * a test can assert the scan is linear without timing it.
   */
  const finish = (result: RedactionResult): RedactionResult => {
    if (work !== undefined) work.scanned = initialBudget - budget;
    return result;
  };
  const history = new NonSpaceHistory();
  while (i < input.length) {
    if (budget <= 0 || attempts >= JSON_FRAGMENT_ATTEMPT_LIMIT) {
      exhausted = true;
      break;
    }
    const assignment = matchCredentialAssignment(input, i, history, budget);
    budget -= assignment.scanned;
    if (assignment.status === "exhausted") {
      exhausted = true;
      break;
    }
    if (assignment.status === "matched") {
      const gap = applyScalarRules(input.slice(copiedTo, i));
      if (gap.redacted) redacted = true;
      // An existing fail-closed marker is left exactly as it is: rewriting it to
      // `[redacted]` would claim a credential was recognised when the text actually
      // reports that the scan stopped before checking.
      const raw = input.slice(i, assignment.end + 1);
      if (raw === UNINSPECTED_MARKER) {
        output += gap.text + raw;
      } else {
        output += gap.text + PLACEHOLDER;
        redacted = true;
      }
      copiedTo = assignment.end + 1;
      i = assignment.end + 1;
      history.push(assignment.end);
      continue;
    }
    if (opensJsonValue(input[i])) {
      attempts += 1;
      const fragment = matchJsonEnd(input, i, budget);
      budget -= fragment.scanned;
      if (fragment.status === "exhausted") {
        exhausted = true;
        break;
      }
      if (fragment.status === "matched") {
        const outcome = redactJsonFragment(input, i, fragment.end, depth);
        budget -= outcome.scanned;
        if (outcome.parsed) {
          const gap = applyScalarRules(input.slice(copiedTo, i));
          if (gap.redacted) redacted = true;
          output += gap.text;
          if (outcome.failClosed) {
            // The fragment's key could not be resolved, so everything from here on is
            // uninspected: the value may continue past the fragment, and keeping the
            // rest would strand it with no key in front of it.
            output += UNINSPECTED_MARKER;
            redacted = true;
            copiedTo = input.length;
            i = input.length;
            continue;
          }
          if (outcome.changed) redacted = true;
          output += outcome.text;
          copiedTo = fragment.end + 1;
          i = fragment.end + 1;
          history.push(fragment.end);
          continue;
        }
      }
      // Not plain JSON. A double-encoded document has escaped quotes, which
      // `matchJsonEnd` reads as an unterminated string, so it needs its own scan
      // and its own key-aware pass before the text is handed to the scalar rules.
      const escaped = matchEscapedJsonEnd(input, i, budget);
      budget -= escaped.scanned;
      if (escaped.status === "exhausted") {
        exhausted = true;
        break;
      }
      if (escaped.status === "matched" || escaped.status === "unterminated") {
        const escapedOutcome = redactEscapedFragment(input, i, escaped.end, budget, depth, work);
        budget -= escapedOutcome.scanned;
        if (escapedOutcome.status !== "matched") {
          exhausted = true;
          break;
        }
        // Consume the fragment whether or not it changed. The escaped walk has
        // already inspected every string inside it, so leaving an unchanged one to
        // the scalar rules would only let those rules rewrite the nested `\\\"`
        // delimiters into the single-escaped form and corrupt the document.
        const gap = applyScalarRules(input.slice(copiedTo, i));
        if (gap.redacted) redacted = true;
        output += gap.text + escapedOutcome.text;
        if (escapedOutcome.changed) redacted = true;
        copiedTo = escaped.end + 1;
        i = escaped.end + 1;
        history.push(escaped.end);
        continue;
      }
    }
    if (!isSpaceChar(input[i]!)) history.push(i);
    i += 1;
  }
  if (exhausted) {
    // Fail closed. Everything from `copiedTo` on was never structurally
    // inspected, so it is replaced wholesale rather than risk retaining a
    // credential the scanner did not reach.
    if (copiedTo < input.length) {
      output += UNINSPECTED_MARKER;
      redacted = true;
    }
    return finish({ text: output, redacted });
  }
  const tail = applyScalarRules(input.slice(copiedTo));
  if (tail.redacted) redacted = true;
  return finish({ text: output + tail.text, redacted });
}

/**
 * The labelled, escaped, and high-entropy rules, and nothing else.
 *
 * Deliberately does **not** parse JSON: it is applied to the spans between
 * structured fragments, and to a fragment that is not JSON, but never to a
 * fragment that parsed. See {@link redactSpan} for why that separation is what
 * keeps a mixed payload both redacted and valid.
 */
function applyScalarRules(input: string): RedactionResult {
  let text = input;
  let redacted = false;
  for (const rule of RULES) {
    const next =
      rule.apply !== undefined
        ? rule.apply(text)
        : ((rule.pattern!.lastIndex = 0), text.replace(rule.pattern!, rule.replacement as string));
    if (next !== text) {
      redacted = true;
      text = next;
    }
  }
  return { text, redacted };
}

/**
 * Redact credential-shaped content.
 *
 * Idempotent: a fragment that parses is fully handled by the key-aware pass, so
 * a second pass over `{"api_key":"[redacted]"}` returns it unchanged (the value
 * is already the placeholder, and the scalar rules — whose value patterns exclude
 * `[` and `]` — never see it). The scalar value patterns also exclude the bracket
 * characters precisely so that text which merely *looks* like the placeholder
 * cannot be extended into a longer one.
 *
 * Credential-shaped text is removed in one ordered pass: each balanced JSON
 * fragment is redacted key-aware (a whole object or array under a credential key
 * is replaced, nested and encoded payloads included) and everything outside a
 * parsed fragment goes through the labelled/escaped/high-entropy rules.
 */
export function redactText(input: string): RedactionResult {
  return redactTextAtDepth(input, 0);
}

/**
 * Structural work performed by one redaction pass.
 *
 * Exposed so the scan's cost can be asserted **deterministically** rather than by
 * timing: `scanned` is the number of characters the structural walk examined (the
 * forward walk, key matching, whitespace, container tracking, and decoding), and
 * `maxContainerDepth` is the deepest container nesting the escaped walk entered.
 * Both are pure functions of the input, so the same input always reports the same
 * work.
 */
export interface RedactionWork {
  /** Characters examined by the structural scan. */
  scanned: number;
  /** The deepest container nesting the escaped walk entered. */
  maxContainerDepth: number;
}

/**
 * Redact, and report the structural work the pass performed.
 *
 * Identical in behaviour to {@link redactText}; the extra return value is the
 * observable cost of the scan, for tests that must prove linearity and depth
 * bounding without relying on wall-clock timing.
 */
export function redactTextWithWork(input: string): {
  readonly text: string;
  readonly redacted: boolean;
  readonly work: RedactionWork;
} {
  const work: RedactionWork = { scanned: 0, maxContainerDepth: 0 };
  const result = redactTextAtDepth(input, 0, work);
  return { text: result.text, redacted: result.redacted, work };
}

/**
 * Whether `input` is — or can be repaired into — a parseable JSON document.
 *
 * Used to decide whether the legacy-partial-artifact recovery may run at all. A
 * *valid* JSON document, or one that only needs its bare placeholder re-quoted
 * (`{"password":[redacted],"region":"us-east-1"}`), is structured data: the
 * structural pass repairs the placeholder and preserves every sibling, so the
 * artifact recovery must **not** touch it. Running recovery first is what deleted
 * `region` and the surrounding structure — it treated a legitimate JSON sibling as
 * the tail of a damaged assignment.
 */
function isRecoverableStructuredJson(input: string): boolean {
  if (tryParseJson(input).ok) return true;
  return tryParseJson(quoteBarePlaceholders(input)).ok;
}

function redactTextAtDepth(input: string, depth: number, work?: RedactionWork): RedactionResult {
  // Beyond the depth cap the structural scan is not run, so text that would have
  // needed it fails closed rather than being kept on the strength of the scalar
  // rules alone.
  if (depth >= MAX_REDACTION_DEPTH) {
    if (input.includes("{") || input.includes("[")) return { text: UNINSPECTED_MARKER, redacted: true };
    return applyScalarRules(input);
  }
  // A placeholder left half-applied by an older build is repaired before the
  // structural scan, because the scan would otherwise accept it as a complete value.
  // **Only when the text is not structured JSON**: a document that parses — or that
  // parses once its bare placeholder is re-quoted — is handled by the structural
  // pass, which repairs the placeholder and preserves its siblings. Recovery runs
  // only on the known malformed shape that cannot be parsed or repaired.
  if (input.includes(PLACEHOLDER) || input.includes(UNINSPECTED_MARKER)) {
    if (!isRecoverableStructuredJson(input)) {
      const budget = Math.max(JSON_SCAN_BUDGET_FLOOR, input.length * JSON_SCAN_BUDGET_FACTOR);
      const recovered = recoverLegacyPartialAssignments(input, budget);
      if (recovered.exhausted) {
        // Fail closed: the recovery could not inspect the whole text, so the
        // remainder is not kept. The work it did is still reported, so the shared
        // accounting reflects the whole pass.
        if (work !== undefined) work.scanned = recovered.scanned;
        return { text: recovered.text, redacted: true };
      }
      // The recovery's work is charged to the same allowance the structural scan
      // uses **whether or not it changed the text**. Passing it only on a change left
      // an unchanged marker-heavy input with a fresh budget, so the recovery's scan
      // was effectively free and the shared accounting under-reported the total.
      // When the recovery alone exceeds the allowance the structural pass starts
      // exhausted and fails closed, which is the intended bound.
      const result = redactSpan(recovered.changed ? recovered.text : input, depth, work, recovered.scanned);
      return { text: result.text, redacted: recovered.changed || result.redacted };
    }
  }
  return redactSpan(input, depth, work);
}

export function truncateText(input: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0) {
    return { text: "", truncated: input.length > 0 };
  }
  if (input.length <= maxChars) {
    return { text: input, truncated: false };
  }
  return { text: `${input.slice(0, maxChars)}\n… [truncated, ${input.length - maxChars} characters omitted]`, truncated: true };
}

/** Redact, then truncate. Returns the display-safe form of upstream content. */
export function sanitiseForDisplay(input: string | null | undefined, maxChars: number): DisplayText {
  if (input === null || input === undefined || input === "") {
    return { text: "", truncated: false, redacted: false };
  }
  const redaction = redactText(input);
  const truncated = truncateText(redaction.text, maxChars);
  return { text: truncated.text, truncated: truncated.truncated, redacted: redaction.redacted };
}

/** Single-line summary for list views. */
export function summariseLine(input: string, maxChars: number): DisplayText {
  const flattened = input.replace(/\s+/g, " ").trim();
  return sanitiseForDisplay(flattened, maxChars);
}

/**
 * Redact a field that will be persisted and later displayed, preserving the
 * "absent" distinction.
 *
 * Use this for every display-only string taken from upstream: titles,
 * descriptions, names, sub-paths, directories, model labels, tool names, and
 * error text. A title is just as capable of carrying a pasted credential as a
 * shell command is, and a title is far more likely to be read by a human.
 *
 * **Do not** apply this to identity or join keys (`session.id`, `message.id`,
 * `location_id`, `project_id`, and an invocation's `agent_id`). Those are
 * compared for equality and joined across tables; redacting one would silently
 * break a join or collapse two distinct records into one. They are also not free
 * text: they are either framework-assigned identifiers or API-assigned ids with
 * a documented shape.
 */
export function redactPersistedField(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  if (input === "") return "";
  return redactText(input).text;
}

/** `JSON.parse`, distinguishing a parse failure from a legitimate `undefined`. */
function tryParseJson(input: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    return { ok: false };
  }
}

/**
 * Redact a persisted value that may be serialised JSON.
 *
 * The observer persists both free text and serialised JSON: a tool input is
 * JSON-stringified, and a transcript message may itself be a JSON document. A
 * credential hidden as a whole object or array value under a credential key is
 * invisible to a text-only redactor — the value rules only understand scalars —
 * so a value that parses as JSON is redacted key-aware and re-serialised, and a
 * nested encoded payload is covered by the same recursion.
 *
 * A value that does not parse, or whose structure held nothing credential-shaped,
 * falls back to {@link redactText}, which still removes labelled, escaped,
 * embedded and high-entropy secrets. This never throws: the caller always gets a
 * redacted value back.
 */
export function redactSerializedValue(input: string): string {
  const parsed = tryParseJson(input);
  if (parsed.ok) {
    const before = stringifyJson(parsed.value);
    const after = stringifyJson(redactStructuredLeaves(parsed.value));
    if (before !== null && after !== null && before !== after) return after;
  }
  return redactText(input).text;
}

/**
 * Whether a property name itself names a credential.
 *
 * Used by {@link redactStructuredLeaves}, where the value may be an ordinary
 * opaque string with nothing credential-shaped about it: the only evidence that
 * `{"accessToken":"8f3c…"}` is a secret is the *key*. Matched against the whole
 * key, so `access_token` and `accessToken` both qualify while `secretary` does
 * not.
 */


export function isSecretKey(key: string): boolean {
  return isSeparatorSecretLabel(key) || isCamelSecretLabel(key);
}

/**
 * Whether a label names a credential, by *any* of the shapes the redactor knows.
 *
 * {@link isSecretKey} covers the separator-delimited and camelCase shapes, which
 * is all {@link redactStructuredLeaves} needs because a JSON property is always a
 * single identifier. An assignment key is not: it may be written in
 * environment-variable style (`OPENAI_KEY`, `GITHUB_TOKEN`), whose credential word
 * is a *suffix* rather than a whole segment. Using the narrower check in the
 * assignment scanner is what let `OPENAI_KEY="…"` through: the label was not
 * recognised, so the assignment was never consumed as a unit and the value split
 * at the `[` inside it.
 *
 * This is the single classification the scanner and the env-style scalar rule
 * share, so the two cannot disagree about what a credential label looks like.
 */
export function isSensitiveLabel(key: string): boolean {
  return isSecretKey(key) || isEnvSecretLabel(key);
}

/**
 * Redact an object's string leaves, returning a new object.
 *
 * Used for the structured evidence payload and for a serialised tool input
 * *before* it is stringified, where redacting the serialised JSON would produce
 * invalid JSON. Redacting each leaf keeps the payload parseable while still
 * removing anything credential-shaped.
 *
 * The redaction is **key-aware**: a property whose *name* is a credential key has
 * its whole value replaced — including an object or array value, since a nested
 * wrapper is just as much a credential as a scalar one. An ordinary opaque secret
 * carries no credential-shaped text for the value rules to find, so without that
 * a `{"accessToken":"8f3c9a…"}` leaf would pass through untouched — the exact gap
 * the camelCase finding named.
 *
 * The key test is {@link isSensitiveLabel}, the same classifier the assignment
 * scanner and the env-style scalar rule use, so a label is either sensitive
 * everywhere or nowhere. Using the narrower {@link isSecretKey} here was a
 * mismatch: `{"OPENAI_KEY":"8f3c9a…"}` was masked when it appeared as
 * `OPENAI_KEY=…` but not as a JSON property, because the env-style key shape was
 * recognised by one path and not the other.
 *
 * `depth` bounds recursion. Beyond {@link MAX_REDACTION_DEPTH} a subtree is
 * replaced outright rather than recursed into, so a pathologically deep payload
 * cannot exhaust the stack; the depth is far past anything a real payload reaches.
 */
export function redactStructuredLeaves<T>(value: T, key?: string, depth = 0): T {
  if (key !== undefined && isSensitiveRawKey(key)) {
    // The key names a credential — by name, or by carrying an escape that could
    // hide one (`access\u0054oken`) — so the value is replaced outright. Running
    // the text rules over an opaque value would find nothing to redact: the key is
    // the only evidence that it is a secret. An absent value stays absent.
    if (value === null || value === undefined) return value;
    return PLACEHOLDER as unknown as T;
  }
  if (typeof value === "string") return redactTextAtDepth(value, depth).text as unknown as T;
  if (depth >= MAX_REDACTION_DEPTH) {
    if (Array.isArray(value) || (typeof value === "object" && value !== null)) return PLACEHOLDER as unknown as T;
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactStructuredLeaves(entry, undefined, depth + 1)) as unknown as T;
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>)) {
      output[entryKey] = redactStructuredLeaves(entry, entryKey, depth + 1);
    }
    return output as unknown as T;
  }
  return value;
}
