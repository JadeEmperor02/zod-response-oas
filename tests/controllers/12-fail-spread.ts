/**
 * CORPUS: spread in the options object
 * EXPECT: warning — "options object contains a spread, can't confidently determine the data shape"
 * SHOULD: fail loudly (continue / skip shape), never guess
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../../src/response.js";

const responseOptions = {
  data: { id: "1", name: "Jade" },
  message: "ok",
};

export function failSpread(req: Request, res: Response) {
  return sendSuccess(res, {
    ...responseOptions,
  });
}
