/**
 * CORPUS: discriminated / plain union type
 * EXPECT: extract { type: "user"; userId: string } | { type: "error"; reason: string }
 * SHOULD: succeed (ts-to-zod supports unions)
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

type Result =
  | { type: "user"; userId: string }
  | { type: "error"; reason: string };

function getResult(): Result {
  return { type: "user", userId: "abc" };
}

export function unions(req: Request, res: Response) {
  const data: Result = getResult();

  return sendSuccess(res, { data });
}
