/**
 * Generate a password hash for ORCH_OWNER_PASSWORD_HASH.
 *
 * The plaintext password is read from argv[2] or, preferably, the
 * ORCH_NEW_OWNER_PASSWORD environment variable, and only the hash is printed.
 *
 *   ORCH_NEW_OWNER_PASSWORD='...' npm run auth:hash
 *   npm run auth:hash -- '...'
 */

import { hashPassword, PasswordFormatError } from "../lib/auth/password.ts";

const fromArgv = process.argv[2];
const fromEnv = process.env.ORCH_NEW_OWNER_PASSWORD;
const password = fromArgv ?? fromEnv;

if (password === undefined || password === "") {
  console.error(
    "Usage: ORCH_NEW_OWNER_PASSWORD='<password>' npm run auth:hash\n" +
      "   or: npm run auth:hash -- '<password>'\n" +
      "Note: passing a password on the command line can leak it via your shell history.",
  );
  process.exitCode = 1;
} else {
  try {
    console.log(hashPassword(password));
    console.error("Add the value above as ORCH_OWNER_PASSWORD_HASH in the web process environment.");
  } catch (cause) {
    if (cause instanceof PasswordFormatError) {
      console.error(cause.message);
    } else {
      console.error(cause instanceof Error ? cause.message : String(cause));
    }
    process.exitCode = 1;
  }
}
