/**
 * CORPUS: as const / literal types
 * EXPECT: extract narrow literals where possible, e.g. { status: "ok" }
 * SHOULD: succeed; prefer literal over widened string if type system preserves it
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

export function asConstLiteral(req: Request, res: Response) {
  return sendSuccess(res, {
    data: {
      status: "ok" as const,
      code: 200 as const,
    },
  });
}
