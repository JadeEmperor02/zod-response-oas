/**
 * CORPUS: success response with no data field
 * EXPECT: typeTexts includes "undefined" → treated as {}
 * SHOULD: succeed
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

export function noData(req: Request, res: Response) {
  return sendSuccess(res, {
    message: "ok",
  });
}
