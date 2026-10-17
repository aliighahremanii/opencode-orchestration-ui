import type { NextRequest } from "next/server";
import { authenticate, ApiError, jsonOk, handleError } from "../../../lib/http/api.ts";
import { recordQuestion, QuestionError } from "../../../lib/db/questions.ts";
export async function POST(request:NextRequest) {
  try {
    const {db}=authenticate(request);
    if(!request.headers.get("content-type")?.startsWith("application/json"))throw new ApiError(415,"invalid-content-type","JSON required.");
    const reader=request.body?.getReader();let text="";let bytes=0;const decoder=new TextDecoder();
    if(reader)for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>18000){await reader.cancel();throw new ApiError(413,"too-large","Question body too large.");}text+=decoder.decode(part.value,{stream:true});}
    let input:unknown;try{input=JSON.parse(text+decoder.decode());}catch{throw new ApiError(400,"invalid-json","Invalid JSON.");}
    if(!input||typeof input!=="object"||Object.keys(input).some(k=>!["assignmentId","question","requestKey"].includes(k))||!("assignmentId" in input)||!("question" in input)||!("requestKey" in input)||typeof input.assignmentId!=="string"||typeof input.question!=="string"||typeof input.requestKey!=="string")throw new ApiError(400,"invalid-question","Only assignmentId, question and requestKey are accepted.");
    const job=recordQuestion(db,"owner",input as {assignmentId:string;question:string;requestKey:string});
    return jsonOk(job,{status:503});
  } catch(e){if(e instanceof QuestionError)return handleError(new ApiError(e.status,"question-rejected",e.message));return handleError(e);}
}
