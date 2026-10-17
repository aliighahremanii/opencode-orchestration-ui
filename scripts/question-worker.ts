import { ensureDatabaseReady } from "../lib/db/index.ts";
import { recoverQuestionJobs } from "../lib/db/questions.ts";
import { QUESTION_CAPABILITY } from "../lib/questions/capability.ts";

// Dedicated process boundary. No upstream mutation adapter is shipped until
// actual enforcement, correlation and publication isolation are verified.
const db=ensureDatabaseReady();
recoverQuestionJobs(db);
console.log(`[question-worker] ${QUESTION_CAPABILITY.reason}`);
if(!process.argv.includes("--once")) {
  const timer=setInterval(()=>recoverQuestionJobs(db),30_000);
  const stop=()=>{clearInterval(timer);db.close();process.exit(0);};
  process.on("SIGTERM",stop);process.on("SIGINT",stop);
} else db.close();
