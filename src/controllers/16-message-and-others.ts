/**
 * CORPUS: data + message + others fields
 * EXPECT: only the `data` shape is extracted; message/others are envelope, not payload schema
 * SHOULD: succeed with data shape { count: number }
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

export function messageAndOthers(req: Request, res: Response) {
  return sendSuccess(res, {
    data: { count: 42 },
    message: "counted",
    others: { requestId: "abc-123" },
  });
}
