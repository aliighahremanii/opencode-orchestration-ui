import type { NextRequest } from "next/server";
import { authenticate, jsonOk, handleError } from "../../../lib/http/api.ts";
import { readWorkspaceCatalog } from "../../../lib/http/workspace.ts";
export function GET(request:NextRequest) { try {const {db}=authenticate(request);return jsonOk(readWorkspaceCatalog(db));} catch(e){return handleError(e);} }
