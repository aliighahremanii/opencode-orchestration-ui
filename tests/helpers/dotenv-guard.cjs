/* eslint-disable @typescript-eslint/no-require-imports */
// Test-only instrumentation, preloaded by every Next/npm child and its workers.
// Deny dotenv content reads outside the owned application before opening them.
const fs=require("node:fs");
const fsp=require("node:fs/promises");
const path=require("node:path");
const {fileURLToPath}=require("node:url");
const {syncBuiltinESMExports}=require("node:module");
const app=path.resolve(process.env.ORCH_E2E_APP_DIR);
const append=fs.appendFileSync.bind(fs);
function check(input) {
  if(typeof input==="number")return;
  const file=input instanceof URL?fileURLToPath(input):Buffer.isBuffer(input)?input.toString():input;
  if(typeof file!=="string"||!/^\.env(?:\.|$)/.test(path.basename(file)))return;
  const absolute=path.resolve(file);
  let allowed=path.dirname(absolute)===app;
  if(allowed&&fs.existsSync(absolute))allowed=path.dirname(fs.realpathSync(absolute))===app;
  append(path.join(app,"dotenv-access.jsonl"),JSON.stringify({file:path.basename(absolute),allowed,pid:process.pid})+"\n");
  if(!allowed)throw new Error("E2E_DOTENV_OUTSIDE_SANDBOX");
}
for(const method of ["readFileSync","readFile","openSync","open","createReadStream"]) {
  const original=fs[method];fs[method]=function(file,...args){check(file);return original.call(this,file,...args);};
}
for(const method of ["readFile","open"]) {
  const original=fsp[method];fsp[method]=async function(file,...args){check(file);return original.call(this,file,...args);};
}
syncBuiltinESMExports();
// Runtime identity is independent of dotenv reads: missing instrumentation must
// produce an actionable failure even when a runtime bypasses NODE_OPTIONS.
const runtime={pid:process.pid,runtime:process.versions.bun?"bun":"node",version:process.versions.bun||process.versions.node};
globalThis[Symbol.for("tracework.e2e.dotenvGuard")]=runtime;
append(path.join(app,"guard-runtime.jsonl"),JSON.stringify(runtime)+"\n");
