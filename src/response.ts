import type { Response } from "express";
import z from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

// this module calls `.openapi()`
// at the top level (zErrorResponse, below), and ES module imports are
// fully evaluated before the importing module's own body runs. If only
// router.ts called extendZodWithOpenApi, this file's top-level `.openapi()`
// call would execute first (during router.ts's import of this module) and
// throw, since the prototype extension wouldn't exist yet. Calling it here
// too is idempotent and removes the ordering dependency entirely.
extendZodWithOpenApi(z);

export interface SendSuccessOptions<T = any> {
  data?: T;
  message?: string;
  others?: Record<string, any>;
  statusCode?: number;
}

export interface SendErrorOptions {
  statusCode?: number;
  errors?: any;
}

export const sendSuccess = <T = any>(
  res: Response,
  options: SendSuccessOptions<T> = {},
) => {
  const { data, message, others = {}, statusCode = 200 } = options;
  return res.status(statusCode).json({
    ok: true,
    success: true,
    ...(message && { message }),
    data,
    ...others,
  });
};

export const sendError = (
  res: Response,
  msg: string,
  options: SendErrorOptions = {},
) => {
  const { statusCode = 400, errors } = options;
  return res.status(statusCode).json({
    ok: false,
    success: false,
    msg,
    ...(errors && { errors }),
  });
};

export function zSuccessResponse<T extends z.ZodType>(
  dataSchema?: T,
  explicitOthers?: Record<string, z.ZodType>,
) {
  const baseSchema = z.object({
    success: z.literal(true),
    ok: z.literal(true),
    message: z.string().optional(),
    data: dataSchema || z.any(),
    ...explicitOthers,
  });
  return baseSchema.catchall(z.any());
}

export const zErrorResponse = z.object({
  ok: z.literal(false),
  success: z.literal(false),
  msg: z.string(),
  errors: z
    .any()
    .openapi({ description: "Structured error tree or flat mapping object" }),
});
