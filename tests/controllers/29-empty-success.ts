/**
 * CORPUS: empty success call
 * EXPECT: null
 * SHOULD: be response kind
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../../src/response.js";

export function emptySuccess(req: Request, res: Response) {
  return sendSuccess(res, {});
}
