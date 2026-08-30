/**
 * CORPUS: raw Mongoose HydratedDocument-like type without .toObject()/.toJSON()
 * EXPECT: warning about leaking internal fields; shape still extracted if possible
 * SHOULD: warn, not silently convert
 *
 * Note: we approximate the type name string the extractor looks for.
 */
import type { Request, Response } from "express";
import { sendSuccess } from "../index.js";

// Minimal stand-in so the type text contains "HydratedDocument"
interface HydratedDocument<T> {
  _id: string;
  __v: number;
  toObject(): T;
  toJSON(): T;
}

type UserDoc = HydratedDocument<{ name: string; email: string }>;

declare function findUser(): UserDoc;

export function mongooseRawDoc(req: Request, res: Response) {
  const doc = findUser();
  return sendSuccess(res, {
    data: doc,
  });
}

export function mongooseNormalized(req: Request, res: Response) {
  const doc = findUser();
  return sendSuccess(res, {
    data: doc.toObject(),
  });
}
