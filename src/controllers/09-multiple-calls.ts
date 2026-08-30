/**
 * CORPUS: multiple sendSuccess calls with different data shapes (branching)
 * EXPECT: typeTexts = ["{ status: string }", "{ status: string; result: string }"]
 *         → generated as z.union([...])
 * SHOULD: succeed; both shapes retained, not collapsed
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

export function multipleCalls(req: Request, res: Response) {
  if (req.query.pending) {
    return sendSuccess(res, {
      data: { status: "pending" },
    });
  }

  return sendSuccess(res, {
    data: { status: "complete", result: "done" },
  });
}
