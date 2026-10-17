import type { NextRequest } from "next/server";
import { authenticate, jsonOk, handleError } from "../../../../lib/http/api.ts";
import { readRunGraph } from "../../../../lib/http/workspace.ts";
export function GET(request:NextRequest) { try {const {db}=authenticate(request);const q=request.nextUrl.searchParams;return jsonOk(readRunGraph(db,q.get("project")??"",q.get("run")??"",q.get("workspace")));} catch(e){return handleError(e);} }
