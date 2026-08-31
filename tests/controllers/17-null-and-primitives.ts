/**
 * CORPUS: data is a primitive / null / boolean
 * EXPECT: extract null | number | boolean | string as appropriate
 * SHOULD: succeed (primitives are representable in Zod)
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../../src/response.js";

export function primitiveNumber(req: Request, res: Response) {
  return sendSuccess(res, {
    data: 42,
  });
}

export function primitiveString(req: Request, res: Response) {
  return sendSuccess(res, {
    data: "hello",
  });
}

export function primitiveBoolean(req: Request, res: Response) {
  return sendSuccess(res, {
    data: true,
  });
}

export function primitiveNull(req: Request, res: Response) {
  return sendSuccess(res, {
    data: null,
  });
}
