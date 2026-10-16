import type { NextRequest } from "next/server";
import { authenticate, handleError, jsonOk } from "../../../lib/http/api.ts";
import { readOffice } from "../../../lib/http/office.ts";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const { db } = authenticate(request);
    return jsonOk(readOffice(db));
  } catch (cause) {
    return handleError(cause);
  }
}
