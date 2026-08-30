/**
 * CORPUS: generic type parameter in the data expression
 * EXPECT: ts-to-zod likely fails (generics unsupported) — CLI should surface which handler failed
 * SHOULD: fail loudly, not emit any / z.any()
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

function genericResult<T>(): T {
  return {} as T;
}

export function failGeneric(req: Request, res: Response) {
  return sendSuccess(res, {
    data: genericResult<{ id: string; value: number }>(),
  });
}
