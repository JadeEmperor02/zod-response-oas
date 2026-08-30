/**
 * CORPUS: nested optional + nullable
 * EXPECT: { profile?: { bio: string | null } | null }
 * SHOULD: succeed
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

export function nestedOptionalNullable(req: Request, res: Response) {
  const payload: {
    profile?: { bio: string | null } | null;
  } = {};

  return sendSuccess(res, {
    data: payload,
  });
}
