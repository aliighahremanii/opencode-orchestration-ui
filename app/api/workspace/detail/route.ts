import type { NextRequest } from "next/server";
import { authenticate, jsonOk, handleError } from "../../../../lib/http/api.ts";
import { readAssignmentDetail } from "../../../../lib/http/workspace.ts";
export function GET(request:NextRequest) { try {const {db}=authenticate(request);const q=request.nextUrl.searchParams;return jsonOk(readAssignmentDetail(db,q.get("project")??"",q.get("run")??"",q.get("assignment")??"",q.get("cursor"),q.get("kind")==="conversation"?"conversation":"activity"));} catch(e){return handleError(e);} }
