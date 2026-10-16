import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Owner password hashing.
 *
 * scrypt is used because it ships with Node's standard library: a
 * single-owner credential does not justify another dependency, and the cost
 * parameters are stored alongside the hash so they can be raised later without
 * invalidating an existing credential.
 *
 * Stored format: `scrypt$N$r$p$<saltBase64url>:<keyBase64url>`
 */

const DEFAULT_N = 16_384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEM = 128 * 1024 * 1024;

export class PasswordFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordFormatError";
  }
}

export function hashPassword(password: string): string {
  if (password.length === 0) {
    throw new PasswordFormatError("Refusing to hash an empty password.");
  }
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(password, salt, KEY_LENGTH, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: MAX_MEM,
  });
  return `scrypt$${DEFAULT_N}$${DEFAULT_R}$${DEFAULT_P}$${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

export interface ParsedPasswordHash {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

export function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  const parts = stored.split("$");
  if (parts.length !== 5) return null;
  const [scheme, nRaw, rRaw, pRaw, encoded] = parts as [string, string, string, string, string];
  if (scheme !== "scrypt") return null;
  if (!/^\d+$/.test(nRaw) || !/^\d+$/.test(rRaw) || !/^\d+$/.test(pRaw)) return null;

  const separator = encoded.indexOf(":");
  if (separator <= 0) return null;
  const saltB64 = encoded.slice(0, separator);
  const keyB64 = encoded.slice(separator + 1);

  const N = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);
  if (N < 1024 || r < 1 || p < 1) return null;

  const salt = Buffer.from(saltB64, "base64url");
  const key = Buffer.from(keyB64, "base64url");
  if (salt.length === 0 || key.length === 0) return null;
  return { N, r, p, salt, key };
}

export function isSupportedPasswordHash(stored: string): boolean {
  return parsePasswordHash(stored) !== null;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parsed = parsePasswordHash(stored);
  if (parsed === null) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(password, parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEM,
    });
  } catch {
    return false;
  }
  if (derived.length !== parsed.key.length) return false;
  return timingSafeEqual(derived, parsed.key);
}

/**
 * Burn roughly the same time as a real verification when no owner credential
 * exists, so the login endpoint's latency does not disclose whether the
 * application has been configured yet.
 */
export function dummyVerify(): void {
  scryptSync("not-a-real-password", Buffer.alloc(SALT_LENGTH), KEY_LENGTH, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: MAX_MEM,
  });
}
