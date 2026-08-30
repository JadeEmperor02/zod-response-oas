/**
 * CORPUS: nested object literal
 * EXPECT: extract { user: { id: string; profile: { name: string; age: number } } }
 * SHOULD: succeed
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

export function nested(req: Request, res: Response) {
  return sendSuccess(res, {
    data: {
      user: {
        id: "123",
        profile: {
          name: "Jade",
          age: 30,
        },
      },
    },
  });
}
