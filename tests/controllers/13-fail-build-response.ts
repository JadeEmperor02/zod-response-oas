/**
 * CORPUS: entire second argument is a function call (not an object literal)
 * EXPECT: warning — "second argument isn't an object literal, can't extract data shape"
 * SHOULD: fail loudly
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../../src/response.js";

function buildResponse() {
  return { data: { id: "1" }, message: "built" };
}

export function failBuildResponse(req: Request, res: Response) {
  return sendSuccess(res, buildResponse());
}
