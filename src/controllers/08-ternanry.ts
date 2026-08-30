/**
 * CORPUS: ternary expression producing two distinct shapes
 * EXPECT: extract union of the two branches
 *   { role: "admin"; permissions: string[] } | { role: "user"; permissions: string[] }
 * SHOULD: succeed (type of ternary is the union of both arms)
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

export function ternary(req: Request, res: Response) {
  const isAdmin = req.query.admin === "true";

  return sendSuccess(res, {
    data: isAdmin
      ? { role: "admin" as const, permissions: ["read", "write"] }
      : { role: "user" as const, permissions: ["read"] },
  });
}
