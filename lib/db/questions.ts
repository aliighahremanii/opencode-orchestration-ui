import { createHash, randomUUID } from "node:crypto";
import { execute, immediateTransaction, queryOne, type Db } from "./driver.ts";
import { redactPersistedField } from "../util/redact.ts";
import { QUESTION_CAPABILITY } from "../questions/capability.ts";

export class QuestionError extends Error { readonly status:number; constructor(status:number,message:string){super(message);this.status=status;} }
export interface QuestionJob { id:string; assignmentId:string; state:string; reason:string|null }
interface JobRow {id:string;assignment_id:string;state:string;reason:string|null;request_hash:string}
function dto(r:JobRow):QuestionJob{return {id:r.id,assignmentId:r.assignment_id,state:r.state,reason:r.reason};}

/** No network inside the transaction. A repeated key must have exactly the same request. */
export function recordQuestion(db:Db,ownerId:string,input:{assignmentId:string;question:string;requestKey:string},now=Date.now()):QuestionJob {
  if(!/^[A-Za-z0-9_-]{16,100}$/.test(input.requestKey)||!input.question.trim()||input.question.length>4000||input.assignmentId.length>200)
    throw new QuestionError(400,"Invalid question, assignment, or idempotency key.");
  const hash=createHash("sha256").update(JSON.stringify([input.assignmentId,input.question])).digest("hex");
  return immediateTransaction(db,()=>{
    const existing=queryOne<JobRow>(db,"SELECT * FROM question_jobs WHERE owner_id=? AND request_key=?",[ownerId,input.requestKey]);
    if(existing){if(existing.request_hash!==hash)throw new QuestionError(409,"Idempotency key belongs to a different question.");return dto(existing);}
    if(!queryOne(db,`SELECT a.id FROM observed_assignments a JOIN sessions s ON s.id=a.session_id
      WHERE a.id=? AND NOT EXISTS(SELECT 1 FROM investigation_sessions i WHERE i.session_id=s.id)`,[input.assignmentId]))
      throw new QuestionError(404,"Source assignment is unavailable.");
    const recent=queryOne<{n:number}>(db,"SELECT COUNT(*) AS n FROM question_jobs WHERE owner_id=? AND created_at>?",[ownerId,now-60_000])?.n ?? 0;
    if(recent>=5)throw new QuestionError(429,"Question limit reached. Try again later.");
    // Terminal rejection is durable and idempotent. Never queue work that cannot safely execute.
    const id=`question_${randomUUID()}`;
    execute(db,"INSERT INTO question_jobs VALUES(?,?,?,?,?,?,?,?,?,?)",[id,ownerId,input.requestKey,hash,input.assignmentId,redactPersistedField(input.question),"blocked",now,now,QUESTION_CAPABILITY.reason]);
    return {id,assignmentId:input.assignmentId,state:"blocked",reason:QUESTION_CAPABILITY.reason};
  });
}

/** Fail closed after restart. An in-flight mutation is never blindly retried. */
export function recoverQuestionJobs(db:Db,now=Date.now()):void {
  immediateTransaction(db,()=>{
    execute(db,"UPDATE question_jobs SET state='ambiguous',reason='Interrupted operation: upstream outcome is unknown; automatic retry forbidden.',updated_at=? WHERE state IN ('creating','sending')",[now]);
    execute(db,"UPDATE question_jobs SET state='blocked',reason=?,updated_at=? WHERE state='queued'",[QUESTION_CAPABILITY.reason,now]);
    execute(db,"DELETE FROM question_jobs WHERE created_at<? AND state IN ('blocked','completed') AND NOT EXISTS(SELECT 1 FROM investigation_sessions i WHERE i.job_id=question_jobs.id)",[now-30*24*60*60*1000]);
  });
}
