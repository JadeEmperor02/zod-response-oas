/**
 * CORPUS: Record / index signature
 * EXPECT: Record<string, number> or { [key: string]: number }
 * SHOULD: succeed if ts-to-zod supports index signatures; otherwise surface failure
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../../src/response.js";

export function recordIndex(req: Request, res: Response) {
  const scores: Record<string, number> = {
    alice: 10,
    bob: 20,
  };

  return sendSuccess(res, {
    data: scores,
  });
}
