/**
 * CORPUS: simple object literal
 * EXPECT: extract { id: string; name: string }
 * SHOULD: succeed
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

export function simple(req: Request, res: Response) {
  return sendSuccess(res, {
    data: {
      id: "123",
      name: "Jade",
    },
  });
}
