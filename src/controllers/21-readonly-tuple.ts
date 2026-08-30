/**
 * CORPUS: readonly tuple
 * EXPECT: readonly [string, number] or [string, number]
 * SHOULD: succeed or surface if ts-to-zod chokes on readonly/tuple
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

export function readonlyTuple(req: Request, res: Response) {
  const pair: readonly [string, number] = ["Jade", 30];

  return sendSuccess(res, {
    data: pair,
  });
}
