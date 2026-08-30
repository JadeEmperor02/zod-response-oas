/**
 * CORPUS: opaque variable (no local type annotation, result of unknown call)
 * EXPECT: warning or unresolvable / any-ish type text
 * SHOULD: fail loudly or report uncertainty — NOT invent a schema
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

declare function someComputedThing(): unknown;

export function failComputedVariable(req: Request, res: Response) {
  return sendSuccess(res, {
    data: someComputedThing(),
  });
}
