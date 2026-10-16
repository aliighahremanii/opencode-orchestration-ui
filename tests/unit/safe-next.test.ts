import { describe, expect, it } from "vitest";
import { safeNext } from "../../components/client/safe-next.ts";

/**
 * `safeNext` constrains the sign-in page's `?next=` destination.
 *
 * The finding: the previous check rejected a literal `//` and a backslash but
 * still accepted an encoded tab/newline path (`/%09/attacker.example`). A browser
 * strips those control characters while parsing the URL, turning the value into a
 * protocol-relative navigation to another origin — an open redirect.
 *
 * The tests assert the *parsed* outcome, not the raw string, because that is what
 * a browser acts on.
 */

const ORIGIN = "https://dash.example";

describe("safeNext", () => {
  it("returns the default for an absent destination", () => {
    expect(safeNext(null, ORIGIN)).toBe("/");
    expect(safeNext("", ORIGIN)).toBe("/");
  });

  it("accepts a same-origin path, query and fragment unchanged", () => {
    expect(safeNext("/", ORIGIN)).toBe("/");
    expect(safeNext("/runs/abc", ORIGIN)).toBe("/runs/abc");
    expect(safeNext("/runs/abc?x=1#frag", ORIGIN)).toBe("/runs/abc?x=1#frag");
    expect(safeNext("/sessions/ses_a?tab=activity", ORIGIN)).toBe("/sessions/ses_a?tab=activity");
  });

  it("rejects a protocol-relative destination", () => {
    expect(safeNext("//attacker.example", ORIGIN)).toBe("/");
    expect(safeNext("///attacker.example", ORIGIN)).toBe("/");
    expect(safeNext("//attacker.example/path", ORIGIN)).toBe("/");
  });

  it("rejects a backslash destination, which the URL parser folds into a slash", () => {
    expect(safeNext("/\\attacker.example", ORIGIN)).toBe("/");
    expect(safeNext("\\\\attacker.example", ORIGIN)).toBe("/");
    // Percent-encoded backslash (`%5c`).
    expect(safeNext("/%5cattacker.example", ORIGIN)).toBe("/");
  });

  it("rejects a literal tab or newline, which the browser strips before parsing", () => {
    expect(safeNext("/\t/attacker.example", ORIGIN)).toBe("/");
    expect(safeNext("/\n/attacker.example", ORIGIN)).toBe("/");
    expect(safeNext("/\r/attacker.example", ORIGIN)).toBe("/");
    expect(safeNext("/\u0000/attacker.example", ORIGIN)).toBe("/");
    expect(safeNext("/\u007f/attacker.example", ORIGIN)).toBe("/");
  });

  it("rejects an encoded tab or newline in the raw value", () => {
    // The exact form named by the finding: `?next=/%09/attacker.example`.
    expect(safeNext("/%09/attacker.example", ORIGIN)).toBe("/");
    expect(safeNext("/%0a/attacker.example", ORIGIN)).toBe("/");
    expect(safeNext("/%0A/attacker.example", ORIGIN)).toBe("/");
    expect(safeNext("/%0d/attacker.example", ORIGIN)).toBe("/");
    expect(safeNext("/%00/attacker.example", ORIGIN)).toBe("/");
    expect(safeNext("/%7f/attacker.example", ORIGIN)).toBe("/");
  });

  it("rejects the decoded form that URLSearchParams produces", () => {
    // `new URLSearchParams(...).get("next")` decodes `%09` to a literal tab, which
    // is the value the form actually passes to `safeNext`.
    const decoded = new URLSearchParams("next=/%09/attacker.example").get("next");
    expect(decoded).toBe("/\t/attacker.example");
    expect(safeNext(decoded, ORIGIN)).toBe("/");

    const decodedNewline = new URLSearchParams("next=/%0a/attacker.example").get("next");
    expect(decodedNewline).toBe("/\n/attacker.example");
    expect(safeNext(decodedNewline, ORIGIN)).toBe("/");
  });

  it("rejects a destination that normalises into a protocol-relative path", () => {
    // `..` segments are collapsed by the parser, so a same-origin-looking path can
    // become `//host`.
    expect(safeNext("/..//attacker.example", ORIGIN)).toBe("/");
    expect(safeNext("/foo/../..//attacker.example", ORIGIN)).toBe("/");
    expect(safeNext("/%2e%2e//attacker.example", ORIGIN)).toBe("/");
  });

  it("rejects an absolute URL or a non-http scheme", () => {
    expect(safeNext("https://attacker.example/path", ORIGIN)).toBe("/");
    expect(safeNext("http://attacker.example", ORIGIN)).toBe("/");
    expect(safeNext("javascript:alert(1)", ORIGIN)).toBe("/");
    expect(safeNext("data:text/html,<script>", ORIGIN)).toBe("/");
  });

  it("rejects a relative (non-absolute) destination", () => {
    expect(safeNext("runs/abc", ORIGIN)).toBe("/");
    expect(safeNext("?next=/runs", ORIGIN)).toBe("/");
    expect(safeNext("#frag", ORIGIN)).toBe("/");
  });

  it("never bounces straight back to the sign-in page", () => {
    expect(safeNext("/login", ORIGIN)).toBe("/");
    expect(safeNext("/login/", ORIGIN)).toBe("/");
    expect(safeNext("/login?next=/runs/x", ORIGIN)).toBe("/");
  });

  it("requires the resolved origin to match the dashboard origin", () => {
    // A different base origin means every path resolves elsewhere.
    expect(safeNext("/runs/abc", ORIGIN)).toBe("/runs/abc");
    // With a malformed base, nothing can be proven same-origin, so fail closed.
    expect(safeNext("/runs/abc", "not a url")).toBe("/");
  });

  it("returns only a same-origin relative destination", () => {
    const inputs = [
      "/runs/abc",
      "/sessions/ses_a?tab=x",
      "//attacker.example",
      "/\\attacker.example",
      "/\t/attacker.example",
      "/%09/attacker.example",
      "/..//attacker.example",
      "https://attacker.example",
      "javascript:alert(1)",
      "/login",
    ];
    for (const input of inputs) {
      const result = safeNext(input, ORIGIN);
      expect(result.startsWith("/"), input).toBe(true);
      expect(result.startsWith("//"), input).toBe(false);
      expect(result, input).not.toContain("attacker.example");
      // The result is always usable as a same-origin path.
      expect(new URL(result, ORIGIN).origin, input).toBe(ORIGIN);
    }
  });
});
