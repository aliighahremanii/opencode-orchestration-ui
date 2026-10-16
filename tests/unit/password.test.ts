import { describe, expect, it } from "vitest";
import { dummyVerify, hashPassword, isSupportedPasswordHash, parsePasswordHash, verifyPassword } from "../../lib/auth/password.ts";

/**
 * Owner credential hashing.
 *
 * The stored value must never contain the password, must be verifiable, and must
 * fail closed on any malformed input.
 */
describe("hashPassword", () => {
  it("produces a scrypt-encoded value that does not contain the password", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("correct horse battery staple");
    expect(isSupportedPasswordHash(hash)).toBe(true);
  });

  it("uses a fresh salt per call", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("refuses an empty password", () => {
    expect(() => hashPassword("")).toThrow();
  });

  it("records the cost parameters so they can be raised later", () => {
    const parsed = parsePasswordHash(hashPassword("x"));
    expect(parsed).not.toBeNull();
    expect(parsed?.N).toBeGreaterThanOrEqual(1024);
    expect(parsed?.r).toBeGreaterThanOrEqual(1);
    expect(parsed?.p).toBeGreaterThanOrEqual(1);
  });
});

describe("verifyPassword", () => {
  it("accepts the correct password", () => {
    const hash = hashPassword("hunter2");
    expect(verifyPassword("hunter2", hash)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const hash = hashPassword("hunter2");
    expect(verifyPassword("hunter3", hash)).toBe(false);
    expect(verifyPassword("", hash)).toBe(false);
    expect(verifyPassword("HUNTER2", hash)).toBe(false);
  });

  it("is case and whitespace sensitive", () => {
    const hash = hashPassword("pw");
    expect(verifyPassword(" pw", hash)).toBe(false);
    expect(verifyPassword("pw ", hash)).toBe(false);
  });

  it("round-trips a long password", () => {
    const long = "a".repeat(300);
    expect(verifyPassword(long, hashPassword(long))).toBe(true);
  });

  it("round-trips a non-ASCII password", () => {
    const unicode = "pässwörd-🔐-日本語";
    expect(verifyPassword(unicode, hashPassword(unicode))).toBe(true);
  });

  it("fails closed on a malformed stored value", () => {
    for (const bad of ["", "not-a-hash", "scrypt$1$1", "scrypt$a$b$c$d:e", "bcrypt$1$1$1$a:b", "scrypt$0$0$0$a:b"]) {
      expect(verifyPassword("x", bad), bad).toBe(false);
    }
  });

  it("fails closed when the encoded salt or key is empty", () => {
    expect(verifyPassword("x", "scrypt$16384$8$1$:")).toBe(false);
    expect(verifyPassword("x", "scrypt$16384$8$1$c2FsdA:")).toBe(false);
  });

  it("does not throw on an absurd cost parameter", () => {
    // A hostile or corrupted stored hash must not crash the login endpoint.
    expect(verifyPassword("x", "scrypt$999999999$8$1$c2FsdA:a2V5")).toBe(false);
  });
});

describe("parsePasswordHash", () => {
  it("returns null for a value it cannot parse", () => {
    expect(parsePasswordHash("garbage")).toBeNull();
  });

  it("extracts the salt and key", () => {
    const parsed = parsePasswordHash(hashPassword("x"));
    expect(parsed?.salt.length).toBeGreaterThan(0);
    expect(parsed?.key.length).toBeGreaterThan(0);
  });
});

describe("dummyVerify", () => {
  it("completes without throwing and does no work with the password", () => {
    expect(() => dummyVerify()).not.toThrow();
  });
});
