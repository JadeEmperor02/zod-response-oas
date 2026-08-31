/**
 * CORPUS: optional properties via inline type annotation
 * EXPECT: extract { id: string; name?: string }
 * SHOULD: succeed
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../../src/response.js";

function getUser(): { id: string; name?: string } {
  return { id: "1" };
}

export function optionalProps(req: Request, res: Response) {
  const user: {
    id: string;
    name?: string;
  } = getUser();

  return sendSuccess(res, {
    data: user,
  });
}
