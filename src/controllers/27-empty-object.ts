/**
 * CORPUS: empty object data
 * EXPECT: {}
 * SHOULD: succeed
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

export function emptyObject(req: Request, res: Response) {
  return sendSuccess(res, {
    data: {},
  });
}
