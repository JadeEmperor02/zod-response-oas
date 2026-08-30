/**
 * CORPUS: computed property key in the data object
 * EXPECT: type text may include index signature or be incomplete;
 *         philosophy: if not confident, report — do not invent keys
 * SHOULD: prefer warning / partial over confident wrong schema
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

export function failComputedKey(req: Request, res: Response) {
  const key = "dynamic";
  return sendSuccess(res, {
    data: {
      id: "1",
      [key]: "value",
    },
  });
}
