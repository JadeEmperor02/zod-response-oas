/**
 * CORPUS: array of object literals
 * EXPECT: extract { id: string; name: string }[]
 * SHOULD: succeed
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

export function list(req: Request, res: Response) {
  const users = [
    { id: "1", name: "A" },
    { id: "2", name: "B" },
  ];

  return sendSuccess(res, {
    data: users,
  });
}
