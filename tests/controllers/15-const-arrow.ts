/**
 * CORPUS: export const handler = (req, res) => ...  (arrow assigned to const)
 * EXPECT: extractor must pick up the VariableDeclaration name, not lose it
 * SHOULD: succeed; handler name = "constArrow"
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../../src/response.js";

export const constArrow = (req: Request, res: Response) => {
  return sendSuccess(res, {
    data: {
      mode: "arrow",
      ok: true,
    },
  });
};
